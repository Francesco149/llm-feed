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

function cardHeader(entry) {
  const h = el("h2");
  h.appendChild(el("span", "badge", entry.type));
  h.appendChild(document.createTextNode(entry.title || "(untitled)"));
  const meta = el("div", "meta",
    `${fmtTime(entry.iso)} · ${entry.id}` +
    (entry.type === "montage" ? ` · ${entry.frames.length} frames · ${entry.cols} cols` : ""));
  return [h, meta];
}

function renderImage(entry) {
  const card = el("div", "card");
  cardHeader(entry).forEach(n => card.appendChild(n));
  if (entry.note) card.appendChild(el("div", "note", entry.note));
  const img = el("img", "single");
  img.src = "/" + entry.src;
  img.alt = entry.title || "";
  img.style.cursor = "zoom-in";
  img.addEventListener("click", () =>
    openLightbox([{ src: entry.src, label: entry.title || "" }], 0, entry.title || "image"));
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
      openLightbox(entry.frames, i, entry.title || "montage"));
    grid.appendChild(tile);
  });
  card.appendChild(grid);
  card.appendChild(el("div", "hint", "click a frame to zoom in · ←/→ to flip · Esc to close"));
  return card;
}

function renderEntry(entry) {
  if (entry.type === "image")   return renderImage(entry);
  if (entry.type === "montage") return renderMontage(entry);
  // Unknown/future type: show its title + a raw note so nothing is silently dropped.
  const card = el("div", "card");
  cardHeader(entry).forEach(n => card.appendChild(n));
  card.appendChild(el("div", "note", JSON.stringify(entry, null, 2)));
  return card;
}

function ingest(entries) {
  let added = 0;
  for (const entry of entries) {           // oldest → newest
    if (!entry || !entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const card = renderEntry(entry);
    feedEl.insertBefore(card, feedEl.firstChild);   // prepend → newest on top
    added++; total++;
  }
  if (total > 0 && emptyEl) emptyEl.remove();
  if (added) {
    countEl.textContent = `${total} item${total === 1 ? "" : "s"}`;
    if (autoEl.checked) window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

async function poll() {
  try {
    const res = await fetch("/data/feed.jsonl?t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    const entries = text.split("\n").map(l => l.trim()).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
    ingest(entries);
    setLive(true);
  } catch (e) {
    setLive(false);
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
let lbFrames = [], lbIdx = 0;

function lbShow() {
  const fr = lbFrames[lbIdx];
  if (!fr) return;
  lbImg.src = "/" + fr.src;
  lbImg.alt = fr.label || "";
  lbLabel.textContent = fr.label || "";
  lbCounter.textContent = `${lbIdx + 1} / ${lbFrames.length}`;
}

function openLightbox(frames, idx, title) {
  lbFrames = frames || [];
  lbIdx = Math.max(0, Math.min(idx || 0, lbFrames.length - 1));
  lbTitle.textContent = title || "";
  lb.classList.remove("hidden");
  lbShow();
}
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
