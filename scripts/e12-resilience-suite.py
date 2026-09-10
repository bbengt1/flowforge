#!/usr/bin/env python3
"""E12.2 operational resilience and capacity suite harness.

Relates to #183 / Part of #181. Keep #183 open.
Does not run or weaken the E12.1 security suite.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REQUIRED_DOMAINS = (
    "backup-restore",
    "worker-loss-recovery",
    "queue-lag",
    "migration-serialization",
    "load-capacity",
)
MIN_HEADROOM = 2.0


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def load_catalog(root: Path) -> dict[str, Any]:
    path = root / "scripts" / "e12-resilience-suite.json"
    catalog = json.loads(path.read_text())
    ids = [d["id"] for d in catalog["domains"]]
    missing = [d for d in REQUIRED_DOMAINS if d not in ids]
    extra = [d for d in ids if d not in REQUIRED_DOMAINS]
    if missing or extra:
        raise SystemExit(f"catalog domain mismatch missing={missing} extra={extra}")
    return catalog


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


def print_cmd(title: str) -> None:
    print(f"\n== {title} ==", flush=True)


def parse_go_json(text: str) -> tuple[list[dict[str, Any]], list[str], bool]:
    tests: dict[tuple[str, str], dict[str, Any]] = {}
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
                "name": name,
                "action": action,
                "elapsed": ev.get("Elapsed"),
            }
    return list(tests.values()), package_fail, build_failed


def summarize(rows: list[dict[str, Any]]) -> dict[str, int]:
    out = {"passed": 0, "failed": 0, "skipped": 0}
    for row in rows:
        key = {"pass": "passed", "fail": "failed", "skip": "skipped"}.get(row["action"])
        if key:
            out[key] += 1
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="E12.2 operational resilience and capacity suite")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--write-evidence", action="store_true")
    parser.add_argument("--evidence-dir", default="")
    parser.add_argument("--skip-go", action="store_true")
    parser.add_argument("--skip-scripts", action="store_true")
    args = parser.parse_args()

    root = repo_root()
    catalog = load_catalog(root)
    if args.list:
        print(json.dumps({d["id"]: d["title"] for d in catalog["domains"]}, indent=2))
        return 0

    dsn_set = bool(os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL"))
    if not dsn_set:
        print("TEST_DATABASE_URL / DATABASE_URL is required (suite fails closed)", file=sys.stderr)
        return 1

    stamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    evidence_dir = Path(
        args.evidence_dir
        or os.environ.get("E12_EVIDENCE_DIR")
        or (root / "docs/reference/e12-resilience-evidence")
    )
    run_dir = Path(os.environ.get("E12_RUN_DIR") or (root / ".e12-run"))
    run_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("E12_RUN_DIR", str(run_dir))
    os.environ.setdefault("E12_CAPACITY_JSON", str(run_dir / "capacity-last-run.json"))
    os.environ.setdefault("E12_LOAD_MODE", os.environ.get("E12_LOAD_MODE", "ci"))

    failed = False
    go_results: dict[str, dict[str, Any]] = {}
    all_leaves: list[dict[str, Any]] = []

    if not args.skip_go:
        print_cmd("Go resilience packages")
        go_bin = os.environ.get("E12_GO", "go")
        for target in catalog["goTargets"]:
            argv = [
                go_bin,
                "test",
                "-json",
                "-count=1",
                "-timeout",
                "8m",
                "-p",
                "1",
                "-run",
                target["run"],
                target["dir"],
            ]
            started = time.monotonic()
            proc = run_cmd(argv, cwd=root / catalog["goModuleDir"])
            elapsed = time.monotonic() - started
            text = (proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")
            (run_dir / f"go-{target['id']}.json").write_text(text)
            leaves, pkg_fail, build_failed = parse_go_json(text)
            summary = summarize(leaves)
            status = "pass"
            if proc.returncode != 0 or build_failed or pkg_fail or summary["failed"]:
                status = "fail"
                failed = True
                for row in leaves:
                    if row["action"] != "fail":
                        continue
                    print(f"FAIL {row['package']} {row['name']}", flush=True)
                if proc.returncode != 0 and not proc.stdout:
                    print(proc.stderr or "go test failed with no output", file=sys.stderr)
            elif summary["passed"] == 0:
                status = "fail"
                failed = True
                print(f"FAIL {target['id']}: no passing tests (skipped={summary['skipped']})", file=sys.stderr)
            print(
                f"{'ok  ' if status == 'pass' else 'FAIL'} {target['id']} "
                f"exit={proc.returncode} pass={summary['passed']} fail={summary['failed']} "
                f"skip={summary['skipped']} ({elapsed:.1f}s)",
                flush=True,
            )
            go_results[target["id"]] = {
                "id": target["id"],
                "dir": target["dir"],
                "status": status,
                "exit": proc.returncode,
                "elapsedSec": round(elapsed, 3),
                "tests": summary,
                "packageFailures": pkg_fail,
            }
            all_leaves.extend(leaves)

    script_results: list[dict[str, Any]] = []
    if not args.skip_scripts:
        print_cmd("Restore / rehearsal scripts")
        for domain in catalog["domains"]:
            for spec in domain.get("scripts") or []:
                started = time.monotonic()
                proc = run_cmd(list(spec["argv"]), cwd=root)
                elapsed = time.monotonic() - started
                ok = proc.returncode == 0
                status = "pass" if ok else "fail"
                if not ok:
                    failed = True
                    print(proc.stdout)
                    print(proc.stderr, file=sys.stderr)
                else:
                    tail = (proc.stdout or "").strip().splitlines()
                    if tail:
                        print(tail[-1], flush=True)
                print(
                    f"{'ok  ' if ok else 'FAIL'} {spec['id']} exit={proc.returncode} ({elapsed:.1f}s)",
                    flush=True,
                )
                script_results.append(
                    {
                        "id": spec["id"],
                        "title": spec.get("title"),
                        "status": status,
                        "elapsedSec": round(elapsed, 3),
                        "exit": proc.returncode,
                    }
                )

    capacity_path = Path(os.environ["E12_CAPACITY_JSON"])
    capacity: dict[str, Any] | None = None
    if capacity_path.exists():
        capacity = json.loads(capacity_path.read_text())
        if not capacity.get("ok"):
            failed = True
            print(f"FAIL capacity report not ok: {capacity.get('failures')}", file=sys.stderr)
        for key, ratio in (capacity.get("headroom") or {}).items():
            if key in ("queueDepth",):
                continue
            if not isinstance(ratio, (int, float)) or ratio < MIN_HEADROOM:
                failed = True
                print(f"FAIL headroom {key}={ratio} < {MIN_HEADROOM}", file=sys.stderr)
    else:
        failed = True
        print(f"FAIL missing capacity evidence {capacity_path}", file=sys.stderr)

    restore_path = run_dir / "restore-schema-last-run.json"
    restore_evidence = json.loads(restore_path.read_text()) if restore_path.exists() else None

    domains_out: list[dict[str, Any]] = []
    for domain in catalog["domains"]:
        target_ids = set(domain.get("goTargets") or [])
        go_matched = [go_results[i] for i in target_ids if i in go_results]
        go_fail = sum(1 for row in go_matched if row["status"] == "fail")
        go_pass = sum(1 for row in go_matched if row["status"] == "pass")
        script_ids = {s["id"] for s in domain.get("scripts") or []}
        script_matched = [row for row in script_results if row["id"] in script_ids]
        script_fail = sum(1 for row in script_matched if row["status"] == "fail")
        script_pass = sum(1 for row in script_matched if row["status"] == "pass")
        cap_ok = True
        cap_ratios: dict[str, float] = {}
        for key in domain.get("capacityKeys") or []:
            ratio = (capacity or {}).get("headroom", {}).get(key)
            if not isinstance(ratio, (int, float)) or ratio < MIN_HEADROOM:
                cap_ok = False
            if isinstance(ratio, (int, float)):
                cap_ratios[key] = ratio
        coverage = go_pass + script_pass + (1 if cap_ok and (domain.get("capacityKeys") or domain.get("scripts") or go_pass) else 0)
        status = "pass"
        if go_fail or script_fail or not cap_ok:
            status = "fail"
            failed = True
        elif go_pass + script_pass == 0 and not domain.get("capacityKeys"):
            status = "fail"
            failed = True
        elif domain.get("capacityKeys") and capacity is None:
            status = "fail"
            failed = True
        domains_out.append(
            {
                "id": domain["id"],
                "title": domain["title"],
                "status": status,
                "go": [{"id": row["id"], "status": row["status"], "tests": row["tests"]} for row in go_matched],
                "scripts": [{"id": row["id"], "status": row["status"]} for row in script_matched],
                "headroom": cap_ratios,
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
        "databaseUrlSet": dsn_set,
        "loadMode": os.environ.get("E12_LOAD_MODE", "ci"),
        "minHeadroom": MIN_HEADROOM,
        "go": go_results,
        "scripts": script_results,
        "capacity": capacity,
        "restoreSchema": restore_evidence,
        "domains": domains_out,
        "restoreSibling": catalog["restoreSibling"],
        "securitySibling": catalog["securitySibling"],
        "ok": not failed,
    }

    print_cmd("Domain summary")
    for domain in domains_out:
        extra = ""
        if domain["headroom"]:
            extra = " " + " ".join(f"{k}={v:.2f}×" for k, v in domain["headroom"].items())
        print(f"{domain['status'].upper():4} {domain['id']}:{extra}", flush=True)

    if args.write_evidence or os.environ.get("E12_WRITE_EVIDENCE") == "1":
        evidence_dir.mkdir(parents=True, exist_ok=True)
        out = evidence_dir / "last-run.json"
        out.write_text(json.dumps(report, indent=2) + "\n")
        print(f"wrote {out}", flush=True)
        if capacity is not None:
            cap_out = evidence_dir / "capacity-last-run.json"
            cap_out.write_text(json.dumps(capacity, indent=2) + "\n")
            print(f"wrote {cap_out}", flush=True)
        if restore_evidence is not None:
            rst_out = evidence_dir / "restore-schema-last-run.json"
            rst_out.write_text(json.dumps(restore_evidence, indent=2) + "\n")
            print(f"wrote {rst_out}", flush=True)

    if failed:
        print("\nE12.2 operational resilience suite FAILED", file=sys.stderr)
        return 1
    print("\nE12.2 operational resilience suite passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
