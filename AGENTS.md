# AGENTS.md

Guidance for coding agents working on this project. See `README.md` for what the page does.

## Architecture

- Static page, no build step and no dependencies. It must keep working when opened from `file://`:
  - Data is loaded with a `<script>` tag (`aa-data.js`), never with `fetch`.
  - No CDN libraries. The chart is hand-made SVG in `aa-plot.js`.
- Load order in the HTML: `aa-data.js`, then `aa-plot.js`.
- `aa-data.js` is **generated** by `refresh_aa_data.py`. Do not edit it by hand. Its first line is a
  comment, and everything after `\nwindow.AA_DATA = ` is plain JSON.

## Data model

- `columns`: `{ key, label, group, type }`. Types: `num`, `pct` (stored 0-100), `usd`, `tps`, `s`, `tok`.
  The list lives in `COLUMNS` in `refresh_aa_data.py`. Add or rename columns there.
- `models`: `{ name, slug, creator, license, intelligenceEstimated, deprecated, firstSeen, lastSeen,
  [deprecationDate], [retired, retiredDate], <column key>: value }`. Missing values are omitted.
- `slug` is the unique identity used for merging. Names can change.
- Model family = name without the trailing `(…)`. Thinking level = that suffix without " with fallback",
  and only when it matches `low|medium|high|xhigh|max|non-reasoning`.

## Refresh script rules

- Standard library only.
- The page embeds a Next.js payload with JSON escaped as `\"`. Arrays are found by content, not key
  name, because key names changed before (`models` became `initialModels`):
  - Scores: the largest list whose items have `intelligenceIndex` and `shortName`.
  - Catalog: `releases` (`releaseDate`, `deprecated`) and a model→`releaseSlug` map. They say whether a
    model with no scores is deprecated (still in the catalog) or retired (gone).
- The merge must never drop models, because `aa-data.js` is the only copy of older scores.
- Running the script twice on the same page must give an identical file.
- To test without touching the real data, use `--input <saved page> --output <scratch file>`.

## UI state

- Stored in localStorage under `aa-plot-state`. Fields: `x`, `y`, `xl`, `yl`, `f` (focus), `r` (show
  retired/deprecated), `h` (hidden families), `o` (open vendor lists).
- Wrap every storage access in try/catch.
- Call `restoreState()` before the first `draw()`, because `draw()` saves state.
- The first visit must show cost per task (log) against intelligence. Reset axes changes only X/Y and
  their log settings.

## Code style

- Readable code, descriptive names, one statement per line. Match the existing section comments.
- CSS: one property per line, grouped in the existing sections.
- `aa-plot.js` relies on these class and id names: `.dot`, `.dot.hl`, `.dot.old`, `.vend`, `.tg`,
  `.fams`, `.fs`, `.off`, `#tip .caveat`, `#src`.

## Verifying changes

- Local server: `.claude/launch.json` defines `plot` (`python -m http.server 8765`).
  Open http://localhost:8765/intelligence-vs-cost.html.
- Check that there are no console errors, the default view has about 120 points, and hover tooltips work.
- Clear `localStorage` after testing, so test state doesn't leak into the user's view.
