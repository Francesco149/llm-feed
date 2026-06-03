"use strict";

// ─── feed polling ───────────────────────────────────────────────────────────
// Poll data/feed.jsonl, render any not-yet-seen entries. Newest ends up on top
// (we iterate oldest→newest and prepend each new card).

const feedEl    = document.getElementById("feed");
const emptyEl   = document.getElementById("empty");
const dotEl     = document.getElementById("dot");
const statusEl  = document.getElementById("statustext");
const countEl   = document.getElementById("count");
const autoEl    = document.getElementById("autoscroll");

const seen = new Set();
let total = 0;

function fmtTime(iso) {
  // Show local HH:MM:SS from the ISO timestamp.
  try { return new Date(iso).toLocaleTimeString(); } catch (_) { return iso || ""; }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function copyAnchor(id, node) {
  const done = () => {
    const old = node.textContent;
    node.textContent = "copied ✓";
    node.classList.add("copied");
    setTimeout(() => { node.textContent = old; node.classList.remove("copied"); }, 900);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(id).then(done).catch(done);
  } else {
    // Fallback for non-secure contexts.
    const t = document.createElement("textarea");
    t.value = id; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } catch (_) {}
    t.remove(); done();
  }
}

// ─── drag-to-select a region of an image → coords to clipboard ───────────────
// Works on any <img>. A drag (> a few px) selects a box and copies its bounding
// rect in the image's NATURAL pixels to the clipboard; a plain click falls
// through to onClick (zoom / toggle). The copied string is self-describing so
// it can be pasted straight back to the agent: it names the push id, the source
// path, the image's natural size, and the box as x0,y0,x1,y1.

let cropToastEl = null, cropToastTimer = 0;
function showCropToast(text, isErr) {
  if (cropToastEl) cropToastEl.remove();
  cropToastEl = el("div", "crop-toast" + (isErr ? " err" : ""), text);
  document.body.appendChild(cropToastEl);
  clearTimeout(cropToastTimer);
  cropToastTimer = setTimeout(() => {
    if (cropToastEl) { cropToastEl.remove(); cropToastEl = null; }
  }, 4000);
}

function copyToClipboard(text, onOk, onErr) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onOk, onErr || onOk);
  } else {
    const t = document.createElement("textarea");
    t.value = text; document.body.appendChild(t); t.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (_) {}
    t.remove(); (ok ? onOk : (onErr || onOk))();
  }
}

// getMeta() → { id, src, label? } describing the image's CURRENT content
// (the lightbox re-reads it per frame). onClick() fires on a plain click.
function attachBoxSelect(img, getMeta, onClick) {
  img.classList.add("selectable");
  const DRAG_MIN = 4;
  let sx = 0, sy = 0, dragging = false, moved = false, box = null;

  const clampToImg = (cx, cy) => {
    const r = img.getBoundingClientRect();
    return [Math.min(Math.max(cx, r.left), r.right),
            Math.min(Math.max(cy, r.top),  r.bottom)];
  };
  const toNatural = (cx, cy) => {
    const r = img.getBoundingClientRect();
    const nx = (cx - r.left) / r.width  * (img.naturalWidth  || r.width);
    const ny = (cy - r.top)  / r.height * (img.naturalHeight || r.height);
    return [Math.round(nx), Math.round(ny)];
  };

  img.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true; moved = false;
    sx = e.clientX; sy = e.clientY;
    try { img.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  });

  img.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    if (!moved && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < DRAG_MIN)
      return;
    moved = true;
    e.stopPropagation();
    const [ax, ay] = clampToImg(sx, sy);
    const [bx, by] = clampToImg(e.clientX, e.clientY);
    if (!box) { box = el("div", "box-sel"); document.body.appendChild(box); }
    box.style.left   = Math.min(ax, bx) + "px";
    box.style.top    = Math.min(ay, by) + "px";
    box.style.width  = Math.abs(bx - ax) + "px";
    box.style.height = Math.abs(by - ay) + "px";
  });

  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    try { img.releasePointerCapture(e.pointerId); } catch (_) {}
    if (box) { box.remove(); box = null; }
    if (!moved) { if (onClick) onClick(); return; }
    e.stopPropagation();
    const [ax, ay] = clampToImg(sx, sy);
    const [bx, by] = clampToImg(e.clientX, e.clientY);
    const [x0, y0] = toNatural(Math.min(ax, bx), Math.min(ay, by));
    const [x1, y1] = toNatural(Math.max(ax, bx), Math.max(ay, by));
    if (x1 - x0 < 1 || y1 - y0 < 1) return;          // too small — ignore
    const m = (getMeta && getMeta()) || {};
    const W = img.naturalWidth, H = img.naturalHeight;
    let s = `crop id=${m.id || "?"} box=${x0},${y0},${x1},${y1}` +
            ` size=${W}x${H}`;
    if (m.label) s += ` frame=${m.label}`;
    if (m.src)   s += ` src=${m.src}`;
    copyToClipboard(s,
      () => showCropToast("copied ✓  " + s, false),
      () => showCropToast("(copy failed — select & copy)\n" + s, true));
  };
  img.addEventListener("pointerup", finish);
  img.addEventListener("pointercancel", () => {
    dragging = false; if (box) { box.remove(); box = null; }
  });
  // Swallow the native click so all click behaviour routes through onClick
  // above (no double-toggle on comparison wrappers, no bubble to the lightbox
  // backdrop). The drag-vs-click decision already happened in finish().
  img.addEventListener("click", (e) => {
    e.stopPropagation(); e.preventDefault();
  }, true);
}

