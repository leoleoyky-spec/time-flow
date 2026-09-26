# CLAUDE.md

This file provides guidance for AI assistants (Claude, etc.) working in the **time-flow** repository.

## Project Overview

**time-flow** is a project hosted at [leoleoyky-spec/time-flow](https://github.com/leoleoyky-spec/time-flow). It currently contains **うごくスタンプメーカー**, a dependency-free browser app that creates LINE animated stickers (APNG).

## Repository Structure

```
time-flow/
├── CLAUDE.md            # AI assistant guidance (this file)
├── index.html           # App markup (Japanese UI)
├── css/style.css        # Styles (light/dark, responsive)
├── js/encoder.js        # APNG assembly, palette quantizer, indexed PNG, ZIP (browser + Node)
├── js/animations.js     # Sticker drawing: motions, effects, text layout
├── js/app.js            # UI state, preview, export, localStorage persistence
├── test/                # node:test unit tests for js/encoder.js
└── package.json         # npm scripts (no dependencies)
```

LINE animated sticker rules the app enforces: 320×270 px, 5–20 frames, total playback ≤ 4 s,
1–4 loops, ≤ 300 KB per file, sets of 8/16/24, plus `main.png` (240×240 APNG) and `tab.png` (96×74).

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

## Testing

`npm test` runs the Node built-in test runner (`node --test`) against `test/*.test.js`.

## CI/CD

> **TODO:** Update this section once CI/CD pipelines are set up.
