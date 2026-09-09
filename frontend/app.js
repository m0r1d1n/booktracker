const API = "/api";
let currentBooks = [];
let currentModalBookId = null;
let currentModalBook = null;
let currentEntries = [];
let knownLocations = [];
let knownTags = [];
let knownSeries = [];
let knownAuthors = [];
let selectedBookIds = new Set();
let shelfSortMode = ["shuffle", "title", "author", "series"].includes(localStorage.getItem("shelfSortMode"))
  ? localStorage.getItem("shelfSortMode")
  : "shuffle"; // shelf opens in random order by default
let shelfCoverMode = localStorage.getItem("shelfCoverMode") === "full" ? "full" : "spine";
let shelfGroupMode = ["location", "series", "author", "none"].includes(localStorage.getItem("shelfGroupMode"))
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

let _starWidgetCounter = 0;
function stars(rating) {
  if (!rating) return '<span class="stars">—</span>';
  return starWidgetHtml(`stars-inline-${_starWidgetCounter++}`, rating, false);
}

// ---------- half-star rating widget (shared by entry cards, Reviews, and
// the read-entry add/edit form) ----------
function starWidgetHtml(id, value, editable) {
  const v = value || 0;
  let html = `<div class="star-widget${editable ? " editable" : ""}" id="${id}" data-value="${v}">`;
  for (let i = 1; i <= 5; i++) {
    const fillPct = v >= i ? 100 : v >= i - 0.5 ? 50 : 0;
    html += `<span class="star-pos" data-pos="${i}">
      <span class="star-bg">★</span>
      <span class="star-fg" style="width:${fillPct}%">★</span>
    </span>`;
  }
  html += `</div>`;
  return html;
}

function wireStarWidget(id) {
  const container = document.getElementById(id);
  if (!container) return;
  container.querySelectorAll(".star-pos").forEach((pos) => {
    pos.addEventListener("click", (event) => {
      const rect = pos.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      const isLeftHalf = clickX < rect.width / 2;
      const i = Number(pos.dataset.pos);
      const newVal = isLeftHalf ? i - 0.5 : i;
      const current = Number(container.dataset.value);
      const finalVal = current === newVal ? 0 : newVal;
      container.dataset.value = finalVal;
      container.querySelectorAll(".star-pos").forEach((p) => {
        const pi = Number(p.dataset.pos);
        const fillPct = finalVal >= pi ? 100 : finalVal >= pi - 0.5 ? 50 : 0;
        p.querySelector(".star-fg").style.width = fillPct + "%";
      });
    });
  });
}

function isValidCalendarDate(y, mo, d) {
  const yy = Number(y), mm = Number(mo), dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  const dt = new Date(yy, mm - 1, dd);
  return dt.getFullYear() === yy && dt.getMonth() === mm - 1 && dt.getDate() === dd;
}

// Accepts common date formats a person might type (not just strict ISO) and
// normalizes to YYYY-MM-DD, or returns null if it can't be parsed as a real
// calendar date. Used instead of relying on a native <input type="date">
// picker, whose day-segment can become unreachable in some Firefox layouts.
function parseLenientDate(str) {
  if (!str || !str.trim()) return null;
  const s = str.trim();
  let m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/); // YYYY-MM-DD or YYYY/MM/DD
  if (m) {
    const [, y, mo, d] = m;
    return isValidCalendarDate(y, mo, d) ? `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}` : null;
  }
  m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/); // MM/DD/YYYY (or MM-DD-YYYY)
  if (m) {
    const [, mo, d, y] = m;
    return isValidCalendarDate(y, mo, d) ? `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}` : null;
  }
  return null;
}

// ---------- self-contained calendar picker ----------
// A native <input type="date"> proved unreliable in Firefox (day segment
// unreachable even at full width), so this is a plain HTML/CSS/JS calendar
// grid instead — no dependency on any browser's native date-picker widget,
// so it behaves identically everywhere. It's an optional convenience
// alongside the always-available YYYY-MM-DD text field, never the only way
// to set a date.
let openDatePickerEl = null;

function closeDatePicker() {
  if (openDatePickerEl) {
    openDatePickerEl.remove();
    openDatePickerEl = null;
  }
}

