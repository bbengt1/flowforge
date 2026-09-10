#!/usr/bin/env python3
"""E12.1 security verification suite harness.

Wires existing Go / web / provenance checks into a named gate.
Relates to #182 / Part of #181. Keep #182 open.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REQUIRED_DOMAINS = (
    "identity-session-embed",
    "webhook-safety",
    "cross-workspace-isolation",
    "approval-expiry",
    "credential-artifact-revocation",
    "artifact-output-authz",
    "stale-worker-fencing",
    "provider-failure",
    "ssrf-redirect-dns-rebinding",
    "dependency-image-provenance",
)


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_catalog(root: Path) -> dict[str, Any]:
    path = root / "scripts" / "e12-security-suite.json"
    catalog = json.loads(path.read_text())
    ids = [d["id"] for d in catalog["domains"]]
    missing = [d for d in REQUIRED_DOMAINS if d not in ids]
    extra = [d for d in ids if d not in REQUIRED_DOMAINS]
    if missing or extra:
        raise SystemExit(f"catalog domain mismatch missing={missing} extra={extra}")
    return catalog


def short_pkg(full: str) -> str:
    marker = "/internal/"
    if marker not in full:
        return full
    rest = full.split(marker, 1)[1]
    return "./internal/" + rest.split("/", 1)[0]


def git_sha(root: Path) -> str:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, text=True, stderr=subprocess.DEVNULL
        )
        return out.strip()
    except subprocess.CalledProcessError:
        return os.environ.get("GITHUB_SHA", "unknown")


def run_cmd(argv: list[str], cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    if env:
        merged.update(env)
    return subprocess.run(argv, cwd=cwd, env=merged, text=True, capture_output=True)


def parse_go_json(text: str) -> tuple[dict[tuple[str, str], dict[str, Any]], list[str], bool]:
    tests: dict[tuple[str, str], dict[str, Any]] = {}
    outputs: dict[tuple[str, str], list[str]] = defaultdict(list)
    package_fail: list[str] = []
    build_failed = False
    for raw in text.splitlines():
        raw = raw.strip()
        if not raw.startswith("{"):
            continue
        try:
            ev = json.loads(raw)
        except json.JSONDecodeError:
            continue
        action = ev.get("Action")
        pkg = ev.get("Package") or ""
        name = ev.get("Test")
        if action == "output" and name:
            outputs[(pkg, name)].append(ev.get("Output") or "")
            continue
        if not name:
            if action == "fail" and pkg:
                package_fail.append(pkg)
                output = ev.get("Output") or ""
                if "build failed" in output.lower() or "# " in output:
                    build_failed = True
            continue
        if action in ("pass", "fail", "skip"):
            tests[(pkg, name)] = {
                "package": pkg,
                "shortPackage": short_pkg(pkg),
                "name": name,
                "action": action,
                "elapsed": ev.get("Elapsed"),
                "output": "".join(outputs.get((pkg, name), [])),
            }
    return tests, package_fail, build_failed


def test_in_domain(short: str, name: str, domain: dict[str, Any]) -> bool:
    if short in (domain.get("goPackages") or []):
        return True
    for pkg, pattern in (domain.get("goTestMatch") or {}).items():
        if short != pkg:
            continue
        if pattern in (".", ".*"):
            return True
        if re.search(pattern, name):
            return True
    return False


def leaf_tests(tests: dict[tuple[str, str], dict[str, Any]]) -> list[dict[str, Any]]:
    names_by_pkg: dict[str, set[str]] = defaultdict(set)
    for (pkg, name), _meta in tests.items():
        names_by_pkg[pkg].add(name)
    leaves = []
    for (pkg, name), meta in tests.items():
        prefix = name + "/"
        if any(other.startswith(prefix) for other in names_by_pkg[pkg]):
            continue
        leaves.append(meta)
    return leaves


def summarize_tests(rows: list[dict[str, Any]]) -> dict[str, int]:
    out = {"passed": 0, "failed": 0, "skipped": 0}
    for row in rows:
        key = {"pass": "passed", "fail": "failed", "skip": "skipped"}.get(row["action"])
        if key:
            out[key] += 1
    return out


def print_cmd(title: str) -> None:
    print(f"\n== {title} ==", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="E12.1 security verification suite")
    parser.add_argument("--list", action="store_true", help="print catalog and exit")
    parser.add_argument("--write-evidence", action="store_true", help="write last-run.json")
    parser.add_argument("--evidence-dir", default="", help="override evidence directory")
    parser.add_argument("--go-json", default="", help="reuse an existing go test -json file")
    parser.add_argument("--skip-go", action="store_true")
    parser.add_argument("--skip-web", action="store_true")
    parser.add_argument("--skip-scripts", action="store_true")
    args = parser.parse_args()

    root = repo_root()
    catalog = load_catalog(root)
    if args.list:
        print(json.dumps({d["id"]: d["title"] for d in catalog["domains"]}, indent=2))
        return 0

    stamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    evidence_dir = Path(
        args.evidence_dir
        or os.environ.get("E12_EVIDENCE_DIR")
        or (root / "docs/reference/e12-security-evidence")
    )
    run_dir = Path(os.environ.get("E12_RUN_DIR") or (root / ".e12-run"))
    run_dir.mkdir(parents=True, exist_ok=True)

    failed = False
    go_tests: dict[tuple[str, str], dict[str, Any]] = {}
    go_package_fail: list[str] = []
    go_elapsed = 0.0
    go_exit = 0

    if not args.skip_go:
        print_cmd("Go security packages")
        go_json_path = Path(args.go_json) if args.go_json else run_dir / "go-test.json"
        if args.go_json:
            text = Path(args.go_json).read_text(errors="replace")
        else:
            packages = catalog["goPackages"]
            go_bin = os.environ.get("E12_GO", "go")
            argv = [go_bin, "test", "-json", "-count=1", "-timeout", "12m"]
            # Shared TEST_DATABASE_URL: serialize packages so parallel
            # integration tests cannot collide on tenants/roles.
            if os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL"):
                argv.extend(["-p", "1"])
            argv.extend(packages)
            started = time.monotonic()
            proc = run_cmd(
                argv,
                cwd=root / catalog["goModuleDir"],
            )
            go_elapsed = time.monotonic() - started
            go_exit = proc.returncode
            text = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
            go_json_path.write_text(text)
            go_tests_preview, _, _ = parse_go_json(text)
            for meta in go_tests_preview.values():
                if meta["action"] != "fail":
                    continue
                print(f"FAIL {meta['shortPackage']} {meta['name']}", flush=True)
                out = (meta.get("output") or "").strip()
                if out:
                    print(out[-4000:], flush=True)
            if proc.returncode != 0 and not proc.stdout:
                print(proc.stderr or "go test failed with no output", file=sys.stderr)
        go_tests, go_package_fail, build_failed = parse_go_json(text)
        if go_exit != 0 or build_failed or go_package_fail:
            failed = True
        print(
            f"go test exit={go_exit} tests={len(leaf_tests(go_tests))} elapsed={go_elapsed:.1f}s json={go_json_path}",
            flush=True,
        )

    web_results: list[dict[str, Any]] = []
    if not args.skip_web:
        print_cmd("Web security contract tests")
        files = []
        for domain in catalog["domains"]:
            files.extend(domain.get("web") or [])
        files = list(dict.fromkeys(files))
        web_dir = root / catalog["webDir"]
        if not (web_dir / "node_modules").exists() and not os.environ.get("E12_SKIP_PNPM"):
            print("pnpm install --filter @flowforge/web...", flush=True)
            inst = run_cmd(["pnpm", "install", "--filter", "@flowforge/web..."], cwd=root)
            if inst.returncode != 0:
                print(inst.stdout)
                print(inst.stderr, file=sys.stderr)
                failed = True
        for rel in files:
            started = time.monotonic()
            proc = run_cmd(
                ["node", "--experimental-strip-types", "--test", rel],
                cwd=web_dir,
            )
            elapsed = time.monotonic() - started
            status = "pass" if proc.returncode == 0 else "fail"
            if status == "fail":
                failed = True
                err = (proc.stderr or proc.stdout or "").strip()
                print(f"FAIL {rel}\n{err[-2000:]}", file=sys.stderr)
            else:
                print(f"ok   {rel} ({elapsed:.2f}s)", flush=True)
            web_results.append(
                {"id": rel, "status": status, "elapsedSec": round(elapsed, 3), "exit": proc.returncode}
            )

    script_results: list[dict[str, Any]] = []
    if not args.skip_scripts:
        print_cmd("Provenance / policy scripts")
        for domain in catalog["domains"]:
            for spec in domain.get("scripts") or []:
                started = time.monotonic()
                proc = run_cmd(list(spec["argv"]), cwd=root)
                elapsed = time.monotonic() - started
                expect_fail = bool(spec.get("expectNonZero"))
                ok = (proc.returncode != 0) if expect_fail else (proc.returncode == 0)
                status = "pass" if ok else "fail"
                if not ok:
                    failed = True
                    print(proc.stdout)
                    print(proc.stderr, file=sys.stderr)
                print(
                    f"{'ok  ' if ok else 'FAIL'} {spec['id']} exit={proc.returncode} expectNonZero={expect_fail}",
                    flush=True,
                )
                script_results.append(
                    {
                        "id": spec["id"],
                        "title": spec.get("title"),
                        "status": status,
                        "elapsedSec": round(elapsed, 3),
                        "exit": proc.returncode,
                        "expectNonZero": expect_fail,
                    }
                )

    leaves = leaf_tests(go_tests)
    domains_out: list[dict[str, Any]] = []
    for domain in catalog["domains"]:
        matched = [row for row in leaves if test_in_domain(row["shortPackage"], row["name"], domain)]
        go_summary = summarize_tests(matched)
        web_ids = set(domain.get("web") or [])
        web_matched = [row for row in web_results if row["id"] in web_ids]
        script_ids = {s["id"] for s in domain.get("scripts") or []}
        script_matched = [row for row in script_results if row["id"] in script_ids]
        web_fail = sum(1 for row in web_matched if row["status"] == "fail")
        script_fail = sum(1 for row in script_matched if row["status"] == "fail")
        coverage = go_summary["passed"] + sum(1 for row in web_matched if row["status"] == "pass") + sum(
            1 for row in script_matched if row["status"] == "pass"
        )
        status = "pass"
        if go_summary["failed"] or web_fail or script_fail:
            status = "fail"
            failed = True
        elif coverage == 0:
            status = "fail"
            failed = True
        domains_out.append(
            {
                "id": domain["id"],
                "title": domain["title"],
                "status": status,
                "go": go_summary,
                "goExamples": [
                    f"{row['shortPackage']} {row['name']}"
                    for row in matched
                    if row["action"] == "pass"
                ][:8],
                "web": [{"id": row["id"], "status": row["status"]} for row in web_matched],
                "scripts": [{"id": row["id"], "status": row["status"]} for row in script_matched],
                "coverage": coverage,
            }
        )

    report = {
        "id": catalog["id"],
        "title": catalog["title"],
        "relatesTo": catalog["relatesTo"],
        "partOf": catalog["partOf"],
        "keepIssueOpen": catalog["keepIssueOpen"],
        "ranAt": stamp,
        "gitSha": git_sha(root),
        "databaseUrlSet": bool(os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")),
        "go": {
            "exit": go_exit,
            "elapsedSec": round(go_elapsed, 3),
            "tests": summarize_tests(leaves),
            "packageFailures": go_package_fail,
        },
        "web": web_results,
        "scripts": script_results,
        "domains": domains_out,
        "provenanceSibling": catalog["provenanceSibling"],
        "ok": not failed,
    }

    print_cmd("Domain summary")
    for domain in domains_out:
        g = domain["go"]
        print(
            f"{domain['status'].upper():4} {domain['id']}: "
            f"go pass={g['passed']} fail={g['failed']} skip={g['skipped']} "
            f"web={len(domain['web'])} scripts={len(domain['scripts'])} coverage={domain['coverage']}",
            flush=True,
        )

    if args.write_evidence or os.environ.get("E12_WRITE_EVIDENCE") == "1":
        evidence_dir.mkdir(parents=True, exist_ok=True)
        out = evidence_dir / "last-run.json"
        out.write_text(json.dumps(report, indent=2) + "\n")
        print(f"wrote {out}", flush=True)

    if failed:
        print("\nE12.1 security verification suite FAILED", file=sys.stderr)
        return 1
    print("\nE12.1 security verification suite passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
