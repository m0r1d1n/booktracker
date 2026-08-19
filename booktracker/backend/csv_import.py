"""Parse a CSV/TSV export from another book-tracking site and map its columns
onto our Book fields. Built against a StoryGraph-style export (Title, Author,
ISBN, Publisher, Date Read, Shelves, Bookshelves, read_dates, tags, authors,
isbn10, isbn13, owned, dropped_dates, currently_reading) but tolerant of
missing columns, since these exports vary by site and by year.
"""
import csv
import io
import datetime
from typing import Optional

from dateutil import parser as dateparser

from isbn_lookup import clean_isbn
from models import ReadStatus

TRUE_VALUES = {"true", "1", "yes", "y", "t"}
FALSE_VALUES = {"false", "0", "no", "n", "f", ""}


def sniff_dialect(sample: str) -> str:
    """Return the delimiter character. Tries the standard csv.Sniffer first,
    then falls back to counting candidate delimiters in the header row —
    tabs are common in these exports despite a .csv extension, and some
    regional spreadsheet exports use semicolons instead of commas."""
    first_line = sample.splitlines()[0] if sample.splitlines() else ""
    try:
        return csv.Sniffer().sniff(first_line, delimiters=",\t;").delimiter
    except csv.Error:
        pass
    counts = {"\t": first_line.count("\t"), ",": first_line.count(","), ";": first_line.count(";")}
    best = max(counts, key=counts.get)
    return best if counts[best] > 0 else ","


def parse_rows(raw_text: str) -> list[dict]:
    delimiter = sniff_dialect(raw_text)
    reader = csv.DictReader(io.StringIO(raw_text), delimiter=delimiter)
    rows = []
    for row in reader:
        # normalize keys: strip whitespace, keep original case for lookup below
        clean = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        if any(clean.values()):
            rows.append(clean)
    return rows


def _get(row: dict, *names: str) -> str:
    """Case-insensitive lookup across a list of candidate column names."""
    lower_map = {k.lower(): v for k, v in row.items()}
    for name in names:
        v = lower_map.get(name.lower())
        if v:
            return v
    return ""


def _parse_date(value: str) -> Optional[datetime.date]:
    if not value:
        return None
    # a read_dates / dropped_dates cell can hold several comma-separated dates;
    # use the last one (most recent)
    candidate = value.split(",")[-1].strip()
    if not candidate:
        return None
    try:
        return dateparser.parse(candidate, dayfirst=False, fuzzy=True).date()
    except (ValueError, OverflowError):
        try:
            return dateparser.parse(candidate, dayfirst=True, fuzzy=True).date()
        except (ValueError, OverflowError):
            return None


def _parse_bool(value: str, default: bool = True) -> bool:
    if value == "":
        return default
    return value.strip().lower() in TRUE_VALUES


def map_row(row: dict) -> dict:
    """Turn one CSV row into a dict of Book field values (only keys that were
    actually derivable are included, so callers can merge onto an existing
    book without clobbering fields the CSV doesn't cover)."""
    title = _get(row, "Title")
    isbn13 = _get(row, "isbn13")
    isbn10 = _get(row, "isbn10")
    isbn_plain = _get(row, "ISBN")
    isbn = clean_isbn(isbn13 or isbn_plain or isbn10)

    authors = _get(row, "Author", "authors")
    publisher = _get(row, "Publisher")
    location = _get(row, "Location", "Shelf Location", "Storage Location", "Room")

    tags_field = _get(row, "tags", "Bookshelves")
    if ";" in tags_field:
        tag_list = [t.strip() for t in tags_field.split(";") if t.strip()]
    elif "," in tags_field:
        tag_list = [t.strip() for t in tags_field.split(",") if t.strip()]
    else:
        tag_list = [t.strip() for t in tags_field.split() if t.strip()]

    date_read = _parse_date(_get(row, "Date Read", "read_dates"))
    dropped_raw = _get(row, "dropped_dates")
    date_dropped = _parse_date(dropped_raw)
    currently_reading = _parse_bool(_get(row, "currently_reading"), default=False)
    shelves = _get(row, "Shelves").lower()

    if currently_reading:
        status = ReadStatus.reading
    elif dropped_raw:
        status = ReadStatus.dnf
    elif date_read or "read" == shelves:
        status = ReadStatus.read
    elif "to-read" in shelves or "want" in shelves:
        status = ReadStatus.unread
    elif "reading" in shelves:
        status = ReadStatus.reading
    else:
        status = ReadStatus.unread

    owned_raw = _get(row, "owned")
    owned = _parse_bool(owned_raw, default=True)

    out = {}
    if title:
        out["title"] = title
    if isbn:
        out["isbn"] = isbn
        out["cover_url"] = f"https://covers.openlibrary.org/b/isbn/{isbn}-L.jpg"
    if authors:
        out["authors"] = authors
    if publisher:
        out["publisher"] = publisher
    if location:
        out["location"] = location
    if tag_list:
        out["tags"] = tag_list
    out["status"] = status
    out["owned"] = owned
    if date_read and status == ReadStatus.read:
        out["date_finished"] = date_read
    if date_dropped and status == ReadStatus.dnf:
        out["date_finished"] = date_dropped

    return out
