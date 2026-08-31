import datetime
import asyncio
import csv
import io
import os
import re
import uuid
import zipfile
from typing import Optional, List

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session
from sqlalchemy import or_, func, text

from database import Base, engine, get_db, SessionLocal, DATA_DIR
from models import Book, ReadEntry, ReadStatus, Tag
from isbn_lookup import lookup_isbn, clean_isbn
from csv_import import parse_rows, map_row, map_backup_row

COVERS_DIR = os.path.join(DATA_DIR, "covers")
os.makedirs(COVERS_DIR, exist_ok=True)
ALLOWED_COVER_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
MAX_COVER_BYTES = 12 * 1024 * 1024  # 12 MB

Base.metadata.create_all(bind=engine)


def get_or_create_tags(db: Session, names: List[str]) -> List[Tag]:
    """Case-insensitive get-or-create for a list of raw tag name strings."""
    tags: List[Tag] = []
    seen = set()
    for raw in names:
        name = (raw or "").strip()
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        tag = db.query(Tag).filter(func.lower(Tag.name) == name.lower()).first()
        if not tag:
            tag = Tag(name=name)
            db.add(tag)
            db.flush()
        tags.append(tag)
    return tags


def _run_migrations():
    """Lightweight, additive migrations for upgrades of an existing SQLite
    file — create_all only creates missing tables, not missing columns."""
    with engine.connect() as conn:
        existing_cols = {row[1] for row in conn.execute(text("PRAGMA table_info(books)"))}
        if "location" not in existing_cols:
            conn.execute(text("ALTER TABLE books ADD COLUMN location VARCHAR(200)"))
            conn.commit()
        if "series" not in existing_cols:
            conn.execute(text("ALTER TABLE books ADD COLUMN series VARCHAR(200)"))
            conn.commit()

        # older installs created `status` as a SQLAlchemy Enum column, which
        # bakes a CHECK constraint listing the allowed values into the table
        # itself — that blocks inserting any new status value (like
        # "planning") until the constraint is gone. SQLite can't drop/alter a
        # CHECK constraint in place, so rebuild the table without it.
        row = conn.execute(text("SELECT sql FROM sqlite_master WHERE type='table' AND name='books'")).fetchone()
        if row and row[0] and "CHECK" in row[0] and "planning" not in row[0]:
            conn.execute(text("ALTER TABLE books RENAME TO books_old"))
            conn.execute(text("""
                CREATE TABLE books (
                    id INTEGER NOT NULL PRIMARY KEY,
                    isbn VARCHAR(20),
                    title VARCHAR(500) NOT NULL,
                    authors VARCHAR(500),
                    publisher VARCHAR(300),
                    published_date VARCHAR(50),
                    page_count INTEGER,
                    description TEXT,
                    cover_url VARCHAR(500),
                    genre VARCHAR(200),
                    location VARCHAR(200),
                    series VARCHAR(200),
                    owned BOOLEAN,
                    status VARCHAR(20),
                    date_started DATE,
                    date_finished DATE,
                    rating INTEGER,
                    added_at DATETIME
                )
            """))
            conn.execute(text("""
                INSERT INTO books (id, isbn, title, authors, publisher, published_date,
                    page_count, description, cover_url, genre, location, series, owned, status,
                    date_started, date_finished, rating, added_at)
                SELECT id, isbn, title, authors, publisher, published_date,
                    page_count, description, cover_url, genre, location, series, owned, status,
                    date_started, date_finished, rating, added_at
                FROM books_old
            """))
            conn.execute(text("DROP TABLE books_old"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_books_isbn ON books (isbn)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_books_location ON books (location)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_books_series ON books (series)"))
            conn.commit()

    # one-time migration: split the legacy comma-separated `genre` field into
    # proper Tag rows, for any book that doesn't already have tags
    db = SessionLocal()
    try:
        legacy = db.query(Book).filter(Book.genre.isnot(None), Book.genre != "").all()
        for b in legacy:
            if b.tags:
                continue
            names = [n.strip() for n in b.genre.replace(";", ",").split(",") if n.strip()]
            if names:
                b.tags = get_or_create_tags(db, names)
        db.commit()
    finally:
        db.close()

    # one-time migration: fold each book's old single date_started/
    # date_finished/rating (and, if present, the legacy 1:1 "reviews"
    # table's text) into one ReadEntry, now that read history is tracked as
    # a proper list of read-throughs rather than single fields on the book.
    # Only touches books with zero read_entries, so it's safe to run every
    # startup without duplicating data once migrated.
    db = SessionLocal()
    try:
        old_reviews_by_book = {}
        try:
            rows = db.execute(text("SELECT book_id, review_text, contains_spoilers FROM reviews")).fetchall()
            for book_id, review_text, contains_spoilers in rows:
                old_reviews_by_book[book_id] = (review_text or "", bool(contains_spoilers))
        except Exception:
            pass  # no legacy `reviews` table — fine on a fresh install

        for b in db.query(Book).all():
            if b.read_entries:
                continue
            review_text, contains_spoilers = old_reviews_by_book.get(b.id, ("", False))
            if b.date_started or b.date_finished or b.rating or review_text:
                db.add(ReadEntry(
                    book_id=b.id,
                    date_started=b.date_started,
                    date_finished=b.date_finished,
                    rating=b.rating,
                    review_text=review_text,
                    contains_spoilers=contains_spoilers,
                ))
        db.commit()
    finally:
        db.close()


_run_migrations()

app = FastAPI(title="Book Tracker")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Schemas ----------

def _validate_rating(v):
    """Ratings are in half-star increments from 0.5 to 5 (e.g. 3, 3.5, 4)."""
    if v is None:
        return v
    if not (0.5 <= v <= 5):
        raise ValueError("rating must be between 0.5 and 5")
    if abs((v * 2) - round(v * 2)) > 1e-6:
        raise ValueError("rating must be in half-star increments (e.g. 3, 3.5, 4)")
    return round(v * 2) / 2


class BookIn(BaseModel):
    isbn: Optional[str] = None
    title: str
    authors: Optional[str] = None
    publisher: Optional[str] = None
    published_date: Optional[str] = None
    page_count: Optional[int] = None
    description: Optional[str] = None
    cover_url: Optional[str] = None
    genre: Optional[str] = None
    location: Optional[str] = None
    series: Optional[str] = None
    owned: bool = True
    status: ReadStatus = ReadStatus.unread
    date_started: Optional[datetime.date] = None
    date_finished: Optional[datetime.date] = None
    rating: Optional[float] = None
    tags: Optional[List[str]] = None

    @field_validator("rating")
    @classmethod
    def rating_range(cls, v):
        return _validate_rating(v)


class BookUpdate(BaseModel):
    title: Optional[str] = None
    authors: Optional[str] = None
    publisher: Optional[str] = None
    published_date: Optional[str] = None
    page_count: Optional[int] = None
    description: Optional[str] = None
    cover_url: Optional[str] = None
    genre: Optional[str] = None
    location: Optional[str] = None
    series: Optional[str] = None
    owned: Optional[bool] = None
    status: Optional[ReadStatus] = None
    date_started: Optional[datetime.date] = None
    date_finished: Optional[datetime.date] = None
    rating: Optional[float] = None
    tags: Optional[List[str]] = None

    @field_validator("rating")
    @classmethod
    def rating_range(cls, v):
        return _validate_rating(v)


class ReadEntryIn(BaseModel):
    date_started: Optional[datetime.date] = None
    date_finished: Optional[datetime.date] = None
    rating: Optional[float] = None
    review_text: str = ""
    contains_spoilers: bool = False

    @field_validator("rating")
    @classmethod
    def rating_range(cls, v):
        return _validate_rating(v)


class ReadEntryUpdate(BaseModel):
    date_started: Optional[datetime.date] = None
    date_finished: Optional[datetime.date] = None
    rating: Optional[float] = None
    review_text: Optional[str] = None
    contains_spoilers: Optional[bool] = None

    @field_validator("rating")
    @classmethod
    def rating_range(cls, v):
        return _validate_rating(v)


class ImportRequest(BaseModel):
    isbns: List[str]


class BulkLocationRequest(BaseModel):
    book_ids: List[int]
    location: Optional[str] = None


# ---------- Book routes ----------

@app.get("/api/books")
def list_books(
    status: Optional[str] = None,
    owned: Optional[bool] = None,
    search: Optional[str] = None,
    tag: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Book)
    if status:
        q = q.filter(Book.status == status)
    if owned is not None:
        q = q.filter(Book.owned == owned)
    if search:
        like = f"%{search}%"
        q = q.filter(or_(Book.title.ilike(like), Book.authors.ilike(like)))
    if tag:
        q = q.join(Book.tags).filter(func.lower(Tag.name) == tag.lower())
    books = q.order_by(Book.title).all()
    return [book_to_dict(b) for b in books]


@app.get("/api/stats")
def stats(db: Session = Depends(get_db)):
    total = db.query(Book).count()
    owned = db.query(Book).filter(Book.owned == True).count()  # noqa: E712
    read = db.query(Book).filter(Book.status == ReadStatus.read).count()
    reading = db.query(Book).filter(Book.status == ReadStatus.reading).count()
    unread = db.query(Book).filter(Book.status == ReadStatus.unread).count()
    return {
        "total": total,
        "owned": owned,
        "read": read,
        "reading": reading,
        "unread": unread,
    }


@app.get("/api/locations")
def list_locations(db: Session = Depends(get_db)):
    rows = (
        db.query(Book.location)
        .filter(Book.location.isnot(None), Book.location != "")
        .distinct()
        .order_by(Book.location)
        .all()
    )
    return [r[0] for r in rows]


@app.get("/api/series")
def list_series(db: Session = Depends(get_db)):
    rows = (
        db.query(Book.series)
        .filter(Book.series.isnot(None), Book.series != "")
        .distinct()
        .order_by(Book.series)
        .all()
    )
    return [r[0] for r in rows]


@app.get("/api/tags")
def list_tags(db: Session = Depends(get_db)):
    tags = db.query(Tag).order_by(Tag.name).all()
    return [t.name for t in tags]


@app.post("/api/books/bulk-location")
def bulk_set_location(payload: BulkLocationRequest, db: Session = Depends(get_db)):
    if not payload.book_ids:
        raise HTTPException(400, "No books selected")
    updated = (
        db.query(Book)
        .filter(Book.id.in_(payload.book_ids))
        .update({Book.location: payload.location}, synchronize_session=False)
    )
    db.commit()
    return {"updated": updated}


@app.get("/api/books/lookup/{isbn}")
async def lookup(isbn: str):
    result = await lookup_isbn(isbn)
    if not result:
        raise HTTPException(404, "No metadata found for that ISBN")
    return result


def _validate_status_date_consistency(status_value, date_finished_value):
    """A book with a 'last finished' date can't be marked Unread — but every
    other status is fine, since someone might be re-reading a book they've
    finished before (status moves to Reading/Planning while the old finish
    date is kept as history until the re-read wraps up)."""
    if date_finished_value and status_value == ReadStatus.unread.value:
        raise HTTPException(
            400,
            "A book with a 'last finished' date can't be marked Unread. "
            "Choose Reading, Planning to Read, Read, or Did Not Finish instead "
            "— handy if you're re-reading it.",
        )


@app.post("/api/books")
def create_book(payload: BookIn, db: Session = Depends(get_db)):
    data = payload.model_dump()
    tag_names = data.pop("tags", None) or []
    _validate_status_date_consistency(data.get("status"), data.get("date_finished"))
    book = Book(**data)
    db.add(book)
    db.flush()
    book.tags = get_or_create_tags(db, tag_names)
    db.commit()
    db.refresh(book)
    return book_to_dict(book)


@app.get("/api/books/{book_id}")
def get_book(book_id: int, db: Session = Depends(get_db)):
    book = db.query(Book).get(book_id)
    if not book:
        raise HTTPException(404, "Book not found")
    return book_to_dict(book)


@app.put("/api/books/{book_id}")
def update_book(book_id: int, payload: BookUpdate, db: Session = Depends(get_db)):
    book = db.query(Book).get(book_id)
    if not book:
        raise HTTPException(404, "Book not found")
    data = payload.model_dump(exclude_unset=True)
    tag_names = data.pop("tags", None)

    # validate against the RESULTING state (existing values merged with this
    # partial update), since either field alone might not have changed
    resulting_status = data.get("status", book.status)
    resulting_date_finished = data.get("date_finished", book.date_finished)
    _validate_status_date_consistency(resulting_status, resulting_date_finished)

    if "cover_url" in data and data["cover_url"] != book.cover_url:
        _delete_cover_file(book.cover_url)
    for field, value in data.items():
        setattr(book, field, value)
    if tag_names is not None:
        book.tags = get_or_create_tags(db, tag_names)
    db.commit()
    db.refresh(book)
    return book_to_dict(book)


@app.delete("/api/books/{book_id}")
def delete_book(book_id: int, db: Session = Depends(get_db)):
    book = db.query(Book).get(book_id)
    if not book:
        raise HTTPException(404, "Book not found")
    _delete_cover_file(book.cover_url)
    db.delete(book)
    db.commit()
    return {"deleted": True}


def _delete_cover_file(cover_url: Optional[str]):
    """Best-effort cleanup of a locally-uploaded cover file. No-op for
    external URLs (Open Library / Google Books covers, etc.)."""
    if not cover_url or not cover_url.startswith("/covers/"):
        return
    path = os.path.join(COVERS_DIR, os.path.basename(cover_url))
    try:
        if os.path.isfile(path):
            os.remove(path)
    except OSError:
        pass


@app.post("/api/books/{book_id}/cover")
async def upload_cover(book_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    book = db.query(Book).get(book_id)
    if not book:
        raise HTTPException(404, "Book not found")

    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_COVER_EXT:
        raise HTTPException(400, "Unsupported image type — use JPG, PNG, WEBP, or GIF")

    contents = await file.read()
    if len(contents) > MAX_COVER_BYTES:
        raise HTTPException(400, f"Image too large — max {MAX_COVER_BYTES // (1024 * 1024)} MB")

    filename = f"book-{book_id}-{uuid.uuid4().hex[:8]}{ext}"
    dest_path = os.path.join(COVERS_DIR, filename)
    with open(dest_path, "wb") as out:
        out.write(contents)

    _delete_cover_file(book.cover_url)
    book.cover_url = f"/covers/{filename}"
    db.commit()
    db.refresh(book)
    return book_to_dict(book)


@app.delete("/api/books/{book_id}/cover")
def remove_cover(book_id: int, db: Session = Depends(get_db)):
    book = db.query(Book).get(book_id)
    if not book:
        raise HTTPException(404, "Book not found")
    _delete_cover_file(book.cover_url)
    book.cover_url = None
    db.commit()
    db.refresh(book)
    return book_to_dict(book)


# ---------- Read entry routes ----------
# One row per read-through of a book: its own dates, rating, and review, so
# re-reading a book keeps every earlier read (and its review/rating) intact
# instead of overwriting it. Book.date_started/date_finished/rating stay in
# sync as a "most recent read" cache via _recompute_read_cache below, so
# list views and the plain CSV export can keep showing a summary without a
# join — but read_entries is the actual source of truth for history.

def _recompute_read_cache(book: Book):
    """Sync Book.date_started/date_finished/rating from its read_entries. An
    in-progress read (has a start date but no finish date yet) counts as
    "current" and takes priority; otherwise the most recently finished read
    wins. Also re-applies the "can't be Unread with a finish date" rule,
    since a newly added/edited read entry can change that outcome."""
    entries = book.read_entries
    in_progress = [e for e in entries if e.date_started and not e.date_finished]
    latest = None
    if in_progress:
        latest = sorted(in_progress, key=lambda e: (e.date_started, e.id))[-1]
    else:
        finished = [e for e in entries if e.date_finished]
        if finished:
            latest = sorted(finished, key=lambda e: (e.date_finished, e.id))[-1]

    if latest:
        book.date_started = latest.date_started
        book.date_finished = latest.date_finished
        book.rating = latest.rating
    else:
        book.date_started = None
        book.date_finished = None
        book.rating = None

    if book.date_finished and book.status == ReadStatus.unread.value:
        book.status = ReadStatus.read.value


@app.get("/api/books/{book_id}/read-entries")
def list_read_entries(book_id: int, db: Session = Depends(get_db)):
    book = db.query(Book).get(book_id)
    if not book:
        raise HTTPException(404, "Book not found")
    entries = sorted(book.read_entries, key=lambda e: (e.date_started or datetime.date.min, e.id))
    return [read_entry_to_dict(e) for e in entries]


@app.post("/api/books/{book_id}/read-entries")
def create_read_entry(book_id: int, payload: ReadEntryIn, db: Session = Depends(get_db)):
    book = db.query(Book).get(book_id)
    if not book:
        raise HTTPException(404, "Book not found")
    entry = ReadEntry(book_id=book_id, **payload.model_dump())
    db.add(entry)
    db.flush()
    db.refresh(book)
    _recompute_read_cache(book)
    db.commit()
    db.refresh(entry)
    return read_entry_to_dict(entry)


@app.put("/api/read-entries/{entry_id}")
def update_read_entry(entry_id: int, payload: ReadEntryUpdate, db: Session = Depends(get_db)):
    entry = db.query(ReadEntry).get(entry_id)
    if not entry:
        raise HTTPException(404, "Read entry not found")
    data = payload.model_dump(exclude_unset=True)
    for key, value in data.items():
        setattr(entry, key, value)
    entry.updated_at = datetime.datetime.utcnow()
    db.flush()
    book = entry.book
    _recompute_read_cache(book)
    db.commit()
    db.refresh(entry)
    return read_entry_to_dict(entry)


@app.delete("/api/read-entries/{entry_id}")
def delete_read_entry(entry_id: int, db: Session = Depends(get_db)):
    entry = db.query(ReadEntry).get(entry_id)
    if not entry:
        raise HTTPException(404, "Read entry not found")
    book = entry.book
    db.delete(entry)
    db.flush()
    db.refresh(book)
    _recompute_read_cache(book)
    db.commit()
    return {"deleted": True}


@app.get("/api/reviews")
def list_reviews(db: Session = Depends(get_db)):
    entries = (
        db.query(ReadEntry)
        .filter(ReadEntry.review_text.isnot(None), ReadEntry.review_text != "")
        .order_by(ReadEntry.updated_at.desc())
        .all()
    )
    out = []
    for e in entries:
        d = read_entry_to_dict(e)
        d["book"] = book_to_dict(e.book)
        out.append(d)
    return out


# ---------- Bulk ISBN import ----------

@app.post("/api/import")
async def bulk_import(payload: ImportRequest, db: Session = Depends(get_db)):
    results = {"added": [], "duplicates": [], "not_found": [], "errors": []}
    seen_isbns = {b.isbn for b in db.query(Book.isbn).all() if b.isbn}

    for raw in payload.isbns:
        isbn = clean_isbn(raw)
        if not isbn:
            continue
        if isbn in seen_isbns:
            results["duplicates"].append(isbn)
            continue
        try:
            meta = await lookup_isbn(isbn)
        except Exception as exc:  # noqa: BLE001
            results["errors"].append({"isbn": isbn, "error": str(exc)})
            continue
        if not meta:
            results["not_found"].append(isbn)
            continue
        book = Book(
            isbn=meta["isbn"],
            title=meta["title"],
            authors=meta.get("authors"),
            publisher=meta.get("publisher"),
            published_date=meta.get("published_date"),
            page_count=meta.get("page_count"),
            description=meta.get("description"),
            cover_url=meta.get("cover_url"),
            series=meta.get("series"),
            owned=True,
            status=ReadStatus.unread,
        )
        db.add(book)
        db.flush()
        if meta.get("genre"):
            book.tags = get_or_create_tags(db, meta["genre"].split(","))
        db.commit()
        db.refresh(book)
        seen_isbns.add(isbn)
        results["added"].append(book_to_dict(book))
        # be polite to the free public APIs
        await asyncio.sleep(0.3)

    return results


def _looks_like_own_export(rows: list) -> bool:
    """Detect a CSV produced by this app's own Export (rather than a
    third-party tracker export) by checking for the ID + Status columns
    that are unique to our format."""
    if not rows:
        return False
    keys = {(k or "").strip().lower() for k in rows[0].keys()}
    return "id" in keys and "status" in keys


def _restore_backup_row(row: dict, db: Session, books_by_id: dict, books_by_isbn: dict,
                         title_groups: dict, zf=None) -> dict:
    """Apply one row from this app's own CSV/ZIP export format — the single
    source of truth for restoring a backup, shared by the ZIP restore and
    the CSV importer's own-format auto-detection, so both stay in sync.
    Returns {"kind": "added"|"updated"|"ambiguous"|"mismatched"|"skipped",
    "book": <dict>|None, "reason": <str>|None, "cover_restored": bool}."""
    fields = map_backup_row(row)
    review_text = fields.pop("_review_text", "")
    contains_spoilers = fields.pop("_contains_spoilers", False)
    cover_url_field = fields.pop("_cover_url", "")
    cover_file = fields.pop("_cover_file", "")
    source_id = fields.pop("_source_id", "")
    isbn_corrupted = fields.pop("_isbn_corrupted", False)
    status_corrected = fields.pop("_status_corrected", False)
    tag_names = fields.pop("tags", None)

    title = fields.get("title")
    isbn = fields.get("isbn")

    book = None
    if source_id and source_id.isdigit():
        book = books_by_id.get(int(source_id))
    if not book and isbn:
        book = books_by_isbn.get(isbn)
    if not book and title:
        candidates = title_groups.get(title.strip().lower(), [])
        if len(candidates) == 1:
            book = candidates[0]
        elif len(candidates) > 1:
            return {"kind": "ambiguous", "book": None,
                    "reason": f"{len(candidates)} books share this title", "cover_restored": False}

    if book and title and _normalize_title(title) != _normalize_title(book.title):
        return {
            "kind": "mismatched", "book": None,
            "reason": f'row matched "{book.title}" but its Title column says "{title}" — skipped, check this row',
            "cover_restored": False,
        }

    is_new = False
    if not book:
        if not title:
            return {"kind": "skipped", "book": None, "reason": "no title and no existing match", "cover_restored": False}
        book = Book(**fields)
        db.add(book)
        db.flush()
        is_new = True
    else:
        for key, value in fields.items():
            if key == "cover_url":
                continue
            setattr(book, key, value)

    if tag_names is not None:
        book.tags = get_or_create_tags(db, tag_names)

    # The flat CSV format only has one Review/Contains Spoilers column,
    # representing a single "latest read" snapshot (Date Started/Finished/
    # Rating, already applied to the book above, plus this review text). If
    # the book has no read history yet, capture that snapshot as its first
    # read entry; if it already has entries (e.g. from a fuller ZIP restore),
    # just refresh the most recent one's review text rather than overwriting
    # per-read dates we don't have better info about here.
    if review_text or book.date_finished or book.date_started or book.rating:
        existing_entries = list(book.read_entries)
        if not existing_entries:
            db.add(ReadEntry(
                book_id=book.id,
                date_started=book.date_started,
                date_finished=book.date_finished,
                rating=book.rating,
                review_text=review_text,
                contains_spoilers=contains_spoilers,
            ))
        elif review_text:
            latest = sorted(existing_entries, key=lambda e: (e.date_finished or e.date_started or datetime.date.min, e.id))[-1]
            latest.review_text = review_text
            latest.contains_spoilers = contains_spoilers
            latest.updated_at = datetime.datetime.utcnow()

    # restore the cover: prefer a bundled image file (zip restore only),
    # else fall back to a stored URL (harmless no-op for external URLs)
    cover_restored = False
    if cover_file and zf is not None:
        ext = os.path.splitext(cover_file)[1].lower()
        arcpath = f"covers/{cover_file}"
        if ext in ALLOWED_COVER_EXT and arcpath in zf.namelist():
            data = zf.read(arcpath)
            new_filename = f"book-{book.id}-{uuid.uuid4().hex[:8]}{ext}"
            dest_path = os.path.join(COVERS_DIR, new_filename)
            with open(dest_path, "wb") as out:
                out.write(data)
            _delete_cover_file(book.cover_url)
            book.cover_url = f"/covers/{new_filename}"
            cover_restored = True
    if not cover_restored and cover_url_field and cover_url_field != book.cover_url:
        _delete_cover_file(book.cover_url)
        book.cover_url = cover_url_field

    db.commit()
    db.refresh(book)
    books_by_id[book.id] = book
    if book.isbn:
        books_by_isbn[book.isbn] = book
    key = book.title.strip().lower()
    title_groups.setdefault(key, [])
    if book not in title_groups[key]:
        title_groups[key].append(book)

    return {
        "kind": "added" if is_new else "updated",
        "book": book_to_dict(book),
        "reason": None,
        "cover_restored": cover_restored,
        "isbn_corrupted": isbn_corrupted,
        "status_corrected": status_corrected,
    }


@app.post("/api/import/csv")
async def csv_import(
    file: UploadFile = File(...),
    enrich: bool = Form(False),
    db: Session = Depends(get_db),
):
    raw_bytes = await file.read()
    try:
        text = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw_bytes.decode("latin-1")

    rows = parse_rows(text)
    if not rows:
        raise HTTPException(400, "No rows found — check the file is a CSV/TSV export")

    if _looks_like_own_export(rows):
        # This is a re-upload of this app's own CSV export (it has our ID +
        # Status columns) — use the lossless, ID-matched restore path
        # instead of the heuristic third-party mapper below. That mapper
        # infers status from signals (Shelves/dropped_dates/currently_reading)
        # that don't exist in our own export, so it always fell back to
        # "unread" and silently overwrote any status edits made in a
        # spreadsheet — which is exactly the bug this branch fixes.
        all_books = db.query(Book).all()
        books_by_id = {b.id: b for b in all_books}
        books_by_isbn = {b.isbn: b for b in all_books if b.isbn}
        title_groups: dict[str, list[Book]] = {}
        for b in all_books:
            title_groups.setdefault(b.title.strip().lower(), []).append(b)

        results = {"updated": [], "added": [], "ambiguous": [], "mismatched": [], "skipped": [], "isbn_corrupted_count": 0, "status_corrected_count": 0}
        for row in rows:
            outcome = _restore_backup_row(row, db, books_by_id, books_by_isbn, title_groups, zf=None)
            if outcome["kind"] in ("added", "updated"):
                results[outcome["kind"]].append(outcome["book"])
                if outcome.get("isbn_corrupted"):
                    results["isbn_corrupted_count"] += 1
                if outcome.get("status_corrected"):
                    results["status_corrected_count"] += 1
            elif outcome["kind"] in ("ambiguous", "mismatched"):
                results[outcome["kind"]].append({"row": row, "reason": outcome["reason"]})
        return results

    results = {"updated": [], "added": [], "skipped": []}
    existing_by_isbn = {b.isbn: b for b in db.query(Book).filter(Book.isbn.isnot(None)).all()}

    for row in rows:
        fields = map_row(row)
        if "title" not in fields and "isbn" not in fields:
            results["skipped"].append({"row": row, "reason": "no title or ISBN"})
            continue

        isbn = fields.get("isbn")
        existing = existing_by_isbn.get(isbn) if isbn else None

        if existing:
            tag_names = fields.pop("tags", None)
            for key, value in fields.items():
                # don't overwrite a manually-set cover with a guessed one
                if key == "cover_url" and existing.cover_url:
                    continue
                setattr(existing, key, value)
            if tag_names is not None:
                existing.tags = get_or_create_tags(db, tag_names)
            db.commit()
            db.refresh(existing)
            results["updated"].append(book_to_dict(existing))
            continue

        if "title" not in fields:
            results["skipped"].append({"row": row, "reason": "no title, and ISBN not already in library"})
            continue

        if enrich and isbn:
            try:
                meta = await lookup_isbn(isbn)
            except Exception:  # noqa: BLE001
                meta = None
            if meta:
                fields.setdefault("authors", meta.get("authors"))
                fields.setdefault("publisher", meta.get("publisher"))
                fields.setdefault("series", meta.get("series"))
                fields["cover_url"] = meta.get("cover_url") or fields.get("cover_url")
                fields["page_count"] = meta.get("page_count")
                fields["published_date"] = meta.get("published_date")
            await asyncio.sleep(0.3)

        tag_names = fields.pop("tags", None) or []
        book = Book(**fields)
        db.add(book)
        db.flush()
        book.tags = get_or_create_tags(db, tag_names)
        db.commit()
        db.refresh(book)
        if isbn:
            existing_by_isbn[isbn] = book
        results["added"].append(book_to_dict(book))

    return results


# ---------- Location import ----------

def _normalize_title(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (t or "").lower())


@app.post("/api/import/locations")
async def import_locations(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Bulk-assign locations from a CSV/TSV mapping books to shelves. Matches
    rows to existing books by our own ID column if present (most reliable,
    e.g. when re-importing an edited copy of our own export), then ISBN,
    then an unambiguous exact title match. Whenever a Title column is also
    present, it's cross-checked against the matched book — a mismatch means
    something is misaligned (bad edit, spreadsheet round-trip, wrong row)
    and the row is skipped rather than silently applied to the wrong book."""
    raw_bytes = await file.read()
    try:
        text_content = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError:
        text_content = raw_bytes.decode("latin-1")

    rows = parse_rows(text_content)
    if not rows:
        raise HTTPException(400, "No rows found — check the file is a CSV/TSV export")

    # Deliberately NOT "shelf"/"bookshelf"/"bookshelves" — in the common
    # StoryGraph/Goodreads-style export those columns hold reading status
    # and genre tags respectively, not a physical location. Treating them
    # as location aliases silently overwrote locations with the wrong data.
    recognized_cols = {"location", "shelf location", "storage location", "room", "physical location", "current location"}
    file_cols = {c.strip().lower() for c in rows[0].keys()}
    if not (recognized_cols & file_cols):
        raise HTTPException(
            400,
            "No location-like column found. Detected columns: "
            + ", ".join(sorted(c for c in rows[0].keys() if c))
            + ". Expected one named Location, Room, Storage Location, or similar "
            "(not Shelf/Bookshelf/Bookshelves — those already mean reading status and genre tags in this format).",
        )

    all_books = db.query(Book).all()
    books_by_id = {b.id: b for b in all_books}
    books_by_isbn = {b.isbn: b for b in all_books if b.isbn}
    title_groups: dict[str, list[Book]] = {}
    for b in all_books:
        title_groups.setdefault(b.title.strip().lower(), []).append(b)

    results = {"updated": [], "not_found": [], "ambiguous": [], "mismatched": [], "skipped": []}

    for row in rows:
        lower_map = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
        location = (
            lower_map.get("location")
            or lower_map.get("shelf location")
            or lower_map.get("storage location")
            or lower_map.get("room")
            or lower_map.get("physical location")
            or lower_map.get("current location")
        )
        if not location:
            results["skipped"].append({"row": row, "reason": "no location column value"})
            continue

        id_raw = lower_map.get("id")
        isbn_raw = lower_map.get("isbn13") or lower_map.get("isbn") or lower_map.get("isbn10")
        title = lower_map.get("title")

        book = None
        if id_raw and id_raw.isdigit():
            book = books_by_id.get(int(id_raw))
        if not book and isbn_raw:
            book = books_by_isbn.get(clean_isbn(isbn_raw))
        if not book and title:
            candidates = title_groups.get(title.strip().lower(), [])
            if len(candidates) == 1:
                book = candidates[0]
            elif len(candidates) > 1:
                results["ambiguous"].append({"row": row, "reason": f"{len(candidates)} books share this title — add an ISBN column to disambiguate"})
                continue

        if not book:
            results["not_found"].append(row)
            continue

        # sanity check: if the row also carries a Title, it must agree with
        # whichever book we matched (by ID or ISBN) — a disagreement means
        # something upstream is misaligned, so don't apply it blindly
        if title and _normalize_title(title) != _normalize_title(book.title):
            results["mismatched"].append({
                "row": row,
                "reason": f'row matched "{book.title}" but its Title column says "{title}" — skipped, check this row',
            })
            continue

        book.location = location
        results["updated"].append(book_to_dict(book))

    db.commit()
    return results


# ---------- CSV export ----------

CSV_EXPORT_HEADER = [
    "ID", "Title", "Author", "ISBN", "Publisher", "Published Date", "Page Count",
    "Description", "Location", "Series", "Tags", "Status", "Owned", "Date Added",
    "Date Started", "Date Finished", "Rating", "Review", "Contains Spoilers",
    "Cover URL", "Cover File",
]


def _latest_read_entry(b: Book):
    """The read entry the flat, one-row-per-book CSV export should represent
    for Review/Contains Spoilers — the most recently active read (mirrors
    the same "current/latest" logic as _recompute_read_cache)."""
    entries = list(b.read_entries)
    if not entries:
        return None
    in_progress = [e for e in entries if e.date_started and not e.date_finished]
    if in_progress:
        return sorted(in_progress, key=lambda e: (e.date_started, e.id))[-1]
    finished = [e for e in entries if e.date_finished]
    if finished:
        return sorted(finished, key=lambda e: (e.date_finished, e.id))[-1]
    return sorted(entries, key=lambda e: e.id)[-1]


def _book_export_row(b: Book, cover_file: str = "") -> list:
    review = _latest_read_entry(b)
    return [
        b.id,
        b.title,
        b.authors or "",
        b.isbn or "",
        b.publisher or "",
        b.published_date or "",
        b.page_count or "",
        b.description or "",
        b.location or "",
        b.series or "",
        "; ".join(sorted(t.name for t in b.tags)),
        b.status.value if hasattr(b.status, "value") else b.status,
        "true" if b.owned else "false",
        b.added_at.isoformat() if b.added_at else "",
        b.date_started.isoformat() if b.date_started else "",
        b.date_finished.isoformat() if b.date_finished else "",
        b.rating or "",
        review.review_text if review else "",
        "true" if (review and review.contains_spoilers) else "false",
        b.cover_url or "",
        cover_file,
    ]


@app.get("/api/export/csv")
def export_csv(db: Session = Depends(get_db)):
    books = db.query(Book).order_by(Book.title).all()
    output = io.StringIO()
    # QUOTE_ALL: every field gets quoted, even simple ones. Makes the file
    # maximally resistant to being mangled if it's opened and re-saved in
    # Excel/Sheets before being re-imported.
    writer = csv.writer(output, quoting=csv.QUOTE_ALL)
    writer.writerow(CSV_EXPORT_HEADER)
    for b in books:
        cover_file = os.path.basename(b.cover_url) if b.cover_url and b.cover_url.startswith("/covers/") else ""
        writer.writerow(_book_export_row(b, cover_file))

    filename = f"library-export-{datetime.date.today().isoformat()}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/export/zip")
def export_zip(db: Session = Depends(get_db)):
    """Full backup: the same data as the plain CSV export, plus the actual
    image files for any manually-uploaded covers, bundled together so the
    whole library — including cover art — can be restored elsewhere."""
    books = db.query(Book).order_by(Book.title).all()
    csv_buffer = io.StringIO()
    writer = csv.writer(csv_buffer, quoting=csv.QUOTE_ALL)
    writer.writerow(CSV_EXPORT_HEADER)

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for b in books:
            cover_file = ""
            if b.cover_url and b.cover_url.startswith("/covers/"):
                fname = os.path.basename(b.cover_url)
                src_path = os.path.join(COVERS_DIR, fname)
                if os.path.isfile(src_path):
                    cover_file = fname
                    zf.write(src_path, arcname=f"covers/{fname}")
            writer.writerow(_book_export_row(b, cover_file))
        zf.writestr("library.csv", csv_buffer.getvalue())

    zip_buffer.seek(0)
    filename = f"library-backup-{datetime.date.today().isoformat()}.zip"
    return StreamingResponse(
        iter([zip_buffer.getvalue()]),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/import/zip")
async def import_zip(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Restore a full backup produced by /api/export/zip — matches books by
    this app's own ID first (most reliable), then ISBN, then an unambiguous
    title match, and restores any bundled cover images."""
    raw = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Not a valid zip file")

    csv_name = next((n for n in zf.namelist() if n.lower().endswith("library.csv")), None)
    if not csv_name:
        raise HTTPException(400, "Zip doesn't contain a library.csv — is this a backup made by this app's Export?")

    csv_text = zf.read(csv_name).decode("utf-8-sig")
    rows = parse_rows(csv_text)
    if not rows:
        raise HTTPException(400, "No rows found in library.csv")

    all_books = db.query(Book).all()
    books_by_id = {b.id: b for b in all_books}
    books_by_isbn = {b.isbn: b for b in all_books if b.isbn}
    title_groups: dict[str, list[Book]] = {}
    for b in all_books:
        title_groups.setdefault(b.title.strip().lower(), []).append(b)

    results = {"updated": [], "added": [], "ambiguous": [], "mismatched": [], "covers_restored": 0, "isbn_corrupted_count": 0, "status_corrected_count": 0}

    for row in rows:
        outcome = _restore_backup_row(row, db, books_by_id, books_by_isbn, title_groups, zf=zf)
        if outcome["kind"] in ("added", "updated"):
            results[outcome["kind"]].append(outcome["book"])
            if outcome.get("cover_restored"):
                results["covers_restored"] += 1
            if outcome.get("isbn_corrupted"):
                results["isbn_corrupted_count"] += 1
            if outcome.get("status_corrected"):
                results["status_corrected_count"] += 1
        elif outcome["kind"] in ("ambiguous", "mismatched"):
            results[outcome["kind"]].append({"row": row, "reason": outcome["reason"]})

    return results


# ---------- Helpers ----------

def book_to_dict(b: Book) -> dict:
    return {
        "id": b.id,
        "isbn": b.isbn,
        "title": b.title,
        "authors": b.authors,
        "publisher": b.publisher,
        "published_date": b.published_date,
        "page_count": b.page_count,
        "description": b.description,
        "cover_url": b.cover_url,
        "genre": b.genre,
        "location": b.location,
        "series": b.series,
        "tags": sorted(t.name for t in b.tags),
        "owned": b.owned,
        "status": b.status.value if hasattr(b.status, "value") else b.status,
        "date_started": b.date_started.isoformat() if b.date_started else None,
        "date_finished": b.date_finished.isoformat() if b.date_finished else None,
        "rating": b.rating,
        "read_count": len(b.read_entries),
        "has_reviews": any(e.review_text for e in b.read_entries),
    }


def read_entry_to_dict(e: ReadEntry) -> dict:
    return {
        "id": e.id,
        "book_id": e.book_id,
        "date_started": e.date_started.isoformat() if e.date_started else None,
        "date_finished": e.date_finished.isoformat() if e.date_finished else None,
        "rating": e.rating,
        "review_text": e.review_text,
        "contains_spoilers": e.contains_spoilers,
        "created_at": e.created_at.isoformat() if e.created_at else None,
        "updated_at": e.updated_at.isoformat() if e.updated_at else None,
    }


# ---------- Static frontend ----------
app.mount("/covers", StaticFiles(directory=COVERS_DIR), name="covers")
app.mount("/", StaticFiles(directory="/app/frontend", html=True), name="frontend")
