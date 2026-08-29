const API = "/api";
let currentBooks = [];
let currentModalBookId = null;
let knownLocations = [];
let knownTags = [];
let knownSeries = [];
let selectedBookIds = new Set();
let shelfShuffled = true; // shelf opens in random order by default
let shelfCoverMode = localStorage.getItem("shelfCoverMode") === "full" ? "full" : "spine";
let shelfGroupMode = ["location", "series", "none"].includes(localStorage.getItem("shelfGroupMode"))
  ? localStorage.getItem("shelfGroupMode")
  : "location";

const STATUS_LABELS = {
  unread: "Unread",
  planning: "Planning to read",
  reading: "Reading",
  read: "Read",
  dnf: "Did not finish",
};

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

function stars(rating) {
  if (!rating) return '<span class="stars">—</span>';
  return `<span class="stars">${"★".repeat(rating)}${"☆".repeat(5 - rating)}</span>`;
}

function escapeHtml(str) {
  if (str == null) return "";
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function shuffleArray(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------- tabs ----------
document.getElementById("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  btn.classList.add("active");
  document.getElementById("view-" + btn.dataset.view).classList.add("active");
  if (btn.dataset.view === "shelf") loadShelf();
  if (btn.dataset.view === "library") loadLibrary();
  if (btn.dataset.view === "reviews") loadReviews();
  if (btn.dataset.view === "toread") loadToRead();
  if (btn.dataset.view === "toread") loadToRead();
});

// ---------- stats ----------
async function loadStats() {
  const s = await api("/stats");
  document.getElementById("stat-owned").textContent = s.owned;
  document.getElementById("stat-read").textContent = s.read;
  document.getElementById("stat-reading").textContent = s.reading;
}

// ---------- locations ----------
async function loadLocations() {
  knownLocations = await api("/locations");
  const datalist = document.getElementById("location-list");
  datalist.innerHTML = knownLocations.map((l) => `<option value="${escapeHtml(l)}"></option>`).join("");

  ["shelf-location-filter", "library-location-filter"].forEach((id) => {
    const sel = document.getElementById(id);
    const current = sel.value;
    sel.innerHTML = '<option value="">All locations</option>' +
      knownLocations.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("") +
      '<option value="__none__">Unsorted (no location)</option>';
    sel.value = current;
  });
}

// ---------- tags ----------
async function loadTags() {
  knownTags = await api("/tags");
  const datalist = document.getElementById("tag-list");
  datalist.innerHTML = knownTags.map((t) => `<option value="${escapeHtml(t)}"></option>`).join("");

  ["shelf-tag-filter", "library-tag-filter"].forEach((id) => {
    const sel = document.getElementById(id);
    const current = sel.value;
    sel.innerHTML = '<option value="">All genres/tags</option>' +
      knownTags.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
    sel.value = current;
  });
}

// ---------- series ----------
async function loadSeries() {
  knownSeries = await api("/series");
  const datalist = document.getElementById("series-list");
  datalist.innerHTML = knownSeries.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("");
}

// ---------- shelf view ----------
const SPINE_WIDTH = 34;
const SPINE_GAP = 3;
const COVER_WIDTH = 96;
const COVER_GAP = 10;
const SHELF_ROW_H_PADDING = 36; // 18px left + 18px right, from .shelf-row padding

function currentItemDims() {
  return shelfCoverMode === "full"
    ? { width: COVER_WIDTH, gap: COVER_GAP }
    : { width: SPINE_WIDTH, gap: SPINE_GAP };
}

function spinesPerRow(container) {
  const width = container.clientWidth || document.getElementById("shelf-container").clientWidth || 900;
  const { width: itemWidth, gap } = currentItemDims();
  const available = Math.max(width - SHELF_ROW_H_PADDING, itemWidth);
  const perItem = itemWidth + gap;
  return Math.max(4, Math.floor(available / perItem));
}

function buildShelfRows(container, books) {
  const perRow = spinesPerRow(container);
  const { gap } = currentItemDims();
  for (let i = 0; i < books.length; i += perRow) {
    const row = document.createElement("div");
    row.className = "shelf-row";
    row.style.gap = gap + "px";
    books.slice(i, i + perRow).forEach((b) => {
      const spine = document.createElement("div");
      const coverClass = shelfCoverMode === "full" ? " cover-mode" : "";
      spine.className = "spine status-" + b.status + (b.cover_url ? "" : " no-cover") + coverClass;
      if (b.cover_url) spine.style.backgroundImage = `url("${b.cover_url}")`;
      spine.title = `${b.title}${b.authors ? " — " + b.authors : ""}${b.location ? " · " + b.location : ""}`;
      if (!b.cover_url) {
        spine.innerHTML = `<span class="spine-title">${escapeHtml(b.title)}</span>`;
      }
      spine.addEventListener("click", () => openBookModal(b.id));
      row.appendChild(spine);
    });
    container.appendChild(row);
  }
}

document.querySelectorAll("#shelf-mode-toggle .mode-btn").forEach((btn) => {
  if (btn.dataset.mode === shelfCoverMode) btn.classList.add("active");
  else btn.classList.remove("active");
  btn.addEventListener("click", () => {
    shelfCoverMode = btn.dataset.mode;
    localStorage.setItem("shelfCoverMode", shelfCoverMode);
    document.querySelectorAll("#shelf-mode-toggle .mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
    loadShelf();
  });
});

window.addEventListener("resize", debounce(() => {
  if (document.getElementById("view-shelf").classList.contains("active")) loadShelf();
}, 250));

async function loadShelf() {
  const container = document.getElementById("shelf-container");
  container.innerHTML = '<p class="empty-note">Loading the shelf…</p>';
  const search = document.getElementById("shelf-search").value.trim();
  const status = document.getElementById("shelf-filter").value;
  const location = document.getElementById("shelf-location-filter").value;
  const tag = document.getElementById("shelf-tag-filter").value;
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  if (tag) params.set("tag", tag);
  let books = await api("/books?" + params.toString());
  if (shelfShuffled) books = shuffleArray(books);
  currentBooks = books;

  if (books.length === 0) {
    container.innerHTML = '<p class="empty-note">No books here yet. Add some from the Edit tab or the Accession tab.</p>';
    return;
  }

  container.innerHTML = "";

  if (location) {
    const filtered = location === "__none__"
      ? books.filter((b) => !b.location)
      : books.filter((b) => b.location === location);
    if (filtered.length === 0) {
      container.innerHTML = '<p class="empty-note">Nothing tagged with this location yet.</p>';
      return;
    }
    buildShelfRows(container, filtered);
    return;
  }

  if (shelfGroupMode === "none") {
    buildShelfRows(container, books);
    return;
  }

  // group by location or series, alphabetically, with the "none" bucket
  // last; order within each group follows the current shuffle/sort toggle
  const getKey = shelfGroupMode === "series"
    ? (b) => b.series || "__none__"
    : (b) => b.location || "__none__";
  const noneLabel = shelfGroupMode === "series" ? "No series" : "Unsorted";

  const groups = {};
  books.forEach((b) => {
    const key = getKey(b);
    (groups[key] = groups[key] || []).push(b);
  });
  const keys = Object.keys(groups).filter((k) => k !== "__none__").sort();
  if (groups["__none__"]) keys.push("__none__");

  keys.forEach((key) => {
    const heading = document.createElement("div");
    heading.className = "shelf-heading";
    heading.textContent = key === "__none__" ? noneLabel : key;
    container.appendChild(heading);
    buildShelfRows(container, groups[key]);
  });
}

document.getElementById("shelf-search").addEventListener("input", debounce(loadShelf, 300));
document.getElementById("shelf-filter").addEventListener("change", loadShelf);
document.getElementById("shelf-location-filter").addEventListener("change", loadShelf);
document.getElementById("shelf-tag-filter").addEventListener("change", loadShelf);
document.querySelectorAll("#shelf-group-toggle .mode-btn").forEach((btn) => {
  if (btn.dataset.group === shelfGroupMode) btn.classList.add("active");
  else btn.classList.remove("active");
  btn.addEventListener("click", () => {
    shelfGroupMode = btn.dataset.group;
    localStorage.setItem("shelfGroupMode", shelfGroupMode);
    document.querySelectorAll("#shelf-group-toggle .mode-btn").forEach((b) => b.classList.toggle("active", b === btn));
    loadShelf();
  });
});
document.getElementById("shelf-shuffle-btn").addEventListener("click", () => {
  shelfShuffled = !shelfShuffled;
  document.getElementById("shelf-shuffle-btn").textContent = shelfShuffled ? "Sort A–Z" : "🔀 Shuffle";
  loadShelf();
});

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- library view ----------
async function loadLibrary() {
  const body = document.getElementById("library-body");
  body.innerHTML = '<tr><td colspan="10" class="empty-note">Loading…</td></tr>';
  const search = document.getElementById("library-search").value.trim();
  const status = document.getElementById("library-filter").value;
  const location = document.getElementById("library-location-filter").value;
  const tag = document.getElementById("library-tag-filter").value;
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (status) params.set("status", status);
  if (tag) params.set("tag", tag);
  let books = await api("/books?" + params.toString());
  if (location) {
    books = location === "__none__" ? books.filter((b) => !b.location) : books.filter((b) => b.location === location);
  }
  if (document.getElementById("library-missing-cover").checked) {
    books = books.filter((b) => !b.cover_url);
  }
  currentBooks = books;

  if (books.length === 0) {
    body.innerHTML = '<tr><td colspan="10" class="empty-note">No books match. Try clearing filters.</td></tr>';
    updateBulkBar();
    return;
  }

  body.innerHTML = books.map((b) => `
    <tr>
      <td><input type="checkbox" class="row-check" data-id="${b.id}" ${selectedBookIds.has(b.id) ? "checked" : ""} /></td>
      <td class="title-cell" data-id="${b.id}">${escapeHtml(b.title)}</td>
      <td>${escapeHtml(b.authors || "—")}</td>
      <td>${escapeHtml(b.location || "—")}</td>
      <td class="tags-cell">${(b.tags || []).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("") || "—"}</td>
      <td><span class="status-pill ${b.status}">${STATUS_LABELS[b.status] || b.status}</span></td>
      <td>${b.date_started || "—"}</td>
      <td>${b.date_finished || "—"}</td>
      <td>${stars(b.rating)}</td>
      <td class="row-actions"><button data-del="${b.id}">Remove</button></td>
    </tr>
  `).join("");

  body.querySelectorAll(".title-cell").forEach((el) =>
    el.addEventListener("click", () => openBookModal(Number(el.dataset.id)))
  );
  body.querySelectorAll("[data-del]").forEach((el) =>
    el.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Remove this book from your library?")) return;
      await api(`/books/${el.dataset.del}`, { method: "DELETE" });
      selectedBookIds.delete(Number(el.dataset.del));
      loadLibrary();
      loadStats();
    })
  );
  body.querySelectorAll(".row-check").forEach((el) =>
    el.addEventListener("change", () => {
      const id = Number(el.dataset.id);
      if (el.checked) selectedBookIds.add(id); else selectedBookIds.delete(id);
      updateBulkBar();
    })
  );
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById("bulk-bar");
  const count = selectedBookIds.size;
  document.getElementById("bulk-count").textContent = `${count} selected`;
  bar.classList.toggle("hidden", count === 0);
  document.getElementById("select-all-checkbox").checked =
    currentBooks.length > 0 && currentBooks.every((b) => selectedBookIds.has(b.id));
}