function openDatePickerFor(targetInputId, anchorBtn) {
  closeDatePicker();
  const input = document.getElementById(targetInputId);
  const parsed = parseLenientDate(input.value);
  const base = parsed ? new Date(parsed + "T00:00:00") : new Date();
  let viewYear = base.getFullYear();
  let viewMonth = base.getMonth();

  const popover = document.createElement("div");
  popover.className = "date-picker-popover";

  function render() {
    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const startWeekday = firstOfMonth.getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

    let cells = "";
    for (let i = 0; i < startWeekday; i++) cells += `<span class="dp-cell dp-empty"></span>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const isSelected = parsed === iso;
      cells += `<button type="button" class="dp-cell dp-day${isSelected ? " dp-selected" : ""}" data-date="${iso}">${d}</button>`;
    }

    popover.innerHTML = `
      <div class="dp-header">
        <button type="button" class="dp-nav" data-nav="prev-year" aria-label="Previous year">«</button>
        <button type="button" class="dp-nav" data-nav="prev-month" aria-label="Previous month">‹</button>
        <span class="dp-title">${monthNames[viewMonth]} ${viewYear}</span>
        <button type="button" class="dp-nav" data-nav="next-month" aria-label="Next month">›</button>
        <button type="button" class="dp-nav" data-nav="next-year" aria-label="Next year">»</button>
      </div>
      <div class="dp-weekdays"><span>Su</span><span>Mo</span><span>Tu</span><span>We</span><span>Th</span><span>Fr</span><span>Sa</span></div>
      <div class="dp-grid">${cells}</div>
      <div class="dp-footer">
        <button type="button" class="btn-secondary dp-today">Today</button>
        <button type="button" class="btn-secondary dp-clear">Clear</button>
      </div>
    `;

    popover.querySelectorAll("[data-nav]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const nav = btn.dataset.nav;
        if (nav === "prev-month") { viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } }
        if (nav === "next-month") { viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } }
        if (nav === "prev-year") viewYear--;
        if (nav === "next-year") viewYear++;
        render();
      });
    });
    popover.querySelectorAll(".dp-day").forEach((cell) => {
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        input.value = cell.dataset.date;
        closeDatePicker();
      });
    });
    popover.querySelector(".dp-today").addEventListener("click", (e) => {
      e.stopPropagation();
      const today = new Date();
      input.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      closeDatePicker();
    });
    popover.querySelector(".dp-clear").addEventListener("click", (e) => {
      e.stopPropagation();
      input.value = "";
      closeDatePicker();
    });
  }

  render();
  popover.addEventListener("click", (e) => e.stopPropagation());
  document.body.appendChild(popover);

  const rect = anchorBtn.getBoundingClientRect();
  const popoverWidth = 260;
  const estimatedHeight = 320;
  let top = rect.bottom + 6;
  if (top + estimatedHeight > window.innerHeight) {
    top = Math.max(8, rect.top - estimatedHeight - 6);
  }
  popover.style.top = `${top}px`;
  popover.style.left = `${Math.max(8, Math.min(rect.right - popoverWidth, window.innerWidth - popoverWidth - 8))}px`;

  openDatePickerEl = popover;
}

document.addEventListener("click", () => closeDatePicker());

function wireDatePickerButtons(scopeEl) {
  scopeEl.querySelectorAll(".date-picker-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDatePickerFor(btn.dataset.target, btn);
    });
  });
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

// Applies the current global sort mode. "author"/"series" sort the whole
// list by that field (falling back to title as a tiebreaker, and sorting
// blanks last) — this is what lets Flat grouping show one continuous shelf
// ordered by author/series instead of a separate header per author/series,
// which otherwise produces a lot of single-book shelves.
function applySortMode(books) {
  if (shelfSortMode === "shuffle") return shuffleArray(books);
  const key = shelfSortMode === "author" ? "authors" : shelfSortMode === "series" ? "series" : null;
  return [...books].sort((a, b) => {
    if (key) {
      const av = a[key] || "";
      const bv = b[key] || "";
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      const cmp = av.localeCompare(bv);
      if (cmp !== 0) return cmp;
    }
    return a.title.localeCompare(b.title);
  });
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
  if (btn.dataset.view === "reading") loadReadingShelf();
  if (btn.dataset.view === "toread") loadToReadShelf();
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

// ---------- authors ----------
async function loadAuthors() {
  knownAuthors = await api("/authors");
  const datalist = document.getElementById("author-list");
  datalist.innerHTML = knownAuthors.map((a) => `<option value="${escapeHtml(a)}"></option>`).join("");
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
    syncAllCoverModeButtons();
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
  books = applySortMode(books);
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

  // group by location, series, or author, alphabetically, with the "none"
  // bucket last; order within each group follows the current shuffle/sort
  // toggle above
  const GROUP_KEY_FNS = {
    series: (b) => b.series || "__none__",
    author: (b) => b.authors || "__none__",
    location: (b) => b.location || "__none__",
  };
  const NONE_LABELS = {
    series: "No series",
    author: "Unknown author",
    location: "Unsorted",
  };
  const getKey = GROUP_KEY_FNS[shelfGroupMode] || GROUP_KEY_FNS.location;
  const noneLabel = NONE_LABELS[shelfGroupMode] || NONE_LABELS.location;

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
document.getElementById("shelf-sort-select").addEventListener("change", (e) => {
  shelfSortMode = e.target.value;
  localStorage.setItem("shelfSortMode", shelfSortMode);
  syncAllSortSelects();
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

const BULK_FIELD_CONFIG = {
  location: { datalist: "location-list", placeholder: "Set location…" },
  series: { datalist: "series-list", placeholder: "Set series…" },
  authors: { datalist: "author-list", placeholder: "Set author(s)…" },
  tags: { datalist: "tag-list", placeholder: "Add tag(s), comma-separated…" },
};

function syncBulkFieldUI() {
  const field = document.getElementById("bulk-field-select").value;
  const config = BULK_FIELD_CONFIG[field];
  const valueInput = document.getElementById("bulk-value-input");
  valueInput.setAttribute("list", config.datalist);
  valueInput.placeholder = config.placeholder;
  document.getElementById("bulk-tags-mode").style.display = field === "tags" ? "" : "none";
}

document.getElementById("bulk-field-select").addEventListener("change", syncBulkFieldUI);
syncBulkFieldUI();

async function refreshBulkDatalists() {
  await Promise.all([loadLocations(), loadSeries(), loadAuthors(), loadTags()]);
}

document.getElementById("bulk-apply-btn").addEventListener("click", async () => {
  const field = document.getElementById("bulk-field-select").value;
  const rawValue = document.getElementById("bulk-value-input").value.trim();
  if (!rawValue) { alert("Enter a value to apply."); return; }

  if (field === "tags") {
    const mode = document.getElementById("bulk-tags-mode").value;
    const tags = rawValue.split(",").map((t) => t.trim()).filter(Boolean);
    await api("/books/bulk-tags", {
      method: "POST",
      body: JSON.stringify({ book_ids: Array.from(selectedBookIds), tags, mode }),
    });
  } else {
    await api("/books/bulk-field", {
      method: "POST",
      body: JSON.stringify({ book_ids: Array.from(selectedBookIds), field, value: rawValue }),
    });
  }
  document.getElementById("bulk-value-input").value = "";
  selectedBookIds.clear();
  await refreshBulkDatalists();
  loadLibrary();
});

document.getElementById("bulk-clear-field-btn").addEventListener("click", async () => {
  const field = document.getElementById("bulk-field-select").value;
  const fieldLabel = document.getElementById("bulk-field-select").selectedOptions[0].text;
  if (!confirm(`Clear ${fieldLabel} for ${selectedBookIds.size} selected book(s)?`)) return;

  if (field === "tags") {
    await api("/books/bulk-tags", {
      method: "POST",
      body: JSON.stringify({ book_ids: Array.from(selectedBookIds), tags: [], mode: "replace" }),
    });
  } else {
    await api("/books/bulk-field", {
      method: "POST",
      body: JSON.stringify({ book_ids: Array.from(selectedBookIds), field, value: null }),
    });
  }
  selectedBookIds.clear();
  await refreshBulkDatalists();
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
  const entries = await api("/reviews");
  if (entries.length === 0) {
    container.innerHTML = '<p class="empty-note">No reviews written yet. Open any book and add one from its Reading History tab.</p>';
    return;
  }
  container.innerHTML = entries.map((e) => `
    <div class="review-card" data-id="${e.book.id}">
      <h3>${escapeHtml(e.book.title)} ${starWidgetHtml("review-stars-" + e.id, e.rating, false)}</h3>
      <div class="review-meta">${escapeHtml(e.book.authors || "")} · ${formatEntryDateRange(e)} · updated ${new Date(e.updated_at).toLocaleDateString()} ${e.contains_spoilers ? '<span class="spoiler-tag">· contains spoilers</span>' : ""}</div>
      <div class="review-text">${escapeHtml(e.review_text)}</div>
    </div>
  `).join("");
  container.querySelectorAll(".review-card").forEach((el) =>
    el.addEventListener("click", () => openBookModal(Number(el.dataset.id), "history"))
  );
}

// ---------- to read view ----------
// ---------- Reading / To Read shelf-style views ----------
// Reuses the same visual shelf/spine rendering as the Library page (buildShelfRows,
// the global Spines/Full-Covers mode, and the shared sort-mode dropdown), just
// scoped to a fixed status and never grouped by location.
function syncAllSortSelects() {
  ["shelf-sort-select", "reading-sort-select", "toread-sort-select"].forEach((id) => {
    const sel = document.getElementById(id);
    if (sel) sel.value = shelfSortMode;
  });
}

function syncAllCoverModeButtons() {
  document.querySelectorAll(".view-mode-toggle .mode-btn[data-mode]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === shelfCoverMode);
  });
}

function makeStatusShelfLoader(prefix, status) {
  async function load() {
    const container = document.getElementById(`${prefix}-container`);
    container.innerHTML = '<p class="empty-note">Loading…</p>';
    const search = document.getElementById(`${prefix}-search`).value.trim();
    const params = new URLSearchParams({ status });
    if (search) params.set("search", search);
    let books = await api("/books?" + params.toString());
    books = applySortMode(books);
    container.innerHTML = "";
    if (books.length === 0) {
      container.innerHTML = '<p class="empty-note">Nothing here yet.</p>';
      return;
    }
    buildShelfRows(container, books);
  }

  document.getElementById(`${prefix}-search`).addEventListener("input", debounce(load, 300));
  document.getElementById(`${prefix}-sort-select`).addEventListener("change", (e) => {
    shelfSortMode = e.target.value;
    localStorage.setItem("shelfSortMode", shelfSortMode);
    syncAllSortSelects();
    load();
  });
  document.querySelectorAll(`#${prefix}-mode-toggle .mode-btn`).forEach((btn) => {
    btn.addEventListener("click", () => {
      shelfCoverMode = btn.dataset.mode;
      localStorage.setItem("shelfCoverMode", shelfCoverMode);
      syncAllCoverModeButtons();
      load();
    });
  });

  return load;
}

