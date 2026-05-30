# llm-feed — instructions for an AI agent

This is a live **feed** for showing the user visuals (images, montages, diff
comparisons). Push to it instead of opening a desktop image viewer. The user
keeps one browser tab open at `http://localhost:8777`.

There is **no bare `python3`** on this NixOS box — always invoke via
`nix run nixpkgs#python3 -- …`.

## At session start: ensure the server is running

```sh
curl -sf http://localhost:8777/healthz        # prints "ok" if up
# if NOT up, start it as a background process and leave it running:
cd /opt/src/llm-feed && nix run nixpkgs#python3 -- /opt/src/llm-feed/feed.py serve
```

Don't start a second copy if one is already up (a second bind just fails).

## Pushing

Always pass a clear `--title` and a short `--note` (context). Each push gets a
unique anchor id shown on the card; the user can click it to copy, then paste it
back to refer to that push.

```sh
P="nix run nixpkgs#python3 -- /opt/src/llm-feed/feed.py"

$P image  shot.png --title "title screen" --note "frame 30, cursor on NEW GAME"
$P montage --frames-dir <dir> --glob 'frame_*.bmp' --cols 3 \
           --title "house walk" --note "free-roam: idle then walking left"
$P comparison --spec spec.json --title "port|retail" --note "render parity"
$P list
$P get <id-or-prefix>     # recover a push's description + source paths
$P clear
```

- **montage** — a grid of frames; clicking a frame zooms it full-res and flips
  through all frames with ←/→.
- **comparison** — port|retail atlases with a click-to-reveal amplified diff
  (like an offline comparison gallery). The diff math (PIL/numpy) is the
  producer's job; `--spec` ingests pre-built atlas PNGs + geometry. Schema is in
  `feed.py`'s `cmd_comparison` docstring. (In the openrecet project,
  `tools/push_comparison.py` builds + pushes one for a scenario.)

## Looking a push back up

When the user pastes an anchor id, run `feed.py get <id>` — it prints the full
stored entry (description, original frame/source paths, run dir, diff stats).

`data/` (pushed items + copied assets) is runtime state and is gitignored.
