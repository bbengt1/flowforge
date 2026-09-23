#!/usr/bin/env python3
"""Fail when product docs leak process or link into docs/internal/.

Product documentation is every Markdown file under docs/ except docs/internal/.
docs/internal/ holds planning and gap notes and is not operator documentation.

The check fails when a product page contains:

- a GitHub issue or pull number (#123, or a bbengt1/flowforge issues/pull URL)
- a contributor name used as process (Chloe, jonny, Arie, Gracie, Terry, Brent).
  The copyright notice "Brent Bengtson" is allowed.
- a link or path into docs/internal/

Hex colors (#0f766e, #000), PKCS#8, and heading anchors (#111-ui-surfaces)
are not issue numbers.

Usage (repo root): python3 scripts/check-public-docs.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
INTERNAL = DOCS / "internal"

# Issue numbers are # plus 1–5 digits. Not PKCS#8 (preceded by a word
# character), not a 6-digit hex color, not #000 (black), not a heading
# anchor (#111-ui-surfaces, digit run followed by a hyphen).
ISSUE_RE = (
    r"(?<![\w&])#(?!000\b)\d{1,5}\b(?!-)"
    r"|https://github\.com/bbengt1/flowforge/(?:issues|pull)/\d+"
)
NAME_RE = r"\b(?:Chloe|Jonny|jonny|Arie|Gracie|Terry|Brent)\b"
INTERNAL_RE = (
    r"docs/internal/"
    r"|\]\(\./internal/"
    r"|\]\(\.\./internal/"
    r"|\]\(\.\./\.\./internal/"
    r"|\]\(internal/"
)

import re

ISSUE = re.compile(ISSUE_RE)
NAME = re.compile(NAME_RE)
INTERNAL_LINK = re.compile(INTERNAL_RE)


def product_markdown() -> list[Path]:
    files = []
    for path in sorted(DOCS.rglob("*.md")):
        if INTERNAL in path.parents or path == INTERNAL:
            continue
        files.append(path)
    return files


def scan(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    rel = path.relative_to(ROOT)
    problems = []
    for i, line in enumerate(text.splitlines(), start=1):
        if ISSUE.search(line):
            problems.append(f"{rel}:{i}: GitHub issue or pull number")
        if NAME.search(line.replace("Brent Bengtson", "")):
            problems.append(f"{rel}:{i}: contributor name")
        if INTERNAL_LINK.search(line):
            problems.append(f"{rel}:{i}: link into docs/internal/")
    return problems


def main() -> int:
    problems: list[str] = []
    files = product_markdown()
    if not files:
        print("no product docs found", file=sys.stderr)
        return 1
    for path in files:
        problems.extend(scan(path))
    if problems:
        print(f"public docs check failed ({len(problems)}):", file=sys.stderr)
        for item in problems:
            print(item, file=sys.stderr)
        return 1
    print(f"public docs check ok ({len(files)} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