const loadReadingShelf = makeStatusShelfLoader("reading", "reading");
const loadToReadShelf = makeStatusShelfLoader("toread", "planning");
syncAllCoverModeButtons();
syncAllSortSelects();

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
  const entriesFileInput = document.getElementById("csv-entries-file-input");
  const entriesFile = entriesFileInput.files[0];
  const progress = document.getElementById("csv-import-progress");
  const resultsEl = document.getElementById("csv-import-results");
  const btn = document.getElementById("csv-import-btn");

  const form = new FormData();
  form.append("file", file);
  form.append("enrich", enrich ? "true" : "false");
  if (entriesFile) form.append("entries_file", entriesFile);

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
    if (result.read_entries_restored) {
      lines.unshift(`<div class="result-line added">✓ Restored ${result.read_entries_restored} read-through(s) from the reading history file${result.read_entries_skipped ? ` (${result.read_entries_skipped} skipped — no matching book found)` : ""}.</div>`);
    }
    if (result.isbn_corrupted_count) {
      lines.unshift(`<div class="result-line notfound">⚠ ${result.isbn_corrupted_count} row(s) had an ISBN mangled into scientific notation (likely from opening the CSV in Excel/Sheets) — those ISBNs were left untouched rather than overwritten with corrupted data. Matching still worked via the ID column.</div>`);
    }
    if (result.status_corrected_count) {
      lines.unshift(`<div class="result-line notfound">⚠ ${result.status_corrected_count} row(s) had a finish date but were marked Unread — corrected to Read automatically, since a finished book can't be Unread.</div>`);
    }
    resultsEl.innerHTML = lines.join("") || '<div class="result-line dup">No rows processed.</div>';
    fileInput.value = "";
    entriesFileInput.value = "";
    loadStats();
    loadLocations();
    loadTags();
    loadSeries();
    loadAuthors();
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