document.getElementById("select-all-checkbox").addEventListener("change", (e) => {
  if (e.target.checked) currentBooks.forEach((b) => selectedBookIds.add(b.id));
  else currentBooks.forEach((b) => selectedBookIds.delete(b.id));
  loadLibrary();
});

document.getElementById("bulk-clear-btn").addEventListener("click", () => {
  selectedBookIds.clear();
  loadLibrary();
});

document.getElementById("bulk-apply-btn").addEventListener("click", async () => {
  const location = document.getElementById("bulk-location-input").value.trim();
  if (!location) { alert("Enter a location to apply."); return; }
  await api("/books/bulk-location", {
    method: "POST",
    body: JSON.stringify({ book_ids: Array.from(selectedBookIds), location }),
  });
  document.getElementById("bulk-location-input").value = "";
  selectedBookIds.clear();
  await loadLocations();
  loadLibrary();
});

document.getElementById("bulk-clear-location-btn").addEventListener("click", async () => {
  if (!confirm(`Clear the location field for ${selectedBookIds.size} selected book(s)?`)) return;
  await api("/books/bulk-location", {
    method: "POST",
    body: JSON.stringify({ book_ids: Array.from(selectedBookIds), location: null }),
  });
  selectedBookIds.clear();
  await loadLocations();
  loadLibrary();
});

