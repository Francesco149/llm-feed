# llm-feed

A tiny live **feed** an LLM agent pushes images and comparisons to, so you
watch them stream into one browser tab instead of having a desktop image
viewer (eog / `explorer.exe`) popped at you for every screenshot.

Built for WSL2 → Windows-browser: the server binds `0.0.0.0` in WSL and you
open `http://localhost:<port>` in Windows.

## Run

```sh
# 1. start the server once (leave it running)
python3 feed.py serve            # default port 8777 (env LLM_FEED_PORT)
# open http://localhost:8777 in your browser

# 2. push items (the agent makes these calls)
python3 feed.py image shot.png --title "title screen"
python3 feed.py montage --frames-dir runs/foo/frames --title "house walk" --cols 3
python3 feed.py list
python3 feed.py clear
```

No third-party dependencies — stdlib only. Images are copied as-is into
`data/assets/<id>/`; the browser does all rendering, so the feed stays
decoupled from whatever produced the frames.

## Item types

- **`image`** — a single screenshot. Click to zoom.
- **`montage`** — a grid of frames (`--cols`, sorted by frame number). Click any
  frame to zoom into it full-res, then flip through every frame with `←`/`→`
  (or the on-screen arrows); `Esc` closes. The viewer knows the frame list, so
  it steps through real full-resolution frames, not crops of a baked grid.

Types are open-ended — `diff` / side-by-side comparisons are planned next; an
unknown type still renders (its JSON is shown) rather than being dropped.

## How it works

`feed.py` appends one JSON line per item to `data/feed.jsonl` and copies the
item's images under `data/assets/<id>/`. The single-page app polls
`data/feed.jsonl` every ~1.5 s and renders new entries newest-first. The store
(`data/`) is runtime state and is gitignored.

This is the **live** feed. The persistent offline comparison gallery
(openrecet `runs/comparisons/index.html`) is a separate artifact and stays as-is.

## License

MIT — see [LICENSE](LICENSE).