function cardHeader(entry) {
  const h = el("h2");
  h.appendChild(el("span", "badge", entry.type));
  h.appendChild(document.createTextNode(entry.title || "(untitled)"));

  const meta = el("div", "meta");
  meta.appendChild(document.createTextNode(fmtTime(entry.iso) + " · "));
  const anchor = el("span", "anchor", entry.id);
  anchor.title = "click to copy this anchor id (paste it back to refer to this push)";
  anchor.addEventListener("click", () => copyAnchor(entry.id, anchor));
  meta.appendChild(anchor);

  let extra = "";
  if (entry.type === "montage")
    extra = ` · ${entry.frames.length} frames · ${entry.cols} cols`;
  else if (entry.type === "trace")
    extra = ` · ${entry.frames.length} frames · ${entry.fps || 20} fps`;
  else if (entry.type === "comparison")
    extra = ` · ${entry.panels.length} panels · ${entry.left_label} | ${entry.right_label}`;
  if (extra) meta.appendChild(document.createTextNode(extra));
  return [h, meta];
}

function renderImage(entry) {
  const card = el("div", "card");
  cardHeader(entry).forEach(n => card.appendChild(n));
  if (entry.note) card.appendChild(el("div", "note", entry.note));
  const img = el("img", "single");
  img.src = "/" + entry.src;
  img.alt = entry.title || "";
  attachBoxSelect(img,
    () => ({ id: entry.id, src: entry.src }),
    () => openLightbox([{ src: entry.src, label: entry.title || "" }], 0,
                       entry.title || "image", { id: entry.id }));
  card.appendChild(img);
  return card;
}

function renderMontage(entry) {
  const card = el("div", "card");
  cardHeader(entry).forEach(n => card.appendChild(n));
  if (entry.note) card.appendChild(el("div", "note", entry.note));

  const grid = el("div", "grid");
  grid.style.gridTemplateColumns = `repeat(${entry.cols || 3}, 1fr)`;
  entry.frames.forEach((fr, i) => {
    const tile = el("div", "tile");
    const img = el("img");
    img.src = "/" + fr.src;
    img.loading = "lazy";
    img.alt = fr.label || "";
    tile.appendChild(img);
    if (fr.label) tile.appendChild(el("span", "tl", fr.label));
    tile.addEventListener("click", () =>
      openLightbox(entry.frames, i, entry.title || "montage", { id: entry.id }));
    grid.appendChild(tile);
  });
  card.appendChild(grid);
  card.appendChild(el("div", "hint", "click a frame to zoom in · ←/→ to flip · Esc to close"));
  return card;
}

function renderComparison(entry) {
  const card = el("div", "card");
  cardHeader(entry).forEach(n => card.appendChild(n));
  if (entry.note) card.appendChild(el("div", "note", entry.note));

  entry.panels.forEach(p => {
    const cap = el("div", "cap");
    // Wrapper clipped to row 0 ([left|right]); click expands to the full atlas
    // (revealing the diff row). The <img> is the whole atlas, so the browser's
    // "Copy Image" yields the 3-up montage regardless of the CSS clip.
    const wrap = el("div", "atlas-wrap");
    wrap.style.setProperty("--r0", p.row0_pct + "%");
    wrap.style.setProperty("--tot", p.total_pct + "%");
    const img = el("img");
    img.src = "/" + p.src;
    img.loading = "lazy";
    img.alt = p.label || "";
    // Box-select copies coords in the ATLAS's natural pixels (the agent maps
    // them to a panel by the comparison geometry); a plain click toggles the
    // diff reveal as before.
    attachBoxSelect(img,
      () => ({ id: entry.id, src: p.src, label: p.label }),
      () => wrap.classList.toggle("open"));
    wrap.appendChild(img);
    cap.appendChild(wrap);

    let stat = "";
    if (p.differ_px === 0) stat = " · bit-identical";
    else if (p.differ_px != null) stat = ` · ${p.differ_px} px differ · mean|abs|/ch ${p.meanabs}`;
    cap.appendChild(el("div", "capcap",
      `${p.label} · ${entry.left_label} | ${entry.right_label}${stat}` +
      ` · click to reveal diff · right-click → Copy Image for 3-up`));
    card.appendChild(cap);
  });
  return card;
}

