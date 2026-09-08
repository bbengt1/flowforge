#!/usr/bin/env python3
"""Fail CI on reachable third-party module vulns from govulncheck JSON.

Stdlib / toolchain findings are reported but do not fail this MVP gate.
Those require a currently patched Go release at production enablement.
See deploy/supply-chain/policy.md.
"""
from __future__ import annotations

import json
import sys

STDLIB = {"stdlib", "golang.org/toolchain"}
OWN = "github.com/bbengt1/flowforge/apps/api"


def iter_json_values(text: str):
    decoder = json.JSONDecoder()
    idx = 0
    length = len(text)
    while idx < length:
        while idx < length and text[idx].isspace():
            idx += 1
        if idx >= length:
            break
        value, end = decoder.raw_decode(text, idx)
        yield value
        idx = end


def vulnerable_module(finding: dict) -> str:
    trace = finding.get("trace") or []
    if not trace or not isinstance(trace[0], dict):
        return ""
    return trace[0].get("module") or ""


def is_called(finding: dict) -> bool:
    for frame in finding.get("trace") or []:
        if not isinstance(frame, dict):
            continue
        if frame.get("function") or frame.get("package"):
            return True
    return False


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: govulncheck-gate.py <govulncheck.json>", file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as fh:
        text = fh.read()

    third_party: list[str] = []
    stdlib: list[str] = []
    for event in iter_json_values(text):
        if not isinstance(event, dict):
            continue
        finding = event.get("finding")
        if not isinstance(finding, dict) or not is_called(finding):
            continue
        osv = finding.get("osv") or "unknown"
        module = vulnerable_module(finding)
        line = f"{osv} module={module or 'unknown'}"
        if module in STDLIB or module == OWN or module == "":
            if module in STDLIB:
                stdlib.append(line)
            continue
        third_party.append(line)

    if stdlib:
        unique_std = sorted(set(stdlib))
        print(f"govulncheck: {len(unique_std)} stdlib/toolchain finding(s) recorded (not a CI fail)")
        for line in unique_std:
            print(f"  warn {line}")
    if third_party:
        print("govulncheck: rejecting vulnerable third-party modules:", file=sys.stderr)
        for line in sorted(set(third_party)):
            print(f"  fail {line}", file=sys.stderr)
        return 1
    print("govulncheck: no reachable third-party module vulnerabilities")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
