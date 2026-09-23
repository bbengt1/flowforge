#!/usr/bin/env python3
"""Fail when published docs leak process or point at internal notes.

Published product docs are every Markdown file under docs/ except docs/internal/.
docs/internal/ holds planning, gap analysis, and backlog notes and is not
operator documentation.

This check fails when a published Markdown file:

- links to docs/internal/ (any relative or repo-root form)
- contains a GitHub issue or pull number (#123, or a github.com/.../issues|pull/123 link)
- contains a contributor name (Chloe, jonny, Arie, Gracie, Terry, Brent, Bengtson)

Story ids (E12.3, ADV-021, G.1.1) are product vocabulary and are allowed.
Heading anchors such as #refused-boot are allowed. A #digits token followed by
a hyphen and a letter is treated as an anchor slug, not an issue number.

Run from the repository root:

    python3 scripts/check-public-docs.py

Wired into the supply-chain policy job.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
INTERNAL = DOCS / "internal"

# Contributor names that leak process into product docs.
# Word boundaries keep source-path tokens such as e12-chloe-ui-contract.test.ts
# out of this scan; those module names are not rewritten here.
NAME_RE = re.compile(
    r"(?<![-_\w./])(?:Chloe|jonny|Jonny|Arie|Gracie|Terry|Brent|Bengtson)(?:['’]s)?(?![-_\w])"
)

# GitHub issue/PR numbers. Not heading markers (# Title), not anchor slugs
# (#10-open-questions), and not hex colors (#0f766e).
ISSUE_RE = re.compile(
    r"(?:https://github\.com/bbengt1/flowforge/(?:issues|pull)/\d+\b)"
    r"|(?<![\w/&#$])#\d{1,4}(?!\d)(?![A-Fa-f0-9])(?!-[A-Za-z0-9]+-)(?:-era)?"
)

INTERNAL_LINK_RE = re.compile(
    r"\[[^\]]*\]\(([^)]+)\)"
)


def published_markdown() -> list[Path]:
    files: list[Path] = []
    for path in DOCS.rglob("*.md"):
        if INTERNAL in path.parents or path == INTERNAL:
            continue
        files.append(path)
    return sorted(files)


def link_targets_internal(url: str) -> bool:
    target = url.strip().split("#", 1)[0].strip()
    if not target:
        return False
    if target.startswith(("http://", "https://", "mailto:")):
        return False
    normalized = target.replace("\\", "/")
    if normalized.startswith("/"):
        normalized = normalized.lstrip("/")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    # Collapse .. for a cheap containment check without touching the filesystem.
    stack: list[str] = []
    for part in parts:
        if part == "..":
            if stack:
                stack.pop()
            continue
        stack.append(part)
    return "internal" in stack and (
        not stack or stack[0] == "docs" or "internal" in stack
    ) and _stack_is_internal(stack)


def _stack_is_internal(stack: list[str]) -> bool:
    if "internal" not in stack:
        return False
    # docs/internal/... or a relative internal/... from somewhere under docs/.
    idx = stack.index("internal")
    if idx == 0:
        return True
    return stack[idx - 1] == "docs"


def check_file(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    rel = path.relative_to(ROOT).as_posix()
    problems: list[str] = []
    for lineno, line in enumerate(text.splitlines(), 1):
        for match in ISSUE_RE.finditer(line):
            problems.append(f"{rel}:{lineno}: GitHub issue/PR reference {match.group(0)!r}")
        for match in NAME_RE.finditer(line):
            problems.append(f"{rel}:{lineno}: contributor name {match.group(0)!r}")
        if "docs/internal/" in line or re.search(r"(?<![\w.-])internal/", line):
            # Bare paths and markdown links. Relative internal/ from docs/ is the leak.
            if "docs/internal/" in line or "](internal/" in line or "](../internal/" in line or "](../../internal/" in line:
                problems.append(f"{rel}:{lineno}: reference to docs/internal")
        for match in INTERNAL_LINK_RE.finditer(line):
            url = match.group(1).strip()
            if link_targets_internal(url) or "docs/internal/" in url:
                problems.append(f"{rel}:{lineno}: link into docs/internal ({url})")
    return problems


def check_filenames() -> list[str]:
    problems: list[str] = []
    name_file = re.compile(r"chloe|jonny|arie|gracie|terry|brent|bengtson", re.I)
    for path in DOCS.rglob("*"):
        if not path.is_file():
            continue
        if INTERNAL in path.parents:
            continue
        if name_file.search(path.name):
            rel = path.relative_to(ROOT).as_posix()
            problems.append(f"{rel}: published filename contains a contributor name")
    return problems


def main() -> int:
    problems: list[str] = []
    problems.extend(check_filenames())
    for path in published_markdown():
        problems.extend(check_file(path))
    if problems:
        print("published docs check failed:", file=sys.stderr)
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1
    print(f"published docs check ok ({len(published_markdown())} markdown files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