// A `trace` card: an animated preview that flip-cycles the captured frames at
// the trace's fps (JS-driven, so feed.py stays stdlib-only — no GIF baking).
// Clicking "open viewer" opens the dedicated frame-stepper in a new tab.
function renderTrace(entry) {
  const card = el("div", "card");
  cardHeader(entry).forEach(n => card.appendChild(n));
  if (entry.note) card.appendChild(el("div", "note", entry.note));

  const frames = entry.frames || [];
  const wrap = el("div", "trace-card-img");
  const img = el("img");
  img.loading = "lazy";
  if (frames[0]) img.src = "/" + frames[0].src;
  const badge = el("div", "tc-badge", frames.length ? `1 / ${frames.length}` : "");
  wrap.appendChild(img);
  wrap.appendChild(badge);

  // Cycle frames at fps; pause on hover so a frame can be inspected.
  let i = 0, timer = 0;
  const fps = Math.max(1, entry.fps || 20);
  const tick = () => {
    if (!frames.length) return;
    i = (i + 1) % frames.length;
    img.src = "/" + frames[i].src;
    badge.textContent = `${i + 1} / ${frames.length}`;
  };
  const start = () => { if (!timer && frames.length > 1) timer = setInterval(tick, Math.round(1000 / fps)); };
  const stop  = () => { if (timer) { clearInterval(timer); timer = 0; } };
  wrap.addEventListener("mouseenter", stop);
  wrap.addEventListener("mouseleave", start);
  // Clicking the preview opens the viewer too (same as the link).
  wrap.addEventListener("click", () => window.open(`/trace.html?id=${entry.id}`, "_blank"));
  start();

  card.appendChild(wrap);
  const open = el("a", "trace-open", "▶ open frame-by-frame viewer →");
  open.href = `/trace.html?id=${entry.id}`;
  open.target = "_blank";
  card.appendChild(open);
  return card;
}

function renderEntry(entry) {
  if (entry.type === "image")      return renderImage(entry);
  if (entry.type === "montage")    return renderMontage(entry);
  if (entry.type === "trace")      return renderTrace(entry);
  if (entry.type === "comparison") return renderComparison(entry);
  // Unknown/future type: show its title + a raw note so nothing is silently dropped.
  const card = el("div", "card");
  cardHeader(entry).forEach(n => card.appendChild(n));
  card.appendChild(el("div", "note", JSON.stringify(entry, null, 2)));
  return card;
}

// ─── pagination ─────────────────────────────────────────────────────────────
// The feed can grow unbounded, so only the newest PAGE_SIZE items render on the
// first load; the older backlog hides behind a "Load more" button (+PAGE_SIZE
// per click). NEW items arriving via polling always render on top regardless of
// the cap — they never push already-loaded items back into the backlog.

const PAGE_SIZE = 10;
let pending = [];            // older backlog, newest→oldest, not yet rendered
let firstLoad = true;
let loadMoreBtn = null;

function updateCount() {
  const extra = pending.length ? ` (+${pending.length} older)` : "";
  countEl.textContent = `${total} item${total === 1 ? "" : "s"}${extra}`;
}

function renderLoadMore() {
  if (!loadMoreBtn) {
    loadMoreBtn = el("button", "load-more");
    loadMoreBtn.addEventListener("click", loadMore);
    feedEl.appendChild(loadMoreBtn);
  }
  if (!pending.length) {
    loadMoreBtn.remove(); loadMoreBtn = null; return;
  }
  // Keep it last in the feed (older items insert above it).
  feedEl.appendChild(loadMoreBtn);
  const n = Math.min(PAGE_SIZE, pending.length);
  loadMoreBtn.textContent = `load ${n} more older ${n === 1 ? "item" : "items"} `
    + `(${pending.length} hidden)`;
}

function loadMore() {
  const take = pending.splice(0, PAGE_SIZE);   // newest-of-the-old first
  for (const entry of take) {                  // append above the button, in order
    const card = renderEntry(entry);
    if (loadMoreBtn) feedEl.insertBefore(card, loadMoreBtn);
    else feedEl.appendChild(card);
    total++;
  }
  renderLoadMore();
  updateCount();
}

