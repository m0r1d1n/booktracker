import datetime
import asyncio
import csv
import io
import re
from typing import Optional, List

from fastapi import FastAPI, Depends, HTTPException, UploadFile, File, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session
from sqlalchemy import or_, func, text

from database import Base, engine, get_db, SessionLocal
from models import Book, Review, ReadStatus, Tag
from isbn_lookup import lookup_isbn, clean_isbn
from csv_import import parse_rows, map_row

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


_run_migrations()

app = FastAPI(title="Book Tracker")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- Schemas ----------

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
    owned: bool = True
    status: ReadStatus = ReadStatus.unread
    date_started: Optional[datetime.date] = None
    date_finished: Optional[datetime.date] = None
    rating: Optional[int] = None
    tags: Optional[List[str]] = None

    @field_validator("rating")
    @classmethod
    def rating_range(cls, v):
        if v is not None and not (1 <= v <= 5):
            raise ValueError("rating must be between 1 and 5")
        return v


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
    owned: Optional[bool] = None
    status: Optional[ReadStatus] = None
    date_started: Optional[datetime.date] = None
    date_finished: Optional[datetime.date] = None
    rating: Optional[int] = None
    tags: Optional[List[str]] = None

    @field_validator("rating")
    @classmethod
    def rating_range(cls, v):
        if v is not None and not (1 <= v <= 5):
            raise ValueError("rating must be between 1 and 5")
        return v


class ReviewIn(BaseModel):
    review_text: str
    contains_spoilers: bool = False


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


@app.post("/api/books")
def create_book(payload: BookIn, db: Session = Depends(get_db)):
    data = payload.model_dump()
    tag_names = data.pop("tags", None) or []
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
    db.delete(book)
    db.commit()
    return {"deleted": True}


# ---------- Review routes ----------

@app.get("/api/books/{book_id}/review")
def get_review(book_id: int, db: Session = Depends(get_db)):
    review = db.query(Review).filter(Review.book_id == book_id).first()
    if not review:
        return None
    return review_to_dict(review)


@app.put("/api/books/{book_id}/review")
def upsert_review(book_id: int, payload: ReviewIn, db: Session = Depends(get_db)):
    book = db.query(Book).get(book_id)
    if not book:
        raise HTTPException(404, "Book not found")
    review = db.query(Review).filter(Review.book_id == book_id).first()
    if review:
        review.review_text = payload.review_text
        review.contains_spoilers = payload.contains_spoilers
        review.updated_at = datetime.datetime.utcnow()
    else:
        review = Review(book_id=book_id, **payload.model_dump())
        db.add(review)
    db.commit()
    db.refresh(review)
    return review_to_dict(review)


@app.get("/api/reviews")
def list_reviews(db: Session = Depends(get_db)):
    reviews = db.query(Review).order_by(Review.updated_at.desc()).all()
    out = []
    for r in reviews:
        d = review_to_dict(r)
        d["book"] = book_to_dict(r.book)
        out.append(d)
    return out


@app.delete("/api/books/{book_id}/review")
def delete_review(book_id: int, db: Session = Depends(get_db)):
    review = db.query(Review).filter(Review.book_id == book_id).first()
    if review:
        db.delete(review)
        db.commit()
    return {"deleted": True}


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

@app.get("/api/export/csv")
def export_csv(db: Session = Depends(get_db)):
    books = db.query(Book).order_by(Book.title).all()
    output = io.StringIO()
    # QUOTE_ALL: every field gets quoted, even simple ones. Makes the file
    # maximally resistant to being mangled if it's opened and re-saved in
    # Excel/Sheets before being re-imported.
    writer = csv.writer(output, quoting=csv.QUOTE_ALL)
    writer.writerow([
        "ID", "Title", "Author", "ISBN", "Publisher", "Published Date", "Page Count",
        "Location", "Tags", "Status", "Owned", "Date Started", "Date Finished",
        "Rating", "Review", "Contains Spoilers",
    ])
    for b in books:
        review = b.review
        writer.writerow([
            b.id,
            b.title,
            b.authors or "",
            b.isbn or "",
            b.publisher or "",
            b.published_date or "",
            b.page_count or "",
            b.location or "",
            "; ".join(sorted(t.name for t in b.tags)),
            b.status.value if hasattr(b.status, "value") else b.status,
            "true" if b.owned else "false",
            b.date_started.isoformat() if b.date_started else "",
            b.date_finished.isoformat() if b.date_finished else "",
            b.rating or "",
            review.review_text if review else "",
            "true" if (review and review.contains_spoilers) else "false",
        ])

    filename = f"library-export-{datetime.date.today().isoformat()}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


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
        "tags": sorted(t.name for t in b.tags),
        "owned": b.owned,
        "status": b.status.value if hasattr(b.status, "value") else b.status,
        "date_started": b.date_started.isoformat() if b.date_started else None,
        "date_finished": b.date_finished.isoformat() if b.date_finished else None,
        "rating": b.rating,
        "has_review": b.review is not None,
    }


def review_to_dict(r: Review) -> dict:
    return {
        "id": r.id,
        "book_id": r.book_id,
        "review_text": r.review_text,
        "contains_spoilers": r.contains_spoilers,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
    }


# ---------- Static frontend ----------
app.mount("/", StaticFiles(directory="/app/frontend", html=True), name="frontend")