document.getElementById("export-entries-csv-btn").addEventListener("click", () => {
  window.location.href = API + "/export/read-entries.csv";
});

// ---------- ZIP export (includes cover images + full reading history) ----------
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
    const entriesNote = result.read_entries_restored ? `, ${result.read_entries_restored} read(s) restored to history` : "";
    progress.textContent = `Done — ${result.covers_restored} cover image(s) restored${entriesNote}.`;
    const lines = [];
    result.updated.forEach((b) => lines.push(`<div class="result-line added">✓ Updated — ${escapeHtml(b.title)}</div>`));
    result.added.forEach((b) => lines.push(`<div class="result-line added">✓ Added — ${escapeHtml(b.title)}</div>`));
    (result.mismatched || []).forEach((r) => lines.push(`<div class="result-line notfound">⚠ Mismatch — ${escapeHtml(r.reason)}</div>`));
    (result.ambiguous || []).forEach((r) => lines.push(`<div class="result-line notfound">⚠ Ambiguous — ${escapeHtml(r.reason)}</div>`));
    if (result.read_entries_skipped) {
      lines.unshift(`<div class="result-line notfound">⚠ ${result.read_entries_skipped} reading-history row(s) skipped — no matching book found.</div>`);
    }
    if (result.isbn_corrupted_count) {
      lines.unshift(`<div class="result-line notfound">⚠ ${result.isbn_corrupted_count} row(s) had an ISBN mangled into scientific notation (likely from opening the CSV in Excel/Sheets) — those ISBNs were left untouched rather than overwritten with corrupted data. Matching still worked via the ID column.</div>`);
    }
    if (result.status_corrected_count) {
      lines.unshift(`<div class="result-line notfound">⚠ ${result.status_corrected_count} row(s) had a finish date but were marked Unread — corrected to Read automatically, since a finished book can't be Unread.</div>`);
    }
    resultsEl.innerHTML = lines.join("") || '<div class="result-line dup">No rows processed.</div>';
    fileInput.value = "";
    loadStats();
    loadLocations();
    loadTags();
    loadSeries();
    loadAuthors();
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
  closeDatePicker();
  modalOverlay.classList.add("hidden");
  currentModalBookId = null;
  refreshCurrentView();
}