document.getElementById("library-search").addEventListener("input", debounce(loadLibrary, 300));
document.getElementById("library-filter").addEventListener("change", loadLibrary);
document.getElementById("library-location-filter").addEventListener("change", loadLibrary);
document.getElementById("library-tag-filter").addEventListener("change", loadLibrary);
document.getElementById("library-missing-cover").addEventListener("change", loadLibrary);
document.getElementById("add-book-btn").addEventListener("click", () => openBookModal(null));

// ---------- reviews view ----------
async function loadReviews() {
  const container = document.getElementById("reviews-container");
  container.innerHTML = '<p class="empty-note">Loading reviews…</p>';
  const reviews = await api("/reviews");
  if (reviews.length === 0) {
    container.innerHTML = '<p class="empty-note">No reviews written yet. Open any book and add one.</p>';
    return;
  }
  container.innerHTML = reviews.map((r) => `
    <div class="review-card" data-id="${r.book.id}">
      <h3>${escapeHtml(r.book.title)} ${stars(r.book.rating)}</h3>
      <div class="review-meta">${escapeHtml(r.book.authors || "")} · updated ${new Date(r.updated_at).toLocaleDateString()} ${r.contains_spoilers ? '<span class="spoiler-tag">· contains spoilers</span>' : ""}</div>
      <div class="review-text">${escapeHtml(r.review_text)}</div>
    </div>
  `).join("");
  container.querySelectorAll(".review-card").forEach((el) =>
    el.addEventListener("click", () => openBookModal(Number(el.dataset.id), "review"))
  );
}

