# CLAUDE.md

This file provides guidance for AI assistants (Claude, etc.) working in the **time-flow** repository.

## Project Overview

**time-flow** is a project hosted at [leoleoyky-spec/time-flow](https://github.com/leoleoyky-spec/time-flow). The repository is in its initial setup phase.

## Repository Structure

```
time-flow/
├── CLAUDE.md                 # AI assistant guidance (this file)
└── line-animated-stamps/     # LINE アニメーションスタンプ一括作成ツール (Python + Pillow)
    ├── make_stamps.py        # 生成・仕様チェック・ZIP作成 (python make_stamps.py --demo)
    ├── stamps.csv            # スタンプ一覧のテンプレート
    ├── input/                # ユーザーのイラスト置き場
    └── tests/                # pytest (python -m pytest tests)
```

> **Note:** This project is newly initialized. Update this section as the codebase grows.

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

> **TODO:** Update this section once the project's build system and scripts are established.

## Testing

> **TODO:** Update this section once the test framework is configured.

## CI/CD

> **TODO:** Update this section once CI/CD pipelines are set up.
