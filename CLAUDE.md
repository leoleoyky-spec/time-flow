# CLAUDE.md

This file provides guidance for AI assistants (Claude, etc.) working in the **time-flow** repository.

## Project Overview

**time-flow** is a project hosted at [leoleoyky-spec/time-flow](https://github.com/leoleoyky-spec/time-flow). It currently contains **うごくスタンプメーカー**, a dependency-free browser app that creates LINE animated stickers (APNG).

## Repository Structure

```
time-flow/
├── CLAUDE.md            # AI assistant guidance (this file)
├── index.html           # App markup (Japanese UI; editor split into 4 tabs)
├── css/style.css        # Styles (light/dark, responsive)
├── js/encoder.js        # APNG assembly, palette quantizer, indexed PNG, ZIP (browser + Node)
├── js/animations.js     # Sticker drawing: motions, effects, text layout
├── js/motion-words.js   # Japanese text → motion sliders / whole-sticker settings (browser + Node)
├── js/bg-remove.js      # Background removal on raw RGBA pixels (browser + Node)
├── js/parts.js          # Moving one traced part: rubber-like bend mesh, joint guess (browser + Node)
├── js/sprite.js         # Frame art: sprite-sheet grid finding, jitter alignment, frame counts (browser + Node)
├── js/app.js            # UI state, preview, export, localStorage persistence
├── test/                # node:test unit tests for the browser+Node modules
└── package.json         # npm scripts (no dependencies)
```

LINE animated sticker rules the app enforces: at most 320×270 px with one side ≥ 270, 5–20 frames,
total playback ≤ 4 s, 1–4 loops, ≤ 300 KB per file (300,000 bytes), sets of 8/16/24, plus `main.png`
(240×240 APNG) and `tab.png` (96×74). LINE also rejects drawings cut off at the edge and still margins,
so export (`renderFitted()` in `js/app.js`) draws every frame with room around it, crops to the area any
frame uses and scales that to the largest size that fits (`lineStickerSize()` in `js/encoder.js`).

Two features worth knowing about when touching `js/app.js` or `js/animations.js`:
- **Background removal**: `removeBackgroundPixels()` in `js/bg-remove.js` flood-fills a flat
  background out of an uploaded image (color picked by click or auto-detected from opaque corners).
  The background-colored area is eroded before the fill so it can't leak through small gaps in a
  crayon/pencil outline into the inside of the drawing (a real bug: white panda faces got erased),
  then grown back and the edge feathered. Keep the strength slider capped (max 45): above that the
  outline itself matches the background and nothing can protect the drawing. A sticker keeps both
  `originalImage` (untouched upload) and `image` (what's drawn), so toggling or re-tuning removal
  never re-compresses the source.
- **Custom motion**: the `custom` entry in `MOTIONS` (`js/animations.js`) reads per-sticker sliders
  from `sticker.custom` (wave shape, speed, move X/Y, rotate, zoom) instead of a fixed formula, for
  when the built-in motion presets aren't specific enough. Users can also type the motion in
  Japanese ("大きく2回跳ねる"); `parseMotionText()` in `js/motion-words.js` maps keywords to those
  slider values; the same file's `parseInstruction()` powers the 「言葉でおまかせ」 box, reading
  quoted sticker text, colors (assigned to the nearest noun: 文字/フチ/effect), effect, font, size
  and timing from one sentence. Both are deliberately keyword-based (no AI call) so the app stays
  free and offline for whoever it's shared with. The custom motion has no sliders in the UI any
  more (users found them meaningless); the うごき tab offers one-tap whole-body presets and, below,
  worded/traced part motions, and a worded whole-body motion shows as the 「おまかせの動き」 chip.
- **Moving one part** ("左手だけ振る"): the user traces the part on the picture (`sticker.parts`:
  name, outline and joint in 0–1 image coords, motion cfg). Parts are not cut out (that left the
  old hand behind and tore the wrist): `buildMesh()` in `js/parts.js` lays a grid over the picture
  whose points follow the part fully inside the outline and less and less just outside it (more
  generously near the joint), and `drawFrame()` draws the touched cells as textured triangles.
  The app can't find a hand by itself (that would need AI image recognition), so worded part
  requests (`parsePartRequests()`, several per sentence) queue each untraced part for tracing.
  A **wink** is different: bending a loosely traced eye area also squashed the mouth and cheek,
  so `findEye()` picks the dark patch inside the trace, the base picture gets it painted over with
  the surrounding skin, and `drawWinks()` draws it open, squashed, or as a closed-eye arc.

- **Text and picture layout**: `layoutSticker()` in `js/animations.js` is the single source of
  where the picture and text sit (including the user's drag offsets `textPos`/`imagePos`, as
  fractions of the sticker size); both drawing and the preview's drag hit-test use it. Text can be
  curved along an arc (`textCurve`, −100 smile … 100 arch) and tilted (`textRotate`).

- **Quick set** (「絵をまとめて読み込む」 in the list panel): the easy path for most users. One
  picture holding a whole set (e.g. a 4×4 sheet of different stickers) or several pictures:
  background removed, `findStickers()` in `js/sprite.js` cuts it into trimmed stickers (grids
  under 4 cells count as one sticker), and each gets a motion + effect from `LOOKS` in
  `js/app.js`; one tap reshuffles them all. New stickers replace blank ones and cap at 24.

- **Frame art** (`sticker.mode === 'frames'`): for motions the app can't make from one picture
  (walking, winking, anything), an image AI draws the poses. The 画像 tab builds the request to
  paste into ChatGPT/Gemini (`buildSpritePrompt()` in `js/motion-words.js`), and imports the
  result: a sprite sheet (grid found by `findGrid()`, which tries grids whose cut lines run through
  empty space with even, square-ish frames), several frame images / GIF / APNG (via
  `ImageDecoder` where available), or a video (frames seeked out of a `<video>`). `makeFrames()` in
  `js/app.js` puts them on one canvas, steadies AI jitter with `alignFrames()` (bounded shift so a
  jump survives), trims, and stores `frameImages` + per-frame `frameAdj` nudges. The app itself
  still calls no AI. Pictures are kept in IndexedDB (`idb:<key>` refs in the localStorage JSON)
  because frames outgrow localStorage.

## Development Workflow

### Branch Naming

- Feature branches: `feature/<description>`
- Bug fixes: `fix/<description>`
- Documentation: `docs/<description>`

### Commit Messages

- Use clear, descriptive commit messages
- Start with a verb in imperative mood (e.g., "Add", "Fix", "Update", "Remove")
- Keep the subject line under 72 characters
- Add a body for non-trivial changes

### Pull Requests

- Provide a summary of changes
- Reference related issues where applicable
- Ensure CI checks pass before merging

## Conventions for AI Assistants

### General Guidelines

- **Read before editing:** Always read existing files before modifying them
- **Minimal changes:** Only change what is necessary to accomplish the task
- **No unnecessary additions:** Don't add comments, docstrings, or type annotations to code you didn't change
- **Preserve style:** Match the existing code style and conventions in the project
- **Test your changes:** Run the project's test suite after making changes

### Code Quality

- Follow the linting and formatting rules configured in the project
- Do not introduce new dependencies without justification
- Avoid security vulnerabilities (injection, XSS, etc.)

### When Adding New Features

1. Understand the existing architecture first
2. Follow established patterns in the codebase
3. Add tests for new functionality
4. Update documentation if needed

### When Fixing Bugs

1. Reproduce and understand the bug
2. Write a minimal fix
3. Don't refactor surrounding code unless asked
4. Add a regression test if applicable

## Build & Run

No build step. Serve the repo root over HTTP and open it: `npm start` (runs `python3 -m http.server 8000`).
Opening `index.html` directly via `file://` also works (plain scripts, no ES modules).

The app is also shared as a claude.ai Artifact, where saving goes through the `downloads`
capability; that only works for members of the owner's organization. Everyone else is pointed to
the public copy served by GitHub Pages from this repo (`PUBLIC_URL` in `js/app.js`), where an
ordinary download works.

## Testing

`npm test` runs the Node built-in test runner (`node --test`) against `test/*.test.js`.

## CI/CD

> **TODO:** Update this section once CI/CD pipelines are set up.
