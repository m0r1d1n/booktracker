"""Fetch book metadata from public, key-free APIs given an ISBN."""
import re
import httpx

OPENLIBRARY_URL = "https://openlibrary.org/api/books"
OPENLIBRARY_EDITION_URL = "https://openlibrary.org/isbn/{isbn}.json"
OPENLIBRARY_COVER = "https://covers.openlibrary.org/b/isbn/{isbn}-L.jpg"
GOOGLE_BOOKS_URL = "https://www.googleapis.com/books/v1/volumes"

# Matches a trailing "(Series Name, #3)" / "(Series Name #3)" /
# "(Series Name, Book 3)" / "(Series Name Vol. 3)" style suffix on a title —
# common across Open Library, Google Books, and most tracker exports. The
# numeric marker is required so we don't misread a plain descriptive
# parenthetical (e.g. "(Illustrated Edition)") as a series.
_SERIES_TITLE_PATTERN = re.compile(
    r"^(?P<title>.+?)\s*\(\s*(?P<series>[^,()]+?)\s*(?:,\s*)?"
    r"(?:#|book\s+|vol(?:ume)?\.?\s+)(?P<num>\d+(?:\.\d+)?)\s*\)\s*$",
    re.IGNORECASE,
)


def clean_isbn(raw: str) -> str:
    return re.sub(r"[^0-9Xx]", "", raw or "").upper()


def parse_series_from_title(title: str) -> tuple[str, str | None]:
    """Split a title like 'A Clash of Kings (A Song of Ice and Fire, #2)'
    into ('A Clash of Kings', 'A Song of Ice and Fire'). Returns the title
    unchanged and None for series if no such pattern is found. Deliberately
    drops the volume number rather than keeping it in the series name, so
    every book in a series groups together instead of each volume forming
    its own one-book "series"."""
    if not title:
        return title, None
    match = _SERIES_TITLE_PATTERN.match(title.strip())
    if not match:
        return title, None
    clean_title = match.group("title").strip().rstrip(":,-").strip()
    series = match.group("series").strip()
    if not clean_title or not series:
        return title, None
    return clean_title, series


async def _fetch_openlibrary_series(client: httpx.AsyncClient, isbn: str) -> str | None:
    """Open Library's edition record (distinct from the summarized jscmd=data
    endpoint used elsewhere) occasionally has an explicit 'series' field,
    contributed manually — so it's not present for every book, but when it
    is, it's more reliable than guessing from the title."""
    try:
        resp = await client.get(OPENLIBRARY_EDITION_URL.format(isbn=isbn), timeout=10)
        if resp.status_code != 200:
            return None
        data = resp.json()
    except (httpx.HTTPError, ValueError):
        return None
    series = data.get("series")
    if isinstance(series, list) and series:
        return str(series[0]).strip() or None
    if isinstance(series, str) and series.strip():
        return series.strip()
    return None


async def _lookup_openlibrary(client: httpx.AsyncClient, isbn: str) -> dict | None:
    params = {
        "bibkeys": f"ISBN:{isbn}",
        "format": "json",
        "jscmd": "data",
    }
    resp = await client.get(OPENLIBRARY_URL, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    entry = data.get(f"ISBN:{isbn}")
    if not entry:
        return None

    authors = ", ".join(a.get("name", "") for a in entry.get("authors", []))
    subjects = ", ".join(s.get("name", "") for s in entry.get("subjects", [])[:3])
    cover = None
    if entry.get("cover"):
        cover = entry["cover"].get("large") or entry["cover"].get("medium")
    if not cover:
        cover = OPENLIBRARY_COVER.format(isbn=isbn)

    page_count = entry.get("number_of_pages")
    title = entry.get("title") or "Unknown title"

    return {
        "isbn": isbn,
        "title": title,
        "authors": authors or None,
        "publisher": ", ".join(p.get("name", "") for p in entry.get("publishers", [])) or None,
        "published_date": entry.get("publish_date"),
        "page_count": page_count,
        "description": (entry.get("notes") if isinstance(entry.get("notes"), str) else None),
        "cover_url": cover,
        "genre": subjects or None,
    }


async def _lookup_google_books(client: httpx.AsyncClient, isbn: str) -> dict | None:
    resp = await client.get(
        GOOGLE_BOOKS_URL, params={"q": f"isbn:{isbn}"}, timeout=10
    )
    resp.raise_for_status()
    data = resp.json()
    items = data.get("items")
    if not items:
        return None
    info = items[0].get("volumeInfo", {})
    image_links = info.get("imageLinks", {})
    cover = image_links.get("large") or image_links.get("thumbnail")
    if cover:
        cover = cover.replace("http://", "https://")

    title = info.get("title") or "Unknown title"
    # Google Books sometimes splits a series-bearing subtitle out separately
    # rather than appending "(Series, #N)" to the title itself
    subtitle = info.get("subtitle")
    if subtitle and re.search(r"#\s*\d", subtitle):
        title = f"{title} ({subtitle})"

    return {
        "isbn": isbn,
        "title": title,
        "authors": ", ".join(info.get("authors", [])) or None,
        "publisher": info.get("publisher"),
        "published_date": info.get("publishedDate"),
        "page_count": info.get("pageCount"),
        "description": info.get("description"),
        "cover_url": cover or OPENLIBRARY_COVER.format(isbn=isbn),
        "genre": ", ".join(info.get("categories", [])[:3]) or None,
    }


async def lookup_isbn(isbn: str) -> dict | None:
    """Try Open Library first, then fall back to Google Books. Also attempts
    to identify series info — first from Open Library's edition-level
    'series' field where contributors have added it, then by parsing a
    '(Series Name, #N)'-style suffix off the title, which is how most
    sources (including Open Library and Google Books) actually represent it
    in practice."""
    isbn = clean_isbn(isbn)
    if not isbn:
        return None
    async with httpx.AsyncClient() as client:
        result = None
        try:
            result = await _lookup_openlibrary(client, isbn)
        except httpx.HTTPError:
            pass
        if not result:
            try:
                result = await _lookup_google_books(client, isbn)
            except httpx.HTTPError:
                return None
        if not result:
            return None

        series = None
        try:
            series = await _fetch_openlibrary_series(client, isbn)
        except httpx.HTTPError:
            pass

        clean_title, parsed_series = parse_series_from_title(result["title"])
        result["title"] = clean_title
        result["series"] = series or parsed_series

        return result
