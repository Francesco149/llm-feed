"use strict";

// ─── trace viewer ───────────────────────────────────────────────────────────
// A dedicated frame-by-frame stepper for a `trace` feed entry. Opened in its
// own tab via /trace.html?id=<id>. Reads the entry from /data/feed.jsonl, then
// lets you: step frames (←/→ = ±10, ,/. = ±1, Home/End), play at the trace's
// fps, mark per-frame captures (c), and drag a crop box → a copyable
// `crop … frame=f=<n>` reference (the same string the main feed produces).

// ─── small DOM + clipboard helpers (mirrors app.js) ─────────────────────────

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

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

// getMeta() → { id, src, label? } describing the image's CURRENT content (the
// viewer re-reads it per frame). onClick() fires on a plain click. Copied
// verbatim from app.js attachBoxSelect so the crop string is identical.
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
  img.addEventListener("click", (e) => {
    e.stopPropagation(); e.preventDefault();
  }, true);
}

// ─── viewer state ───────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const imgEl     = $("tv-img");
const overlayEl = $("tv-overlay");
const posEl     = $("tv-pos");
const dataEl    = $("tv-data");
const globalEl  = $("tv-global");
const capsEl    = $("tv-caps");

let entry = null;
let frames = [];
let cur = 0;
const marked = new Set();      // marked capture frame numbers (frame.n)
let playTimer = 0;

function qid() {
  const m = /[?&]id=([^&]+)/.exec(location.search);
  return m ? decodeURIComponent(m[1]) : "";
}

function frameNo(i) {
  const fr = frames[i];
  return (fr && fr.n != null) ? fr.n : i;
}

function show() {
  const fr = frames[cur];
  if (!fr) return;
  imgEl.src = "/" + fr.src;
  imgEl.alt = fr.label || "";
  posEl.textContent = `${cur + 1} / ${frames.length}`;
  const isMarked = marked.has(frameNo(cur));
  overlayEl.textContent = (fr.label || `f=${frameNo(cur)}`) + (isMarked ? "  ◉" : "");
  overlayEl.classList.toggle("marked", isMarked);
  dataEl.textContent = JSON.stringify(fr.data || {}, null, 2);
}

function step(d) {
  if (!frames.length) return;
  cur = Math.max(0, Math.min(frames.length - 1, cur + d));
  show();
}
function goto(i) { cur = Math.max(0, Math.min(frames.length - 1, i)); show(); }

function toggleMark() {
  const n = frameNo(cur);
  if (marked.has(n)) marked.delete(n); else marked.add(n);
  renderCaps();
  show();
}

function renderCaps() {
  const list = [...marked].sort((a, b) => a - b);
  if (!list.length) {
    capsEl.innerHTML = "(none — press <b>c</b> on a frame)";
    return;
  }
  capsEl.textContent = list.join(", ");
}

function copyCaps() {
  const list = [...marked].sort((a, b) => a - b);
  if (!list.length) { showCropToast("no captures marked (press c)", true); return; }
  const s = `trace id=${entry.id} captures=${list.join(",")}`;
  copyToClipboard(s,
    () => showCropToast("copied ✓  " + s, false),
    () => showCropToast("(copy failed)\n" + s, true));
}

function play() {
  if (playTimer) { stop(); return; }
  const fps = Math.max(1, entry.fps || 20);
  $("tv-play").textContent = "❚❚ pause";
  playTimer = setInterval(() => {
    cur = (cur + 1) % frames.length;
    show();
  }, Math.round(1000 / fps));
}
function stop() {
  if (playTimer) { clearInterval(playTimer); playTimer = 0; }
  $("tv-play").textContent = "▶ play";
}

// ─── wiring ─────────────────────────────────────────────────────────────────

function wire() {
  $("tv-first").onclick   = () => { stop(); goto(0); };
  $("tv-last").onclick    = () => { stop(); goto(frames.length - 1); };
  $("tv-back10").onclick  = () => { stop(); step(-10); };
  $("tv-back1").onclick   = () => { stop(); step(-1); };
  $("tv-fwd1").onclick    = () => { stop(); step(1); };
  $("tv-fwd10").onclick   = () => { stop(); step(10); };
  $("tv-play").onclick    = play;
  $("tv-mark").onclick    = toggleMark;
  $("tv-copycaps").onclick = copyCaps;
  $("tv-toggle-global").onclick = () => {
    const hidden = globalEl.classList.toggle("hidden");
    $("tv-toggle-global").textContent = hidden ? "show" : "hide";
  };

  attachBoxSelect(imgEl, () => {
    const fr = frames[cur] || {};
    return { id: entry.id, src: fr.src, label: fr.label || `f=${frameNo(cur)}` };
  }, () => {});   // plain click is a no-op (this is already the zoomed view)

  document.addEventListener("keydown", (e) => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    switch (e.key) {
      case "ArrowLeft":  stop(); step(-10); break;
      case "ArrowRight": stop(); step(10);  break;
      case ",":          stop(); step(-1);  break;
      case ".":          stop(); step(1);   break;
      case "Home":       stop(); goto(0);   break;
      case "End":        stop(); goto(frames.length - 1); break;
      case "c": case "C": toggleMark(); break;
      case " ":          e.preventDefault(); play(); break;
      default: return;
    }
    e.preventDefault();
  });
}

async function load() {
  const id = qid();
  $("tv-id").textContent = id;
  $("tv-id").onclick = () => copyToClipboard(id,
    () => showCropToast("copied id ✓ " + id, false), () => {});
  if (!id) { $("tv-status").textContent = "no ?id= in the URL"; return; }
  let entries = [];
  try {
    const res = await fetch("/data/feed.jsonl?t=" + Date.now(), { cache: "no-store" });
    const text = await res.text();
    entries = text.split("\n").map(l => l.trim()).filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (e) {
    $("tv-status").textContent = "failed to load feed";
    return;
  }
  entry = entries.find(e => e.id === id || (e.id || "").startsWith(id));
  if (!entry) { $("tv-status").textContent = `no entry matching id ${id}`; return; }
  if (entry.type !== "trace") {
    $("tv-status").textContent = `entry is type ${entry.type}, not 'trace'`;
    return;
  }
  frames = entry.frames || [];
  document.title = (entry.title || "trace") + " · trace viewer";
  $("tv-title").textContent = entry.title || "trace";
  $("tv-status").textContent = `${frames.length} frames · ${entry.fps || 20} fps`;
  $("tv-note").textContent = entry.note || "";
  globalEl.textContent = JSON.stringify(entry.global || {}, null, 2);
  wire();
  renderCaps();
  cur = 0;
  show();
}

load();