// ---------- to read view ----------
async function loadToRead() {
  const body = document.getElementById("toread-body");
  body.innerHTML = '<tr><td colspan="5" class="empty-note">Loading…</td></tr>';
  const search = document.getElementById("toread-search").value.trim().toLowerCase();

  const [reading, planning] = await Promise.all([
    api("/books?status=reading"),
    api("/books?status=planning"),
  ]);
  let books = [...reading, ...planning].sort((a, b) => a.title.localeCompare(b.title));
  if (search) {
    books = books.filter((b) =>
      b.title.toLowerCase().includes(search) || (b.authors || "").toLowerCase().includes(search)
    );
  }

  if (books.length === 0) {
    body.innerHTML = '<tr><td colspan="5" class="empty-note">Nothing here yet — mark a book Reading or Planning to Read from its edit modal.</td></tr>';
    return;
  }

  body.innerHTML = books.map((b) => `
    <tr>
      <td class="title-cell" data-id="${b.id}">${escapeHtml(b.title)}</td>
      <td>${escapeHtml(b.authors || "—")}</td>
      <td><span class="status-pill ${b.status}">${STATUS_LABELS[b.status] || b.status}</span></td>
      <td class="tags-cell">${(b.tags || []).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("") || "—"}</td>
      <td>${escapeHtml(b.location || "—")}</td>
    </tr>
  `).join("");

  body.querySelectorAll(".title-cell").forEach((el) =>
    el.addEventListener("click", () => openBookModal(Number(el.dataset.id)))
  );
}

document.getElementById("toread-search").addEventListener("input", debounce(loadToRead, 300));

