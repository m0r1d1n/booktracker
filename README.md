# The Stacks — a self-hosted personal library tracker

Authors Note: Vibe Coded trash, but it does the job for keeping track of my personal library. 

A small Docker app for cataloguing ~1000 books: ownership, reading status/dates,
ratings, reviews, bulk ISBN import, and a visual "shelf" view with cover art.

## Stack
- **Backend:** FastAPI + SQLite (SQLAlchemy), single container
- **Frontend:** plain HTML/CSS/JS (no build step), served by the same container
- **Metadata source:** [Open Library](https://openlibrary.org/dev/docs/api/books) API,
  falling back to Google Books — both free, no API key required
- **Data:** stored in a named Docker volume (`booktracker_data`), so it survives rebuilds

## How's it Look?
This is the home page of the app.
<br> 

<img height="500" alt="Booktracker_01" src="https://github.com/user-attachments/assets/ef375624-a2e4-40c7-a0c9-d7f4bbba6d18" />

<br> 
<br>
<br> 

<details>
  <summary><b>📸 Click to view Project Gallery</b></summary>
  <br>
  <br>
  
  | Home Page - Spine View | Home Page - Cover View | Editing | Sorted by Locations | Mass Edit Page | Import/Export | 
  | :---: | :---: | :---: | :---: | :---: | :---: |
  | ![Home Page - Spine View](https://github.com/user-attachments/assets/ef375624-a2e4-40c7-a0c9-d7f4bbba6d18) | ![Home Page - Cover View](https://github.com/user-attachments/assets/b5f6476d-64e8-4cc3-b816-3192e7deda86) | ![Editing](https://github.com/user-attachments/assets/d9f8fca2-9de1-410d-bd79-7b0ad26e37e5) | ![Sorted by Locations](https://github.com/user-attachments/assets/e6a620ee-2b59-4179-a943-70c84a06ec8d) | ![Mass Edit Page](https://github.com/user-attachments/assets/ad7c9d62-6dba-45e1-8b55-e7e6353eaf24) | ![Import / Export](https://github.com/user-attachments/assets/d3df005b-79d3-48a0-88b2-1762910f324c) | 

</details>


## Run it

```bash
docker compose up -d --build
```

Then open **http://localhost:8000** (or `http://<your-server-ip>:8000` if running on a NAS/VM).

To stop: `docker compose down` (data persists in the volume).
To fully reset: `docker compose down -v`.

## Using it

- **Library** (the visual bookshelf) — spine art from cover images, grouped by
  **By Location**, **By Series**, **By Author**, or shown **Flat** with no
  grouping at all — pick with the segmented control in the toolbar. Filter to
  one location or one
  genre/tag, or leave both on "All" to see everything. **The order is randomized
  every time you open the tab** (or hit the 🔀 Shuffle button) — a deliberate way
  to rediscover books buried in a big collection; click "Sort A–Z" to switch back
  to alphabetical. The **Spines / Full Covers** toggle switches between the
  narrow cropped spine look and full, uncropped cover art at a wider size — the
  shelf still fills edge-to-edge either way, just with fewer, bigger books per
  row in Full Covers mode. Both this and your grouping choice are remembered
  across visits. Click any spine to open its details/edit form, where you can
  edit **Title**, **Author(s)**, and **Series** (the latter is free text and
  autocompletes from what you've already used — same pattern as Location and
  Tags), alongside everything else.

  Note: within a series group, books are ordered the same way as everywhere
  else (alphabetically, or shuffled) — there's no separate "book 1, 2, 3"
  ordering field yet. If you want true reading-order sequencing within a
  series later, that'd need a small additional field (e.g. a volume number) —
  happy to add it if it'd help.
- **To Read** — a flat list of everything marked Reading or Planning to Read,
  across every location — a proper to-do list rather than a shelf to browse.
- **Edit** (the table view) — searchable/filterable: location, tags, status,
  start/finish dates, rating. Filter by location or by a specific genre/tag, or
  tick "Missing cover only" to find books that still need a cover. Click a title
  to edit; "+ Add book" to add one manually. Tick the checkboxes on the left and
  use the bar that appears to set — or clear — a location on many books at once.
- **Reading History & Reviews** — every book can have multiple read-throughs
  logged, each with its own start/finish dates, half-star rating (0.5
  increments, e.g. 3.5), review text, and spoiler flag — open a book's modal
  and use the **Reading History** tab to add a read, edit one, or delete one.
  This is what re-reading is for: your original read from years ago keeps its
  own dates, rating, and review exactly as you left them, while a new entry
  tracks the re-read separately. The book's Details tab shows a simple summary
  line ("Last read: finished ...") reflecting the most recent (or currently
  in-progress) read — the Reading History tab is where the real editing
  happens. The **Reviews** tab lists every read-through that has review text,
  newest first, across your whole library.
- **Reading status** — Unread, Planning to Read, Reading, Read, or Did Not Finish.
  A book with a finish date set can't be Unread — the edit modal disables that
  option whenever the cached "last read" date is present — but every other
  status is fine, since re-reading a book you've finished before is a normal
  reason to move it back to Reading or Planning to Read while its finish date
  stays as history. This is enforced both in the UI and by the API itself, and
  CSV/ZIP imports auto-correct any row that violates it (bumping Unread to
  Read rather than rejecting the row) — you'll see a count of how many rows
  were corrected in the import results if this happens.
- **Ratings** — half-star increments from 0.5 to 5 (e.g. 3.5), on both the
  book level and per read-through. Click the left or right half of a star to
  set a half or whole value; click the same value again to clear it.
- **Genres & tags** — every book has a free-text tags field (comma-separated) meant
  for genres, but usable for anything you want to sort by ("owned-signed",
  "to-lend", a series name, whatever). Tag autocompletes from what you've already
  used. Filter Library or Edit to one tag at a time from the dropdown.
- **Cover images** — open any book's edit modal to upload a cover image
  (JPG/PNG/WEBP/GIF, up to 12 MB) straight from your device, or remove one to
  fall back to the plain spine look. Uploaded images are stored in the same
  persistent Docker volume as the database, so they survive rebuilds.
- **Accession** — has four sub-tabs:
  - **By ISBN** — paste a list of ISBNs (one per line) to bulk import; metadata,
    cover art, subject tags, and **series** are fetched automatically. Series
    detection tries Open Library's edition-level `series` field first (present
    when a contributor has added it), then falls back to parsing a
    "(Series Name, #3)"-style suffix off the title — which is how most sources,
    including Open Library and Google Books, actually represent series in
    practice. The volume number is deliberately dropped rather than kept in the
    series name, so every book in a series groups together under one label
    instead of each volume forming its own one-book "series". This isn't
    perfect — some editions simply don't have series data anywhere in the
    metadata, in which case you'll need to set it manually from the book's
    edit modal.
  - **From CSV / spreadsheet export** — upload a CSV or TSV export from another
    tracker. Columns are matched by name, so a "Title, Author, ISBN, Publisher,
    Date Read, Shelves, tags, owned, dropped_dates, currently_reading"-style
    export works directly. Rows whose ISBN already matches a book in your library
    **update** that book (status, dates, rating, tags) instead of duplicating it;
    new ISBNs are added as new books, optionally enriched with full metadata.

    **Re-uploading this app's own CSV export is auto-detected** (by its `ID` +
    `Status` columns) and handled differently: it's matched by `ID` first
    (falling back to ISBN, then an unambiguous title match) and every column —
    including `Status` — is trusted directly, rather than guessed at. This
    matters because the third-party guesser above has no way to read a literal
    `Status` column; it only infers status from other trackers' fields, so if
    you edited statuses/dates in this app's own exported CSV and it went
    through the generic guesser, every book would silently reset to "unread".
    That's now avoided automatically.

    **A note on Excel/Sheets and ISBNs:** opening the exported CSV in a
    spreadsheet and saving it back can silently convert 13-digit ISBNs into
    scientific notation (e.g. `9.78045E+12`), and the original digits can't be
    recovered from that text. The importer detects this pattern and skips
    writing that ISBN rather than overwriting a correct one with garbage — you'll
    see a warning in the import results if this happens. To avoid it in the
    first place, format the ISBN column as **Text** before saving in Excel/Sheets.

    This tab also has a **"Restore a full ZIP backup"** section for restoring
    this app's own ZIP export (see below) — including cover images. It shares
    the same ID-matching and ISBN-corruption protections as the CSV path above.
  - **Import locations** — upload a CSV/TSV with a `Location` (or `Shelf`/
    `Bookshelf`) column plus an `ISBN` or `Title` column to bulk-tag existing
    books with where they physically live — handy if you've got a spreadsheet
    from sorting your shelves. It only updates books already in your library;
    it won't create new ones.
  - **Export** — downloads your whole library (location, tags, dates, rating,
    review text, description, date added, and cover URLs) as a single CSV
    file, at `GET /api/export/csv`. For a backup that also includes the
    actual image files for any manually-uploaded covers, use **"Export as
    ZIP"** instead (`GET /api/export/zip`) — restore it from the CSV tab's
    ZIP-restore section.

    **If you rebuild the container from scratch and restore from a backup
    each time** (rather than keeping the Docker volume persistent), the ZIP
    export/import is effectively your only persistence layer — so it's worth
    knowing exactly what does and doesn't round-trip:
    - Round-trips losslessly: title, author, ISBN, publisher, published
      date, page count, description, location, series, tags, status
      (including Planning to Read), owned, date added, date started, date
      finished, rating, review text, spoiler flag, and manually-uploaded
      cover images.
    - **Important limitation since Reading History was added:** the CSV/ZIP
      format is still one row per book, so Date Started/Date Finished/Rating/
      Review/Contains Spoilers in that row represent only the most recent (or
      currently in-progress) read-through — **older read-throughs from a
      book's full reading history are not included in the export and won't
      survive a wipe-and-restore cycle.** If you rely on the fresh-build
      workflow and have books with multiple logged reads, be aware that only
      the latest one persists across a rebuild right now. Exporting/restoring
      full multi-read history would need a format change (e.g. a separate
      `read_entries.csv` inside the ZIP) — happy to add that if it matters to
      your workflow.
    - Restoring always matches by this app's own `ID` column first, so a
      fresh empty database just creates every book anew — expected and fine
      for a wipe-and-restore cycle.
    - Anything not in the CSV/ZIP format isn't preserved across a wipe —
      if you add custom fields to `models.py` later, remember to also add
      them to `CSV_EXPORT_HEADER`/`_book_export_row` in `main.py` and to
      `map_backup_row` in `csv_import.py`, or they'll silently reset on your
      next fresh build.

    Notes on the CSV import mapping:
    - Read/finish dates are parsed flexibly; a bare `11/08/2026` is read as
      month/day/year (US-style) — if your export is day/month/year, dates near
      the start of the month may come out shifted. Fix any that land wrong from
      the book's edit modal.
    - Status is inferred: `currently_reading` wins if set, then a
      `dropped_dates` value means "did not finish", then a `Date Read` (or a
      "read" shelf) means "read", then a "to-read"/"want" shelf means "unread".
      (Restoring this app's own ZIP/CSV export instead reads an explicit
      Status column directly, so nothing is guessed on a round-trip.)
    - `tags`/`Bookshelves` columns become the book's tags (genres).

