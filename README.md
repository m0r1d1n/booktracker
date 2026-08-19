### Booktracker — a self-hosted personal library tracker

A vibe coded piece of trash I whipped up on claude to show someone how AI worked.

It is a mimicry of Jelu, which is the app I still continue to use. 


A small Docker app for cataloguing ~1000 books: ownership, reading status/dates,
ratings, reviews, bulk ISBN import, and a visual "shelf" view with cover art.

#### Stack
**Backend:** FastAPI + SQLite (SQLAlchemy), single container
**Frontend:** plain HTML/CSS/JS 
**Metadata source:** [Open Library](https://openlibrary.org/dev/docs/api/books) API,
  falling back to Google Book. Both free, longrunning services, with no API key required
**Data:** Docker volume (`booktracker_data`), so it survives rebuilds

#### Run it

Normal docker compose. 

I use port tcp\8000.



Everything below here is AI drivel. 

#### Using it

- **Shelf** — a visual bookshelf of your books, spine art from cover images, grouped
  into labelled sections by **location**. Filter to one location or one genre/tag,
  or leave both on "All" to see everything. **The shelf order is randomized every
  time you open the tab** (or hit the 🔀 Shuffle button) — a deliberate way to
  rediscover books buried in a big collection, rather than always seeing the same
  alphabetical order. Click any spine to open its details/edit form.
- **Library** — a searchable/filterable table: location, tags, status, start/finish
  dates, rating. Filter by location or by a specific genre/tag. Click a title to
  edit; "+ Add book" to add one manually. Tick the checkboxes on the left and use
  the bar that appears to set a location on many books at once.
- **Reviews** — every book you've written a review for, newest edits first. Reviews
  are edited from inside a book's modal (Details/Review tabs) and support a
  spoiler flag.
- **Genres & tags** — every book has a free-text tags field (comma-separated) meant
  for genres, but usable for anything you want to sort by ("owned-signed",
  "to-lend", a series name, whatever). Tag autocompletes from what you've already
  used. Filter the Shelf or Library to one tag at a time from the dropdown.
- **Accession** — has four sub-tabs:
  - **By ISBN** — paste a list of ISBNs (one per line) to bulk import; metadata,
    cover art, and subject tags are fetched automatically.
  - **From CSV / spreadsheet export** — upload a CSV or TSV export from another
    tracker. Columns are matched by name, so a "Title, Author, ISBN, Publisher,
    Date Read, Shelves, tags, owned, dropped_dates, currently_reading"-style
    export works directly. Rows whose ISBN already matches a book in your library
    **update** that book (status, dates, rating, tags) instead of duplicating it;
    new ISBNs are added as new books, optionally enriched with full metadata.
  - **Import locations** — upload a CSV/TSV with a `Location` (or `Shelf`/
    `Bookshelf`) column plus an `ISBN` or `Title` column to bulk-tag existing
    books with where they physically live — handy if you've got a spreadsheet
    from sorting your shelves. It only updates books already in your library;
    it won't create new ones.
  - **Export** — one button, downloads your whole library (including location,
    tags, dates, rating, and review text) as a single CSV file. Good for backups
    or moving your catalogue elsewhere. Also reachable directly at
    `GET /api/export/csv`.

    Notes on the CSV import mapping:
    - Read/finish dates are parsed flexibly; a bare `11/08/2026` is read as
      month/day/year (US-style) — if your export is day/month/year, dates near
      the start of the month may come out shifted. Fix any that land wrong from
      the book's edit modal.
    - Status is inferred: `currently_reading` wins if set, then a
      `dropped_dates` value means "did not finish", then a `Date Read` (or a
      "read" shelf) means "read", then a "to-read"/"want" shelf means "unread".
    - `tags`/`Bookshelves` columns become the book's tags (genres).

#### Notes on bulk import at ~1000-book scale

The import endpoint looks up ISBNs one at a time with a short pause between each
call, to stay well within the free, key-less usage of Open Library/Google Books.
For very large batches (many hundreds), split the paste into a few chunks of a
few hundred ISBNs each rather than one giant paste — the request will otherwise
be open for several minutes, which some reverse proxies time out.

#### Project layout

```
booktracker/
├── backend/
│   ├── main.py         # FastAPI routes
│   ├── models.py        # SQLAlchemy models (Book, Review)
│   ├── database.py      # SQLite engine/session
│   ├── isbn_lookup.py   # Open Library / Google Books metadata fetch
│   ├── csv_import.py    # CSV/TSV export parsing + field mapping
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── Dockerfile
└── docker-compose.yml
```

#### Extending later
- The API is at `/api/*` (e.g. `/api/books`, `/api/import`, `/api/reviews`,
  `/api/tags`, `/api/export/csv`) if you ever want to script imports or build
  another client against it.
- `models.py` is a good place to add fields (e.g. series, loaned-to) — SQLite
  will need a migration step for new columns on an existing database. A small
  auto-migration already runs on startup for the `location` column and for
  moving the old `genre` text field into the new tags table; follow the same
  pattern (`_run_migrations()` in `main.py`) for future schema changes.