// ---------- import view ----------
document.getElementById("import-btn").addEventListener("click", async () => {
  const raw = document.getElementById("isbn-input").value;
  const isbns = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (isbns.length === 0) return;
  const progress = document.getElementById("import-progress");
  const resultsEl = document.getElementById("import-results");
  const btn = document.getElementById("import-btn");
  btn.disabled = true;
  progress.textContent = `Looking up ${isbns.length} ISBN(s)… this can take a moment.`;
  resultsEl.innerHTML = "";
  try {
    const result = await api("/import", { method: "POST", body: JSON.stringify({ isbns }) });
    progress.textContent = "Done.";
    const lines = [];
    result.added.forEach((b) => lines.push(`<div class="result-line added">✓ Added — ${escapeHtml(b.title)}</div>`));
    result.duplicates.forEach((isbn) => lines.push(`<div class="result-line dup">· Already in library — ${isbn}</div>`));
    result.not_found.forEach((isbn) => lines.push(`<div class="result-line notfound">✗ No metadata found — ${isbn}</div>`));
    (result.errors || []).forEach((e) => lines.push(`<div class="result-line notfound">✗ Error on ${e.isbn} — ${escapeHtml(e.error)}</div>`));
    resultsEl.innerHTML = lines.join("");
    document.getElementById("isbn-input").value = "";
    loadStats();
  } catch (err) {
    progress.textContent = "Import failed: " + err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- import sub-tabs ----------
document.querySelectorAll(".itab").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll(".itab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    document.querySelectorAll(".itab-pane").forEach((p) => (p.style.display = "none"));
    document.getElementById("itab-" + t.dataset.itab).style.display = "block";
  })
);

// ---------- CSV import ----------
document.getElementById("csv-import-btn").addEventListener("click", async () => {
  const fileInput = document.getElementById("csv-file-input");
  const file = fileInput.files[0];
  if (!file) { alert("Choose a CSV/TSV file first."); return; }
  const enrich = document.getElementById("csv-enrich-checkbox").checked;
  const progress = document.getElementById("csv-import-progress");
  const resultsEl = document.getElementById("csv-import-results");
  const btn = document.getElementById("csv-import-btn");

  const form = new FormData();
  form.append("file", file);
  form.append("enrich", enrich ? "true" : "false");

  btn.disabled = true;
  progress.textContent = "Importing… this can take a moment for large files.";
  resultsEl.innerHTML = "";

  try {
    const res = await fetch(API + "/import/csv", { method: "POST", body: form });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.detail || res.statusText);
    }
    const result = await res.json();
    progress.textContent = "Done.";
    const lines = [];
    result.updated.forEach((b) => lines.push(`<div class="result-line added">✓ Updated — ${escapeHtml(b.title)} (${b.status}${b.date_finished ? ", finished " + b.date_finished : ""})</div>`));
    result.added.forEach((b) => lines.push(`<div class="result-line added">✓ Added — ${escapeHtml(b.title)}</div>`));
    (result.ambiguous || []).forEach((r) => lines.push(`<div class="result-line notfound">⚠ Ambiguous — ${escapeHtml(r.reason)} (${escapeHtml(r.row.Title || "")})</div>`));
    (result.mismatched || []).forEach((r) => lines.push(`<div class="result-line notfound">⚠ Mismatch — ${escapeHtml(r.reason)}</div>`));
    (result.skipped || []).forEach((s) => lines.push(`<div class="result-line notfound">✗ Skipped — ${s.reason}</div>`));
    if (result.isbn_corrupted_count) {
      lines.unshift(`<div class="result-line notfound">⚠ ${result.isbn_corrupted_count} row(s) had an ISBN mangled into scientific notation (likely from opening the CSV in Excel/Sheets) — those ISBNs were left untouched rather than overwritten with corrupted data. Matching still worked via the ID column.</div>`);
    }
    resultsEl.innerHTML = lines.join("") || '<div class="result-line dup">No rows processed.</div>';
    fileInput.value = "";
    loadStats();
    loadLocations();
    loadTags();
    loadSeries();
  } catch (err) {
    progress.textContent = "Import failed: " + err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- location import ----------
document.getElementById("loc-import-btn").addEventListener("click", async () => {
  const fileInput = document.getElementById("loc-file-input");
  const file = fileInput.files[0];
  if (!file) { alert("Choose a CSV/TSV file first."); return; }
  const progress = document.getElementById("loc-import-progress");
  const resultsEl = document.getElementById("loc-import-results");
  const btn = document.getElementById("loc-import-btn");

  const form = new FormData();
  form.append("file", file);

  btn.disabled = true;
  progress.textContent = "Importing locations…";
  resultsEl.innerHTML = "";

  try {
    const res = await fetch(API + "/import/locations", { method: "POST", body: form });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.detail || res.statusText);
    }
    const result = await res.json();
    progress.textContent = "Done.";
    const lines = [];
    result.updated.forEach((b) => lines.push(`<div class="result-line added">✓ ${escapeHtml(b.title)} → ${escapeHtml(b.location)}</div>`));
    (result.mismatched || []).forEach((r) => lines.push(`<div class="result-line notfound">⚠ Mismatch — ${escapeHtml(r.reason)}</div>`));
    (result.ambiguous || []).forEach((r) => lines.push(`<div class="result-line notfound">⚠ Ambiguous — ${escapeHtml(r.reason)} (${escapeHtml(r.row.Title || "")})</div>`));
    result.not_found.forEach((row) => lines.push(`<div class="result-line notfound">✗ No matching book — ${escapeHtml(row.Title || row.ISBN || row.isbn13 || JSON.stringify(row))}</div>`));
    result.skipped.forEach((s) => lines.push(`<div class="result-line notfound">✗ Skipped — ${s.reason}</div>`));
    resultsEl.innerHTML = lines.join("") || '<div class="result-line dup">No rows processed.</div>';
    fileInput.value = "";
    loadLocations();
  } catch (err) {
    progress.textContent = "Import failed: " + err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- CSV export ----------
document.getElementById("export-csv-btn").addEventListener("click", () => {
  window.location.href = API + "/export/csv";
});

// ---------- ZIP export (includes cover images) ----------
document.getElementById("export-zip-btn").addEventListener("click", () => {
  window.location.href = API + "/export/zip";
});

// ---------- ZIP restore ----------
document.getElementById("zip-import-btn").addEventListener("click", async () => {
  const fileInput = document.getElementById("zip-file-input");
  const file = fileInput.files[0];
  if (!file) { alert("Choose a .zip backup file first."); return; }
  const progress = document.getElementById("zip-import-progress");
  const resultsEl = document.getElementById("zip-import-results");
  const btn = document.getElementById("zip-import-btn");

  const form = new FormData();
  form.append("file", file);

  btn.disabled = true;
  progress.textContent = "Restoring… this can take a moment for large backups.";
  resultsEl.innerHTML = "";

  try {
    const res = await fetch(API + "/import/zip", { method: "POST", body: form });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.detail || res.statusText);
    }
    const result = await res.json();
    progress.textContent = `Done — ${result.covers_restored} cover image(s) restored.`;
    const lines = [];
    result.updated.forEach((b) => lines.push(`<div class="result-line added">✓ Updated — ${escapeHtml(b.title)}</div>`));
    result.added.forEach((b) => lines.push(`<div class="result-line added">✓ Added — ${escapeHtml(b.title)}</div>`));
    (result.mismatched || []).forEach((r) => lines.push(`<div class="result-line notfound">⚠ Mismatch — ${escapeHtml(r.reason)}</div>`));
    (result.ambiguous || []).forEach((r) => lines.push(`<div class="result-line notfound">⚠ Ambiguous — ${escapeHtml(r.reason)}</div>`));
    if (result.isbn_corrupted_count) {
      lines.unshift(`<div class="result-line notfound">⚠ ${result.isbn_corrupted_count} row(s) had an ISBN mangled into scientific notation (likely from opening the CSV in Excel/Sheets) — those ISBNs were left untouched rather than overwritten with corrupted data. Matching still worked via the ID column.</div>`);
    }
    resultsEl.innerHTML = lines.join("") || '<div class="result-line dup">No rows processed.</div>';
    fileInput.value = "";
    loadStats();
    loadLocations();
    loadTags();
    loadSeries();
  } catch (err) {
    progress.textContent = "Restore failed: " + err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- modal ----------
const modalOverlay = document.getElementById("book-modal");
const modalBody = document.getElementById("modal-body");
document.getElementById("modal-close").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function closeModal() {
  modalOverlay.classList.add("hidden");
  currentModalBookId = null;
  refreshCurrentView();
}

function refreshCurrentView() {
  const active = document.querySelector(".tab.active").dataset.view;
  if (active === "shelf") loadShelf();
  if (active === "library") loadLibrary();
  if (active === "reviews") loadReviews();
  if (active === "toread") loadToRead();
  loadStats();
  loadLocations();
  loadTags();
  loadSeries();
}

async function openBookModal(bookId, initialTab = "details") {
  currentModalBookId = bookId;
  modalOverlay.classList.remove("hidden");
  modalBody.innerHTML = '<p class="empty-note">Loading…</p>';

  if (bookId === null) {
    renderAddBookForm();
    return;
  }

  const book = await api(`/books/${bookId}`);
  const review = await api(`/books/${bookId}/review`);
  renderBookModal(book, review, initialTab);
}

function renderAddBookForm() {
  modalBody.innerHTML = `
    <h2>Add a book</h2>
    <div class="form-grid">
      <label class="full">ISBN (optional — auto-fills details)
        <div style="display:flex; gap:8px;">
          <input type="text" id="f-isbn" placeholder="9780141439518" />
          <button class="btn-secondary" id="lookup-btn" type="button">Look up</button>
        </div>
      </label>
      <label class="full">Title
        <input type="text" id="f-title" required />
      </label>
      <label class="full">Author(s)
        <input type="text" id="f-authors" />
      </label>
      <label>Cover URL
        <input type="text" id="f-cover" />
      </label>
      <label>Location
        <input type="text" id="f-location" list="location-list" placeholder="e.g. Living Room — Shelf 3" />
      </label>
      <label>Series
        <input type="text" id="f-series" list="series-list" placeholder="e.g. Mistborn" />
      </label>
      <label class="full">Genres / tags
        <input type="text" id="f-tags" list="tag-list" placeholder="Fantasy, Adult, Comics" />
      </label>
      <label>Status
        <select id="f-status">
          <option value="unread">Unread</option>
          <option value="planning">Planning to read</option>
          <option value="reading">Reading</option>
          <option value="read">Read</option>
          <option value="dnf">Did not finish</option>
        </select>
      </label>
    </div>
    <div class="modal-actions">
      <span></span>
      <button class="btn-primary" id="save-new-btn">Add to library</button>
    </div>
  `;

  document.getElementById("lookup-btn").addEventListener("click", async () => {
    const isbn = document.getElementById("f-isbn").value.trim();
    if (!isbn) return;
    const btn = document.getElementById("lookup-btn");
    btn.disabled = true; btn.textContent = "Looking up…";
    try {
      const meta = await api(`/books/lookup/${encodeURIComponent(isbn)}`);
      document.getElementById("f-title").value = meta.title || "";
      document.getElementById("f-authors").value = meta.authors || "";
      document.getElementById("f-cover").value = meta.cover_url || "";
      if (meta.series) document.getElementById("f-series").value = meta.series;
    } catch (err) {
      alert("Lookup failed: " + err.message);
    } finally {
      btn.disabled = false; btn.textContent = "Look up";
    }
  });

  document.getElementById("save-new-btn").addEventListener("click", async () => {
    const title = document.getElementById("f-title").value.trim();
    if (!title) { alert("Title is required."); return; }
    const payload = {
      isbn: document.getElementById("f-isbn").value.trim() || null,
      title,
      authors: document.getElementById("f-authors").value.trim() || null,
      cover_url: document.getElementById("f-cover").value.trim() || null,
      location: document.getElementById("f-location").value.trim() || null,
      series: document.getElementById("f-series").value.trim() || null,
      tags: document.getElementById("f-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      status: document.getElementById("f-status").value,
      owned: true,
    };
    await api("/books", { method: "POST", body: JSON.stringify(payload) });
    closeModal();
  });
}

function renderBookModal(book, review, initialTab) {
  modalBody.innerHTML = `
    <div class="mb-header">
      <img class="mb-cover" src="${book.cover_url || ""}" onerror="this.style.visibility='hidden'" />
      <div>
        <div class="mb-title">${escapeHtml(book.title)}</div>
        <div class="mb-authors">${escapeHtml(book.authors || "Unknown author")}</div>
        <div class="mb-meta">
          ${book.isbn ? "ISBN " + escapeHtml(book.isbn) + "<br/>" : ""}
          ${book.publisher ? escapeHtml(book.publisher) + " " : ""}${book.published_date ? escapeHtml(book.published_date) : ""}<br/>
          ${book.page_count ? book.page_count + " pages" : ""}
        </div>
        ${(book.tags || []).length ? `<div class="mb-tags">${book.tags.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
      </div>
    </div>

    <div class="tab-strip">
      <button class="mtab active" data-mtab="details">Details</button>
      <button class="mtab" data-mtab="review">Review</button>
    </div>

    <div id="mtab-details" class="mtab-pane">
      <div class="form-grid">
        <label class="full">Title
          <input type="text" id="e-title" value="${escapeHtml(book.title || "")}" />
        </label>
        <label class="full">Author(s)
          <input type="text" id="e-authors" value="${escapeHtml(book.authors || "")}" placeholder="e.g. Brandon Sanderson" />
        </label>
        <label class="full">Location
          <input type="text" id="e-location" list="location-list" value="${escapeHtml(book.location || "")}" placeholder="e.g. Living Room — Shelf 3" />
        </label>
        <label class="full">Series
          <input type="text" id="e-series" list="series-list" value="${escapeHtml(book.series || "")}" placeholder="e.g. Mistborn" />
        </label>
        <label class="full">Cover
          <div style="display:flex; align-items:center; gap:10px;">
            <input type="file" id="e-cover-file" accept="image/jpeg,image/png,image/webp,image/gif" style="flex:1;" />
            <button class="btn-secondary" id="e-cover-upload-btn" type="button">Upload</button>
            ${book.cover_url ? `<button class="btn-danger" id="e-cover-remove-btn" type="button">Remove</button>` : ""}
          </div>
          <span id="e-cover-status" style="font-size:12px; color:var(--parchment-dim); margin-top:4px;">JPG, PNG, WEBP, or GIF — up to 12 MB</span>
        </label>
        <label class="full">Genres / tags
          <input type="text" id="e-tags" list="tag-list" value="${escapeHtml((book.tags || []).join(", "))}" placeholder="Fantasy, Adult, Comics" />
        </label>
        <label>Status
          <select id="e-status">
            ${["unread", "planning", "reading", "read", "dnf"].map((s) => `<option value="${s}" ${book.status === s ? "selected" : ""}>${STATUS_LABELS[s]}</option>`).join("")}
          </select>
        </label>
        <label>Owned
          <select id="e-owned">
            <option value="true" ${book.owned ? "selected" : ""}>Yes</option>
            <option value="false" ${!book.owned ? "selected" : ""}>No</option>
          </select>
        </label>
        <label>Started
          <input type="date" id="e-started" value="${book.date_started || ""}" />
        </label>
        <label>Finished
          <input type="date" id="e-finished" value="${book.date_finished || ""}" />
        </label>
        <label class="full">Rating
          <div class="rating-input" id="e-rating" data-value="${book.rating || 0}">
            ${[1,2,3,4,5].map((n) => `<span data-star="${n}" class="${book.rating >= n ? "active" : ""}">★</span>`).join("")}
          </div>
        </label>
      </div>
      <div class="modal-actions">
        <button class="btn-danger" id="delete-book-btn">Remove book</button>
        <button class="btn-primary" id="save-book-btn">Save changes</button>
      </div>
    </div>

    <div id="mtab-review" class="mtab-pane" style="display:none;">
      <textarea class="review-textarea" id="e-review-text" placeholder="What did you think?">${escapeHtml(review?.review_text || "")}</textarea>
      <label style="display:flex; align-items:center; gap:8px; margin-top:10px; font-size:13px; color:var(--parchment-dim);">
        <input type="checkbox" id="e-review-spoilers" ${review?.contains_spoilers ? "checked" : ""} style="width:auto;" />
        Contains spoilers
      </label>
      <div class="modal-actions">
        <span></span>
        <button class="btn-primary" id="save-review-btn">Save review</button>
      </div>
    </div>
  `;

  // tab switching inside modal
  modalBody.querySelectorAll(".mtab").forEach((t) =>
    t.addEventListener("click", () => {
      modalBody.querySelectorAll(".mtab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      modalBody.querySelectorAll(".mtab-pane").forEach((p) => (p.style.display = "none"));
      document.getElementById("mtab-" + t.dataset.mtab).style.display = "block";
    })
  );
  if (initialTab === "review") modalBody.querySelector('[data-mtab="review"]').click();

  // cover upload / removal
  document.getElementById("e-cover-upload-btn").addEventListener("click", async () => {
    const fileInput = document.getElementById("e-cover-file");
    const file = fileInput.files[0];
    if (!file) { alert("Choose an image file first."); return; }
    const status = document.getElementById("e-cover-status");
    status.textContent = "Uploading…";
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(`${API}/books/${book.id}/cover`, { method: "POST", body: form });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail || res.statusText);
      }
      const updated = await res.json();
      status.textContent = "Cover updated.";
      book.cover_url = updated.cover_url;
      renderBookModal(book, review, "details");
    } catch (err) {
      status.textContent = "Upload failed: " + err.message;
    }
  });

  const removeCoverBtn = document.getElementById("e-cover-remove-btn");
  if (removeCoverBtn) {
    removeCoverBtn.addEventListener("click", async () => {
      if (!confirm("Remove this book's cover image?")) return;
      const updated = await api(`/books/${book.id}/cover`, { method: "DELETE" });
      book.cover_url = updated.cover_url;
      renderBookModal(book, review, "details");
    });
  }

  // star rating
  const ratingEl = document.getElementById("e-rating");
  ratingEl.querySelectorAll("span").forEach((s) =>
    s.addEventListener("click", () => {
      const v = Number(s.dataset.star);
      ratingEl.dataset.value = ratingEl.dataset.value === String(v) ? "0" : String(v);
      const active = Number(ratingEl.dataset.value);
      ratingEl.querySelectorAll("span").forEach((x) => x.classList.toggle("active", Number(x.dataset.star) <= active));
    })
  );

  document.getElementById("save-book-btn").addEventListener("click", async () => {
    const title = document.getElementById("e-title").value.trim();
    if (!title) { alert("Title is required."); return; }
    const payload = {
      title,
      authors: document.getElementById("e-authors").value.trim() || null,
      status: document.getElementById("e-status").value,
      owned: document.getElementById("e-owned").value === "true",
      date_started: document.getElementById("e-started").value || null,
      date_finished: document.getElementById("e-finished").value || null,
      rating: Number(ratingEl.dataset.value) || null,
      location: document.getElementById("e-location").value.trim() || null,
      series: document.getElementById("e-series").value.trim() || null,
      tags: document.getElementById("e-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
    };
    await api(`/books/${book.id}`, { method: "PUT", body: JSON.stringify(payload) });
    closeModal();
  });

  document.getElementById("delete-book-btn").addEventListener("click", async () => {
    if (!confirm(`Remove "${book.title}" from your library?`)) return;
    await api(`/books/${book.id}`, { method: "DELETE" });
    closeModal();
  });

  document.getElementById("save-review-btn").addEventListener("click", async () => {
    const payload = {
      review_text: document.getElementById("e-review-text").value,
      contains_spoilers: document.getElementById("e-review-spoilers").checked,
    };
    await api(`/books/${book.id}/review`, { method: "PUT", body: JSON.stringify(payload) });
    closeModal();
  });
}

// ---------- init ----------
loadStats();
loadLocations();
loadTags();
loadSeries();
loadShelf();