## Known browser quirks
- **Firefox date inputs (especially on Android)**: date fields need enough
  width for Firefox to render all three day/month/year segments — if one is
  squeezed into a narrow column it can become impossible to tap the day
  segment specifically. The reading-history add/edit form uses full-width date
  fields for this reason. If you still hit this anywhere, the fix is the
  same: give that `<input type="date">` its own full-width row rather than
  sharing a column with another field.

## Notes on bulk import at ~1000-book scale

The import endpoint looks up ISBNs one at a time with a short pause between each
call, to stay well within the free, key-less usage of Open Library/Google Books.
For very large batches (many hundreds), split the paste into a few chunks of a
few hundred ISBNs each rather than one giant paste — the request will otherwise
be open for several minutes, which some reverse proxies time out.

## Project layout

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

## Extending later
- The API is at `/api/*` (e.g. `/api/books`, `/api/import`, `/api/reviews`,
  `/api/tags`, `/api/export/csv`, `/api/export/zip`) if you ever want to script
  imports or build another client against it.
- `models.py` is a good place to add fields (e.g. series, loaned-to) — SQLite
  will need a migration step for new columns on an existing database. A small
  auto-migration already runs on startup for the `location` column, for moving
  the old `genre` text field into the new tags table, and for rebuilding the
  `books` table if it still has the old CHECK-constrained status column (which
  would otherwise block new status values like `planning`); follow the same
  pattern (`_run_migrations()` in `main.py`) for future schema changes. The
  `status` column is a plain `String`, not a SQLAlchemy `Enum`, specifically so
  adding another status value in `ReadStatus` (`models.py`) never needs another
  table rebuild — just add the member and update the frontend's option lists.