function refreshCurrentView() {
  const active = document.querySelector(".tab.active").dataset.view;
  if (active === "shelf") loadShelf();
  if (active === "library") loadLibrary();
  if (active === "reviews") loadReviews();
  if (active === "reading") loadReadingShelf();
  if (active === "toread") loadToReadShelf();
  loadStats();
  loadLocations();
  loadTags();
  loadSeries();
  loadAuthors();
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
  const entries = await api(`/books/${bookId}/read-entries`);
  currentModalBook = book;
  currentEntries = entries;
  renderBookModal(book, entries, initialTab);
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

function formatEntryDateRange(e) {
  if (e.date_started && e.date_finished) return `${e.date_started} → ${e.date_finished}`;
  if (e.date_started && !e.date_finished) return `Started ${e.date_started} · in progress`;
  if (!e.date_started && e.date_finished) return `Finished ${e.date_finished}`;
  return "No dates recorded";
}

function renderEntryCard(e) {
  return `
    <div class="entry-card" data-id="${e.id}">
      <div class="entry-header">
        <span class="entry-dates">${formatEntryDateRange(e)}</span>
        ${starWidgetHtml("entry-stars-" + e.id, e.rating, false)}
      </div>
      ${e.review_text ? `<div class="entry-review">${e.contains_spoilers ? '<span class="spoiler-tag">SPOILERS </span>' : ""}${escapeHtml(e.review_text)}</div>` : ""}
      <div class="entry-actions">
        <button class="btn-secondary entry-edit-btn" data-id="${e.id}" type="button">Edit</button>
        <button class="btn-danger entry-delete-btn" data-id="${e.id}" type="button">Delete</button>
      </div>
    </div>
  `;
}

function renderEntryForm(entry) {
  const isEdit = !!entry;
  return `
    <div class="entry-form" id="entry-form">
      <div class="form-grid">
        <label class="full">Started
          <div class="date-input-group">
            <input type="text" id="ef-started" class="date-text-input" value="${entry?.date_started || ""}" placeholder="YYYY-MM-DD" />
            <button type="button" class="date-picker-btn" data-target="ef-started" aria-label="Pick a date">📅</button>
          </div>
        </label>
        <label class="full">Finished
          <div class="date-input-group">
            <input type="text" id="ef-finished" class="date-text-input" value="${entry?.date_finished || ""}" placeholder="YYYY-MM-DD" />
            <button type="button" class="date-picker-btn" data-target="ef-finished" aria-label="Pick a date">📅</button>
          </div>
        </label>
        <label class="full">Rating
          ${starWidgetHtml("ef-rating", entry?.rating || 0, true)}
        </label>
        <label class="full">Review
          <textarea class="review-textarea" id="ef-review-text" placeholder="What did you think?">${escapeHtml(entry?.review_text || "")}</textarea>
        </label>
        <label class="full" style="display:flex; flex-direction:row; align-items:center; gap:8px;">
          <input type="checkbox" id="ef-spoilers" ${entry?.contains_spoilers ? "checked" : ""} style="width:auto;" />
          Contains spoilers
        </label>
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" id="ef-cancel-btn" type="button">Cancel</button>
        <button class="btn-primary" id="ef-save-btn" type="button">${isEdit ? "Save read" : "Add read"}</button>
      </div>
    </div>
  `;
}

function renderHistoryList() {
  const list = document.getElementById("read-entries-list");
  if (!list) return;
  if (currentEntries.length === 0) {
    list.innerHTML = '<p class="empty-note">No reads logged yet.</p>';
  } else {
    const sorted = [...currentEntries].sort((a, b) => {
      const ad = a.date_finished || a.date_started || "";
      const bd = b.date_finished || b.date_started || "";
      return bd.localeCompare(ad);
    });
    list.innerHTML = sorted.map(renderEntryCard).join("");
  }
  list.querySelectorAll(".entry-edit-btn").forEach((btn) =>
    btn.addEventListener("click", () => openEntryForm(Number(btn.dataset.id)))
  );
  list.querySelectorAll(".entry-delete-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this read entry?")) return;
      await api(`/read-entries/${btn.dataset.id}`, { method: "DELETE" });
      await refreshModalEntries();
    })
  );
}

