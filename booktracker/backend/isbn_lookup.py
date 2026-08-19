"""Fetch book metadata from public, key-free APIs given an ISBN."""
import re
import httpx

OPENLIBRARY_URL = "https://openlibrary.org/api/books"
OPENLIBRARY_COVER = "https://covers.openlibrary.org/b/isbn/{isbn}-L.jpg"
GOOGLE_BOOKS_URL = "https://www.googleapis.com/books/v1/volumes"


def clean_isbn(raw: str) -> str:
    return re.sub(r"[^0-9Xx]", "", raw or "").upper()


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

    return {
        "isbn": isbn,
        "title": entry.get("title") or "Unknown title",
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

    return {
        "isbn": isbn,
        "title": info.get("title") or "Unknown title",
        "authors": ", ".join(info.get("authors", [])) or None,
        "publisher": info.get("publisher"),
        "published_date": info.get("publishedDate"),
        "page_count": info.get("pageCount"),
        "description": info.get("description"),
        "cover_url": cover or OPENLIBRARY_COVER.format(isbn=isbn),
        "genre": ", ".join(info.get("categories", [])[:3]) or None,
    }


async def lookup_isbn(isbn: str) -> dict | None:
    """Try Open Library first, then fall back to Google Books."""
    isbn = clean_isbn(isbn)
    if not isbn:
        return None
    async with httpx.AsyncClient() as client:
        try:
            result = await _lookup_openlibrary(client, isbn)
            if result:
                return result
        except httpx.HTTPError:
            pass
        try:
            return await _lookup_google_books(client, isbn)
        except httpx.HTTPError:
            return None