function ingest(entries) {
  // entries: full feed in append order (oldest → newest).
  const fresh = entries.filter(e => e && e.id && !seen.has(e.id));
  if (!fresh.length) return;
  for (const e of fresh) seen.add(e.id);

  let addedTop = 0;
  if (firstLoad) {
    firstLoad = false;
    // Newest PAGE_SIZE render now; the rest become the (newest→oldest) backlog.
    const head = fresh.slice(-PAGE_SIZE);            // newest PAGE_SIZE (oldest→newest)
    const tail = fresh.slice(0, -PAGE_SIZE);         // older backlog (oldest→newest)
    for (const entry of head) {
      feedEl.insertBefore(renderEntry(entry), feedEl.firstChild);  // → newest on top
      total++; addedTop++;
    }
    pending = tail.reverse();                        // newest→oldest for Load more
    renderLoadMore();
  } else {
    // Subsequent polls only see genuinely new (appended) items — always on top.
    for (const entry of fresh) {                     // oldest→newest → newest ends on top
      feedEl.insertBefore(renderEntry(entry), feedEl.firstChild);
      total++; addedTop++;
    }
  }

  if (total > 0 && emptyEl) emptyEl.remove();
  updateCount();
  if (addedTop && autoEl.checked) window.scrollTo({ top: 0, behavior: "smooth" });
}

let pollFails = 0; // tolerate transient hiccups before declaring the server offline

async function poll() {
  try {
    // No cache-buster: "no-cache" revalidates with the server's ETag, so an unchanged
    // feed comes back as a 304 (served from the browser cache) instead of re-downloading
    // the whole file every tick — which is what was hammering the server.
    const res = await fetch("/data/feed.jsonl", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    const entries = text.split("\n").map(l => l.trim()).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
    ingest(entries);
    pollFails = 0;
    setLive(true);
  } catch (e) {
    // A single failed poll is usually just contention; only flip to "offline" after a few
    // in a row, so the status doesn't flicker under load.
    if (++pollFails >= 3) setLive(false);
  }
}

function setLive(ok) {
  dotEl.className = "dot " + (ok ? "live" : "dead");
  statusEl.textContent = ok ? "live" : "server offline — retrying…";
}

// ─── lightbox (montage flip-through) ────────────────────────────────────────

const lb        = document.getElementById("lightbox");
const lbImg      = document.getElementById("lb-img");
const lbTitle    = document.getElementById("lb-title");
const lbCounter  = document.getElementById("lb-counter");
const lbLabel    = document.getElementById("lb-label");
let lbFrames = [], lbIdx = 0, lbMeta = {};

function lbShow() {
  const fr = lbFrames[lbIdx];
  if (!fr) return;
  lbImg.src = "/" + fr.src;
  lbImg.alt = fr.label || "";
  lbLabel.textContent = fr.label || "";
  lbCounter.textContent = `${lbIdx + 1} / ${lbFrames.length}`;
}

function openLightbox(frames, idx, title, meta) {
  lbFrames = frames || [];
  lbIdx = Math.max(0, Math.min(idx || 0, lbFrames.length - 1));
  lbMeta = meta || {};
  lbTitle.textContent = title || "";
  lb.classList.remove("hidden");
  lbShow();
}

// Box-select in the zoom view → coords in the (full-res) frame's natural
// pixels.  Covers montage frames (object-fit:cover thumbnails are imprecise;
// the lightbox shows the whole frame) and single images.  A plain click is a
// no-op here (the lightbox is already the zoomed view).
attachBoxSelect(lbImg,
  () => {
    const fr = lbFrames[lbIdx] || {};
    return { id: lbMeta.id, src: fr.src, label: fr.label };
  },
  () => {});
function closeLightbox() { lb.classList.add("hidden"); lbImg.removeAttribute("src"); }
function lbStep(d) {
  if (!lbFrames.length) return;
  lbIdx = (lbIdx + d + lbFrames.length) % lbFrames.length;
  lbShow();
}

document.getElementById("lb-close").addEventListener("click", closeLightbox);
document.getElementById("lb-prev").addEventListener("click", () => lbStep(-1));
document.getElementById("lb-next").addEventListener("click", () => lbStep(1));
lb.addEventListener("click", (e) => { if (e.target === lb) closeLightbox(); });
document.addEventListener("keydown", (e) => {
  if (lb.classList.contains("hidden")) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") lbStep(-1);
  else if (e.key === "ArrowRight") lbStep(1);
});

// ─── go ──────────────────────────────────────────────────────────────────────
poll();
setInterval(poll, 1500);
