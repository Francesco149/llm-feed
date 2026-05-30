#!/usr/bin/env python3
"""
llm-feed — a tiny live "feed" an LLM agent pushes images + comparisons to.

Instead of popping a desktop image viewer (eog / explorer.exe) for every
screenshot or montage, the agent pushes typed items to this feed; you watch
them stream into one browser tab that polls for new entries. Built for the
WSL2 → Windows-browser setup (bind 0.0.0.0, open http://localhost:<port>).

Two roles, one file:

  # 1. long-running server (start once, leave running)
  feed.py serve [--port 8777] [--host 0.0.0.0]

  # 2. push items (each is a quick CLI call the agent makes)
  feed.py image  PATH [--title T] [--note N]
  feed.py montage [--frames-dir DIR | --frames F...] [--glob 'frame_*.bmp']
                  [--title T] [--cols 3] [--labels a,b,c] [--note N]
  feed.py clear
  feed.py list

Item types are open-ended (montage today; diff / comparison later). Each push
copies its assets into data/assets/<id>/ and appends one JSON line to
data/feed.jsonl; the browser polls that file. No third-party deps — stdlib
only (images are copied as-is, the browser does all rendering), so this app
stays decoupled from whatever produced the frames.

This is the LIVE feed; the persistent offline comparison gallery
(openrecet runs/comparisons/index.html) is a separate artifact.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import sys
from pathlib import Path

ROOT   = Path(__file__).resolve().parent
WEB    = ROOT / "web"
DATA   = ROOT / "data"
ASSETS = DATA / "assets"
FEED   = DATA / "feed.jsonl"

DEFAULT_PORT = int(os.environ.get("LLM_FEED_PORT", "8777"))
IMAGE_EXTS = {".png", ".bmp", ".jpg", ".jpeg", ".gif", ".webp"}
_FRAME_RE = re.compile(r"(\d+)")


# ─── id / store helpers ─────────────────────────────────────────────────────


def _now():
    return dt.datetime.now(dt.timezone.utc)


def _new_id() -> str:
    """Sortable, collision-resistant id: UTC timestamp + 4 hex from urandom."""
    return _now().strftime("%Y%m%dT%H%M%S_") + os.urandom(2).hex()


def _ensure_store() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)


def _append(entry: dict) -> None:
    _ensure_store()
    with FEED.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def _copy_asset(src: Path, item_id: str, name: str) -> str:
    """Copy `src` into data/assets/<id>/<name>; return the web-relative URL."""
    dest_dir = ASSETS / item_id
    dest_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest_dir / name)
    return f"data/assets/{item_id}/{name}"


def _read_feed() -> list[dict]:
    if not FEED.exists():
        return []
    out = []
    for line in FEED.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return out


def _frame_no(p: Path) -> int:
    m = _FRAME_RE.search(p.stem)
    return int(m.group(1)) if m else -1


def _feed_url() -> str:
    return f"http://localhost:{DEFAULT_PORT}/"


# ─── push: image ────────────────────────────────────────────────────────────


def cmd_image(args) -> int:
    src = Path(args.path)
    if not src.is_file():
        print(f"feed image: not a file: {src}", file=sys.stderr)
        return 1
    item_id = _new_id()
    ext = src.suffix.lower() if src.suffix.lower() in IMAGE_EXTS else ".png"
    url = _copy_asset(src, item_id, f"image{ext}")
    entry = {
        "id":    item_id,
        "ts":    _now().timestamp(),
        "iso":   _now().isoformat(timespec="seconds"),
        "type":  "image",
        "title": args.title or src.name,
        "note":  args.note or "",
        "src":   url,
        "source": str(src.resolve()),   # original path, for `feed.py get`
    }
    _append(entry)
    print(f"pushed image '{entry['title']}' → {_feed_url()}")
    return 0


# ─── push: montage ──────────────────────────────────────────────────────────


def _gather_frames(args) -> list[Path]:
    frames: list[Path] = []
    if args.frames_dir:
        d = Path(args.frames_dir)
        pat = args.glob or "frame_*"
        frames = [p for p in d.glob(pat)
                  if p.is_file() and p.suffix.lower() in IMAGE_EXTS]
        frames.sort(key=_frame_no)
    if args.frames:
        frames += [Path(f) for f in args.frames]
    # de-dup preserving order
    seen, uniq = set(), []
    for f in frames:
        r = f.resolve()
        if r not in seen and f.is_file():
            seen.add(r)
            uniq.append(f)
    return uniq


def cmd_montage(args) -> int:
    frames = _gather_frames(args)
    if not frames:
        print("feed montage: no frames found (use --frames-dir/--glob or --frames)",
              file=sys.stderr)
        return 1

    labels: list[str] | None = None
    if args.labels:
        labels = [s.strip() for s in args.labels.split(",")]

    item_id = _new_id()
    frame_entries = []
    for i, fp in enumerate(frames):
        ext = fp.suffix.lower() if fp.suffix.lower() in IMAGE_EXTS else ".png"
        url = _copy_asset(fp, item_id, f"f{i:03d}{ext}")
        if labels and i < len(labels):
            label = labels[i]
        else:
            n = _frame_no(fp)
            label = f"f={n}" if n >= 0 else fp.stem
        frame_entries.append({"src": url, "label": label, "name": fp.name,
                              "source": str(fp.resolve())})

    entry = {
        "id":     item_id,
        "ts":     _now().timestamp(),
        "iso":    _now().isoformat(timespec="seconds"),
        "type":   "montage",
        "title":  args.title or f"montage ({len(frames)} frames)",
        "note":   args.note or "",
        "cols":   int(args.cols),
        "frames": frame_entries,
        # Original source location(s), for `feed.py get <id>` retrieval.
        "frames_dir": str(Path(args.frames_dir).resolve()) if args.frames_dir else "",
    }
    _append(entry)
    print(f"pushed montage '{entry['title']}' "
          f"({len(frames)} frames, {args.cols} cols) → {_feed_url()}")
    return 0


# ─── push: comparison (port|retail with click-to-reveal amplified diff) ──────


def cmd_comparison(args) -> int:
    """Push a `comparison` item — behaves like runs/comparisons/index.html.

    The diff math (PIL/numpy) lives in the producer, so this just ingests a
    JSON spec of pre-built atlas PNGs + their geometry. Spec schema:

      {
        "title": "...", "note": "...",
        "left_label": "openrecet", "right_label": "retail",
        "panels": [
          {"atlas": "/abs/atlas_00.png", "label": "cap_00",
           "row0_pct": 39.46, "total_pct": 116.41,
           "differ_px": 0, "meanabs": 0.0},
          ...
        ]
      }

    Each atlas is a single PNG laid out as row 0 = [left | right] (always
    shown) and row 1 = amplified diff (revealed on click); row0_pct/total_pct
    are the clip heights as a % of atlas width, exactly as
    openrecet tools/comparison_page.py emits them.
    """
    spec_path = Path(args.spec)
    if not spec_path.is_file():
        print(f"feed comparison: spec not found: {spec_path}", file=sys.stderr)
        return 1
    spec = json.loads(spec_path.read_text())
    panels_in = spec.get("panels") or []
    if not panels_in:
        print("feed comparison: spec has no panels", file=sys.stderr)
        return 1

    item_id = _new_id()
    panels_out = []
    for i, p in enumerate(panels_in):
        atlas = Path(p["atlas"])
        if not atlas.is_file():
            print(f"feed comparison: atlas missing: {atlas}", file=sys.stderr)
            continue
        url = _copy_asset(atlas, item_id, f"atlas_{i:02d}.png")
        panels_out.append({
            "src":       url,
            "label":     p.get("label", f"cap_{i:02d}"),
            "row0_pct":  float(p.get("row0_pct", 50.0)),
            "total_pct": float(p.get("total_pct", 100.0)),
            "differ_px": p.get("differ_px"),
            "meanabs":   p.get("meanabs"),
            "source":    str(atlas.resolve()),
        })
    if not panels_out:
        print("feed comparison: no usable panels", file=sys.stderr)
        return 1

    entry = {
        "id":          item_id,
        "ts":          _now().timestamp(),
        "iso":         _now().isoformat(timespec="seconds"),
        "type":        "comparison",
        "title":       args.title or spec.get("title") or "comparison",
        "note":        args.note or spec.get("note", ""),
        "left_label":  spec.get("left_label", "left"),
        "right_label": spec.get("right_label", "right"),
        "panels":      panels_out,
    }
    _append(entry)
    print(f"pushed comparison '{entry['title']}' "
          f"({len(panels_out)} panels) → {_feed_url()}")
    return 0


# ─── get / clear / list ─────────────────────────────────────────────────────


def cmd_get(args) -> int:
    """Print the full stored entry for an id (exact, or unique prefix), so a
    pasted anchor resurfaces its description + original frame paths."""
    matches = [e for e in _read_feed()
               if e.get("id") == args.id or e.get("id", "").startswith(args.id)]
    if not matches:
        print(f"feed get: no entry matching id {args.id!r}", file=sys.stderr)
        return 1
    if len(matches) > 1:
        print(f"feed get: {len(matches)} entries match prefix {args.id!r}: "
              + ", ".join(e["id"] for e in matches), file=sys.stderr)
        return 1
    print(json.dumps(matches[0], indent=2))
    return 0


# ─── clear / list ───────────────────────────────────────────────────────────


def cmd_clear(args) -> int:
    if ASSETS.exists():
        shutil.rmtree(ASSETS)
    if FEED.exists():
        FEED.unlink()
    _ensure_store()
    print("feed cleared")
    return 0


def cmd_list(args) -> int:
    for e in _read_feed():
        extra = (f"{len(e.get('frames', []))} frames"
                 if e["type"] == "montage" else e.get("src", ""))
        print(f"{e['iso']}  {e['type']:8}  {e['title']}  [{extra}]")
    return 0


# ─── serve ──────────────────────────────────────────────────────────────────


def cmd_serve(args) -> int:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import mimetypes

    _ensure_store()

    class Handler(BaseHTTPRequestHandler):
        # Quiet by default; one line per non-asset request.
        def log_message(self, fmt, *a):
            if "/data/assets/" in self.path:
                return
            sys.stderr.write("feed: " + (fmt % a) + "\n")

        def _send_file(self, path: Path, ctype: str | None = None):
            if not path.is_file():
                self.send_error(404)
                return
            ctype = ctype or (mimetypes.guess_type(str(path))[0]
                              or "application/octet-stream")
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            # The feed file + assets must never be cached or polling goes stale.
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/", "/index.html"):
                return self._send_file(WEB / "index.html", "text/html; charset=utf-8")
            if path == "/healthz":
                self.send_response(200); self.end_headers()
                self.wfile.write(b"ok")
                return
            if path == "/app.js":
                return self._send_file(WEB / "app.js", "application/javascript")
            if path == "/style.css":
                return self._send_file(WEB / "style.css", "text/css")
            if path == "/data/feed.jsonl":
                # Always 200, even when empty, so the client polls cleanly.
                if not FEED.exists():
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    return
                return self._send_file(FEED, "text/plain; charset=utf-8")
            if path.startswith("/data/assets/"):
                # Resolve safely under ASSETS (no path traversal).
                rel = path[len("/data/assets/"):]
                target = (ASSETS / rel).resolve()
                if ASSETS.resolve() in target.parents or target == ASSETS.resolve():
                    return self._send_file(target)
                self.send_error(403)
                return
            self.send_error(404)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://localhost:{args.port}/"
    print(f"llm-feed serving on {args.host}:{args.port}  →  {url}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nllm-feed: shutting down")
    return 0


# ─── cli ────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("serve", help="run the feed HTTP server (long-running)")
    sp.add_argument("--port", type=int, default=DEFAULT_PORT,
                    help=f"server port (default {DEFAULT_PORT}; env LLM_FEED_PORT)")
    sp.add_argument("--host", default="0.0.0.0",
                    help="bind host (default 0.0.0.0 so the Windows browser can "
                         "reach the WSL server via localhost)")
    sp.set_defaults(func=cmd_serve)

    si = sub.add_parser("image", help="push a single image")
    si.add_argument("path")
    si.add_argument("--title", default="")
    si.add_argument("--note", default="")
    si.set_defaults(func=cmd_image)

    sm = sub.add_parser("montage", help="push a clickable frame grid (flip-through)")
    sm.add_argument("--frames-dir", default=None,
                    help="directory of frames (sorted by frame number)")
    sm.add_argument("--glob", default=None,
                    help="glob within --frames-dir (default 'frame_*')")
    sm.add_argument("--frames", nargs="*", default=None,
                    help="explicit frame files (appended after --frames-dir)")
    sm.add_argument("--title", default="")
    sm.add_argument("--cols", type=int, default=3)
    sm.add_argument("--labels", default=None, help="comma-separated per-frame labels")
    sm.add_argument("--note", default="")
    sm.set_defaults(func=cmd_montage)

    sc = sub.add_parser("comparison",
                        help="push a port|retail click-to-reveal-diff item "
                             "(like runs/comparisons/index.html)")
    sc.add_argument("--spec", required=True,
                    help="JSON spec of pre-built atlas PNGs + geometry "
                         "(see cmd_comparison docstring)")
    sc.add_argument("--title", default="")
    sc.add_argument("--note", default="")
    sc.set_defaults(func=cmd_comparison)

    sg = sub.add_parser("get", help="print the full stored entry for an id/prefix")
    sg.add_argument("id")
    sg.set_defaults(func=cmd_get)

    sub.add_parser("clear", help="wipe the feed").set_defaults(func=cmd_clear)
    sub.add_parser("list",  help="print feed entries").set_defaults(func=cmd_list)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