function openEntryForm(entryId) {
  const entry = entryId ? currentEntries.find((e) => e.id === entryId) : null;
  const container = document.getElementById("entry-form-container");
  container.innerHTML = renderEntryForm(entry);
  document.getElementById("add-entry-btn").style.display = "none";
  wireStarWidget("ef-rating");
  wireDatePickerButtons(container);

  document.getElementById("ef-cancel-btn").addEventListener("click", () => {
    container.innerHTML = "";
    document.getElementById("add-entry-btn").style.display = "";
  });

  document.getElementById("ef-save-btn").addEventListener("click", async () => {
    const startedRaw = document.getElementById("ef-started").value;
    const finishedRaw = document.getElementById("ef-finished").value;
    const startedDate = startedRaw.trim() ? parseLenientDate(startedRaw) : null;
    const finishedDate = finishedRaw.trim() ? parseLenientDate(finishedRaw) : null;
    if (startedRaw.trim() && !startedDate) { alert("Started date isn't a valid date. Try YYYY-MM-DD (e.g. 2024-01-31)."); return; }
    if (finishedRaw.trim() && !finishedDate) { alert("Finished date isn't a valid date. Try YYYY-MM-DD (e.g. 2024-01-31)."); return; }
    const payload = {
      date_started: startedDate,
      date_finished: finishedDate,
      rating: Number(document.getElementById("ef-rating").dataset.value) || null,
      review_text: document.getElementById("ef-review-text").value,
      contains_spoilers: document.getElementById("ef-spoilers").checked,
    };
    try {
      if (entry) {
        await api(`/read-entries/${entry.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await api(`/books/${currentModalBook.id}/read-entries`, { method: "POST", body: JSON.stringify(payload) });
      }
      container.innerHTML = "";
      document.getElementById("add-entry-btn").style.display = "";
      await refreshModalEntries();
    } catch (err) {
      alert(err.message);
    }
  });
}

async function refreshModalEntries() {
  const book = await api(`/books/${currentModalBook.id}`);
  const entries = await api(`/books/${currentModalBook.id}/read-entries`);
  currentModalBook = book;
  currentEntries = entries;
  renderBookModal(book, entries, "history");
}

function readSummaryLine(book) {
  if (book.date_finished) {
    const started = book.date_started ? ` (started ${book.date_started})` : "";
    const rating = book.rating ? ` — ${stars(book.rating)}` : "";
    return `Last read: finished ${book.date_finished}${started}${rating}`;
  }
  if (book.date_started) return `Currently reading — started ${book.date_started}`;
  return "Not read yet";
}

function renderBookModal(book, entries, initialTab) {
  currentModalBook = book;
  currentEntries = entries;
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
      <button class="mtab" data-mtab="history">Reading History${entries.length ? ` (${entries.length})` : ""}</button>
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
            ${["unread", "planning", "reading", "read", "dnf"].map((s) => `<option value="${s}" ${book.status === s ? "selected" : ""} ${s === "unread" && book.date_finished ? "disabled" : ""}>${STATUS_LABELS[s]}</option>`).join("")}
          </select>
        </label>
        <label>Owned
          <select id="e-owned">
            <option value="true" ${book.owned ? "selected" : ""}>Yes</option>
            <option value="false" ${!book.owned ? "selected" : ""}>No</option>
          </select>
        </label>
      </div>
      <p class="read-summary">${readSummaryLine(book)} <span class="read-summary-hint">— manage full reading history in the tab above</span></p>
      <div class="modal-actions">
        <button class="btn-danger" id="delete-book-btn">Remove book</button>
        <button class="btn-primary" id="save-book-btn">Save changes</button>
      </div>
    </div>

    <div id="mtab-history" class="mtab-pane" style="display:none;">
      <div id="read-entries-list"></div>
      <div id="entry-form-container"></div>
      <div class="modal-actions">
        <span></span>
        <button class="btn-primary" id="add-entry-btn" type="button">+ Add a read</button>
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
  if (initialTab === "history") modalBody.querySelector('[data-mtab="history"]').click();

  renderHistoryList();
  document.getElementById("add-entry-btn").addEventListener("click", () => openEntryForm(null));

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
      renderBookModal(book, currentEntries, "details");
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
      renderBookModal(book, currentEntries, "details");
    });
  }

  document.getElementById("save-book-btn").addEventListener("click", async () => {
    const title = document.getElementById("e-title").value.trim();
    if (!title) { alert("Title is required."); return; }
    const payload = {
      title,
      authors: document.getElementById("e-authors").value.trim() || null,
      status: document.getElementById("e-status").value,
      owned: document.getElementById("e-owned").value === "true",
      location: document.getElementById("e-location").value.trim() || null,
      series: document.getElementById("e-series").value.trim() || null,
      tags: document.getElementById("e-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
    };
    try {
      await api(`/books/${book.id}`, { method: "PUT", body: JSON.stringify(payload) });
      closeModal();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById("delete-book-btn").addEventListener("click", async () => {
    if (!confirm(`Remove "${book.title}" from your library?`)) return;
    await api(`/books/${book.id}`, { method: "DELETE" });
    closeModal();
  });
}

// ---------- init ----------
loadStats();
loadLocations();
loadTags();
loadSeries();
loadAuthors();
loadShelf();
