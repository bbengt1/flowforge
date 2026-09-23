#!/usr/bin/env python3
"""AEAD-sealed integrity manifest for FlowForge backup objects (G.2.7 / C3).

Format is the same FFB1 AES-256-GCM seal as scripts/backup/aead.py.
Plaintext is a JSON inventory: basename, role, byte length, and SHA-256
of each ciphertext object. The manifest itself is sealed. It never
contains a DSN, KEK, passphrase, or object-store secret.

Tampered manifests fail AEAD open. Swapped, truncated, or edited objects
fail the checksum. Missing listed objects fail closed.

Usage:
  python3 scripts/backup/manifest.py seal --out SET.manifest.enc \\
      --chain logical --seq 1 --object logical-dump:dump.sql.enc
  python3 scripts/backup/manifest.py verify --manifest SET.manifest.enc --dir DIR
  python3 scripts/backup/manifest.py verify-chain --dir DIR --chain wal
  python3 scripts/backup/manifest.py selftest
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 1
KIND = "flowforge.backup.manifest"
ROLES = frozenset(
    {"logical-dump", "pitr-base", "pitr-wal-bundle", "wal", "wal-history"}
)
CHAINS = frozenset({"logical", "pitr", "wal"})
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_FORBIDDEN_KEY = re.compile(
    r"(password|passphrase|secret|credential|database_url|\bdsn\b|kek|token|aws_secret)",
    re.IGNORECASE,
)
_FORBIDDEN_VALUE = re.compile(
    r"postgres(?:ql)?://|BACKUP_ENCRYPTION_KEY|CREDENTIAL_KEK|AWS_SECRET_ACCESS_KEY|AKIA[0-9A-Z]{16}"
)
_FFB1 = b"FFB1"


def _load_aead():
    candidates = [
        Path(__file__).resolve().parent / "aead.py",
        Path("/usr/local/lib/flowforge/aead.py"),
    ]
    for path in candidates:
        if path.is_file():
            spec = importlib.util.spec_from_file_location("flowforge_backup_aead", path)
            if spec is None or spec.loader is None:
                continue
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            return mod
    raise SystemExit("aead.py helper missing")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _reject_tree(node: object, where: str = "$") -> None:
    if isinstance(node, dict):
        for key, value in node.items():
            if not isinstance(key, str) or _FORBIDDEN_KEY.search(key):
                raise SystemExit("manifest contains a forbidden field")
            _reject_tree(value, where + "." + key)
        return
    if isinstance(node, list):
        for i, value in enumerate(node):
            _reject_tree(value, f"{where}[{i}]")
        return
    if isinstance(node, str) and _FORBIDDEN_VALUE.search(node):
        raise SystemExit("manifest contains forbidden material")


def _check_name(name: object) -> str:
    if not isinstance(name, str) or not _NAME.fullmatch(name) or ".." in name:
        raise SystemExit("manifest object name is invalid")
    if not name.endswith(".enc"):
        raise SystemExit("manifest object name is invalid")
    if name.endswith(".manifest.enc") or name == "chain-tip.manifest.enc":
        raise SystemExit("manifest object name is invalid")
    return name


def _object_from_path(role: str, raw_path: str) -> dict[str, object]:
    if role not in ROLES:
        raise SystemExit("manifest object role is invalid")
    path = Path(raw_path)
    if not path.is_file():
        raise SystemExit("manifest object is missing")
    name = _check_name(path.name)
    blob = path.read_bytes()[:4]
    if blob != _FFB1:
        raise SystemExit("manifest object is not FFB1 AEAD")
    size = path.stat().st_size
    if size <= 0:
        raise SystemExit("manifest object is empty")
    return {
        "name": name,
        "role": role,
        "bytes": size,
        "sha256": _sha256_file(path),
    }


def build_document(
    *,
    chain: str,
    seq: int,
    prev_sha256: str,
    objects: list[dict[str, object]],
) -> dict[str, object]:
    if chain not in CHAINS:
        raise SystemExit("manifest chain is invalid")
    if not isinstance(seq, int) or seq < 1 or seq > 1_000_000:
        raise SystemExit("manifest sequence is invalid")
    if seq == 1:
        if prev_sha256:
            raise SystemExit("genesis manifest must not set prevSha256")
    elif not _SHA.fullmatch(prev_sha256):
        raise SystemExit("manifest prevSha256 is required")
    if not objects:
        raise SystemExit("manifest object list is empty")
    doc: dict[str, object] = {
        "schema": SCHEMA,
        "kind": KIND,
        "format": "FFB1",
        "aead": "AES-256-GCM",
        "kdf": "PBKDF2-HMAC-SHA256",
        "chain": chain,
        "seq": seq,
        "prevSha256": prev_sha256,
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "objects": objects,
    }
    _reject_tree(doc)
    return doc


def _seal_bytes(plaintext: bytes) -> bytes:
    aead = _load_aead()
    import io

    out = io.BytesIO()
    aead.seal(io.BytesIO(plaintext), out)
    return out.getvalue()


def _open_bytes(blob: bytes) -> bytes:
    aead = _load_aead()
    import io

    out = io.BytesIO()
    try:
        aead.open_blob(io.BytesIO(blob), out)
    except SystemExit:
        raise SystemExit("manifest authenticate failed") from None
    return out.getvalue()


def _open_doc(path: Path) -> dict[str, object]:
    if not path.is_file() or path.stat().st_size == 0:
        raise SystemExit("manifest is missing")
    if path.read_bytes()[:4] != _FFB1:
        raise SystemExit("manifest is not FFB1 AEAD")
    try:
        plain = _open_bytes(path.read_bytes())
        doc = json.loads(plain.decode("utf-8"))
    except SystemExit:
        raise
    except Exception:
        raise SystemExit("manifest authenticate failed") from None
    if not isinstance(doc, dict):
        raise SystemExit("manifest payload is invalid")
    _reject_tree(doc)
    if doc.get("schema") != SCHEMA or doc.get("kind") != KIND or doc.get("format") != "FFB1":
        raise SystemExit("manifest payload is invalid")
    return doc


def _verify_doc(doc: dict[str, object], directory: Path, *, exact: bool) -> None:
    chain = doc.get("chain")
    seq = doc.get("seq")
    prev = doc.get("prevSha256")
    objects = doc.get("objects")
    if chain not in CHAINS:
        raise SystemExit("manifest chain is invalid")
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
        raise SystemExit("manifest sequence is invalid")
    if seq == 1:
        if prev not in ("", None):
            raise SystemExit("manifest chain link mismatch")
    elif not isinstance(prev, str) or not _SHA.fullmatch(prev):
        raise SystemExit("manifest chain link mismatch")
    if not isinstance(objects, list) or not objects:
        raise SystemExit("manifest object list is empty")
    listed: set[str] = set()
    for item in objects:
        if not isinstance(item, dict):
            raise SystemExit("manifest object is invalid")
        name = _check_name(item.get("name"))
        role = item.get("role")
        size = item.get("bytes")
        digest = item.get("sha256")
        if role not in ROLES:
            raise SystemExit("manifest object role is invalid")
        if not isinstance(size, int) or isinstance(size, bool) or size < 1:
            raise SystemExit("manifest object length is invalid")
        if not isinstance(digest, str) or not _SHA.fullmatch(digest):
            raise SystemExit("manifest checksum is invalid")
        if name in listed:
            raise SystemExit("manifest object name is duplicated")
        listed.add(name)
        path = directory / name
        if not path.is_file():
            raise SystemExit(f"manifest object missing name={name}")
        actual_size = path.stat().st_size
        if actual_size != size:
            raise SystemExit(f"manifest length mismatch name={name}")
        actual = _sha256_file(path)
        if actual != digest:
            raise SystemExit(f"manifest checksum mismatch name={name}")
        if path.read_bytes()[:4] != _FFB1:
            raise SystemExit(f"manifest object is not FFB1 AEAD name={name}")
    if exact:
        for path in directory.glob("*.enc"):
            if path.name.endswith(".manifest.enc"):
                continue
            if path.name not in listed:
                raise SystemExit(f"unexpected backup object name={path.name}")


def seal_manifest(out_path: Path, doc: dict[str, object]) -> None:
    plaintext = (json.dumps(doc, indent=2, sort_keys=True) + "\n").encode("utf-8")
    _reject_tree(json.loads(plaintext.decode("utf-8")))
    blob = _seal_bytes(plaintext)
    if blob[:4] != _FFB1:
        raise SystemExit("manifest seal was not FFB1 AEAD")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_name(out_path.name + ".partial")
    try:
        tmp.write_bytes(blob)
        os.chmod(tmp, 0o600)
        os.replace(tmp, out_path)
        os.chmod(out_path, 0o600)
    finally:
        if tmp.exists():
            tmp.unlink()


def _parse_object_args(values: list[str]) -> list[dict[str, object]]:
    objects: list[dict[str, object]] = []
    for raw in values:
        role, sep, path = raw.partition(":")
        if not sep or not role or not path:
            raise SystemExit("usage: --object ROLE:PATH")
        objects.append(_object_from_path(role, path))
    return objects


def _state_read(path: Path, chain: str) -> tuple[int, str]:
    if not path.exists():
        return 1, ""
    try:
        data = json.loads(path.read_text())
    except Exception:
        raise SystemExit("wal chain state is invalid") from None
    if not isinstance(data, dict) or data.get("chain") != chain:
        raise SystemExit("wal chain state does not match")
    seq = data.get("seq")
    tip = data.get("tipSha256")
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
        raise SystemExit("wal chain state is invalid")
    if not isinstance(tip, str) or not _SHA.fullmatch(tip):
        raise SystemExit("wal chain state is invalid")
    return seq + 1, tip


def _state_write(path: Path, manifest: Path, chain: str) -> None:
    doc = _open_doc(manifest)
    if doc.get("chain") != chain:
        raise SystemExit("manifest chain does not match")
    seq = doc.get("seq")
    if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
        raise SystemExit("manifest sequence is invalid")
    payload = {
        "chain": chain,
        "seq": seq,
        "tipSha256": _sha256_file(manifest),
    }
    _reject_tree(payload)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, sort_keys=True) + "\n")
    os.chmod(path, 0o600)


def _state_resume(state: Path, tip: Path, chain: str) -> None:
    if state.exists() and tip.exists():
        data = json.loads(state.read_text())
        tip_hash = _sha256_file(tip)
        if data.get("tipSha256") != tip_hash or data.get("chain") != chain:
            raise SystemExit("wal chain tip does not match local state")
        _open_doc(tip)
        return
    if state.exists():
        _state_read(state, chain)
        return
    if tip.exists():
        _state_write(state, tip, chain)
        return


def _cmd_seal(args: argparse.Namespace) -> int:
    objects = _parse_object_args(args.object)
    doc = build_document(
        chain=args.chain,
        seq=args.seq,
        prev_sha256=args.prev_sha256 or "",
        objects=objects,
    )
    seal_manifest(Path(args.out), doc)
    print(f"wrote integrity manifest chain={args.chain} seq={args.seq} format=FFB1")
    return 0


def _cmd_verify(args: argparse.Namespace) -> int:
    manifest = Path(args.manifest)
    directory = Path(args.dir) if args.dir else manifest.parent
    doc = _open_doc(manifest)
    _verify_doc(doc, directory, exact=args.exact)
    print(f"ok integrity manifest chain={doc.get('chain')} seq={doc.get('seq')} format=FFB1")
    return 0


def _cmd_list(args: argparse.Namespace) -> int:
    doc = _open_doc(Path(args.manifest))
    objects = doc.get("objects")
    if not isinstance(objects, list):
        raise SystemExit("manifest object list is empty")
    for item in objects:
        if not isinstance(item, dict):
            raise SystemExit("manifest object is invalid")
        role = item.get("role")
        name = _check_name(item.get("name"))
        if role not in ROLES:
            raise SystemExit("manifest object role is invalid")
        print(f"{role}\t{name}")
    return 0


def _cmd_verify_chain(args: argparse.Namespace) -> int:
    directory = Path(args.dir)
    found: list[tuple[int, Path, dict[str, object]]] = []
    for path in sorted(directory.glob("*.manifest.enc")):
        if path.name == "chain-tip.manifest.enc":
            continue
        doc = _open_doc(path)
        if doc.get("chain") != args.chain:
            continue
        seq = doc.get("seq")
        if not isinstance(seq, int) or isinstance(seq, bool):
            raise SystemExit("manifest sequence is invalid")
        found.append((seq, path, doc))
    if not found:
        raise SystemExit("manifest chain is empty")
    found.sort(key=lambda row: row[0])
    expect = found[0][0]
    if expect != 1 and not args.allow_resume:
        raise SystemExit("manifest chain sequence gap")
    prev_hash = ""
    if expect != 1:
        prev_hash = str(found[0][2].get("prevSha256") or "")
    for seq, path, doc in found:
        if seq != expect:
            raise SystemExit("manifest chain sequence gap")
        got_prev = doc.get("prevSha256") or ""
        if expect == 1:
            if got_prev != "":
                raise SystemExit("manifest chain link mismatch")
        elif got_prev != prev_hash:
            raise SystemExit("manifest chain link mismatch")
        _verify_doc(doc, directory, exact=False)
        prev_hash = _sha256_file(path)
        expect += 1
    print(f"ok integrity chain chain={args.chain} links={len(found)} format=FFB1")
    return 0


def _cmd_state_read(args: argparse.Namespace) -> int:
    seq, prev = _state_read(Path(args.state), args.chain)
    sys.stdout.write(f"{seq}\t{prev}\n")
    return 0


def _cmd_state_write(args: argparse.Namespace) -> int:
    _state_write(Path(args.state), Path(args.manifest), args.chain)
    return 0


def _cmd_state_resume(args: argparse.Namespace) -> int:
    tip = Path(args.tip) if args.tip else Path(args.state + ".missing")
    if args.tip:
        tip = Path(args.tip)
    _state_resume(Path(args.state), tip if args.tip else Path("/nonexistent/flowforge-no-tip"), args.chain)
    return 0


def _selftest() -> int:
    import io

    os.environ["BACKUP_ENCRYPTION_KEY"] = "flowforge-manifest-selftest-key"
    # Keep the selftest at the production iteration count so the default holds.
    os.environ.pop("BACKUP_PBKDF2_ITERATIONS", None)
    aead = _load_aead()

    def seal_plain(text: bytes) -> bytes:
        buf = io.BytesIO()
        aead.seal(io.BytesIO(text), buf)
        return buf.getvalue()

    try:
        _reject_tree({"password": "x"})
        print("selftest: forbidden field was accepted", file=sys.stderr)
        return 1
    except SystemExit:
        pass
    try:
        _reject_tree({"note": "postgres://flowforge:secret@db/flowforge"})
        print("selftest: forbidden material was accepted", file=sys.stderr)
        return 1
    except SystemExit:
        pass

    with tempfile.TemporaryDirectory(prefix="ff-manifest-") as raw:
        root = Path(raw)
        obj_a = root / "base-one.tar.enc"
        obj_b = root / "000000010000000000000001.wal.enc"
        obj_a.write_bytes(seal_plain(b"flowforge-base-a"))
        obj_b.write_bytes(seal_plain(b"flowforge-wal-b"))
        os.chmod(obj_a, 0o600)
        os.chmod(obj_b, 0o600)

        try:
            _object_from_path("logical-dump", str(root / "plain.sql"))
            print("selftest: missing object was accepted", file=sys.stderr)
            return 1
        except SystemExit:
            pass
        plain = root / "not-aead.enc"
        plain.write_bytes(b"plain-not-sealed")
        try:
            _object_from_path("logical-dump", str(plain))
            print("selftest: non-FFB1 object was accepted", file=sys.stderr)
            return 1
        except SystemExit:
            pass

        doc1 = build_document(
            chain="wal",
            seq=1,
            prev_sha256="",
            objects=[_object_from_path("wal", str(obj_b))],
        )
        man1 = root / "000000010000000000000001.manifest.enc"
        seal_manifest(man1, doc1)
        _verify_doc(_open_doc(man1), root, exact=False)

        tampered_obj = bytearray(obj_b.read_bytes())
        tampered_obj[-1] ^= 0x01
        obj_b.write_bytes(bytes(tampered_obj))
        try:
            _verify_doc(_open_doc(man1), root, exact=False)
            print("selftest: object tamper was accepted", file=sys.stderr)
            return 1
        except SystemExit:
            pass
        obj_b.write_bytes(seal_plain(b"flowforge-wal-b"))
        # Hash changed; reseal a matching manifest after restoring a known body.
        # The restored body may not match the original ciphertext (new nonce).
        doc1 = build_document(
            chain="wal",
            seq=1,
            prev_sha256="",
            objects=[_object_from_path("wal", str(obj_b))],
        )
        seal_manifest(man1, doc1)
        _verify_doc(_open_doc(man1), root, exact=False)

        tampered_man = bytearray(man1.read_bytes())
        tampered_man[-1] ^= 0x01
        man1.write_bytes(bytes(tampered_man))
        try:
            _open_doc(man1)
            print("selftest: manifest tamper was accepted", file=sys.stderr)
            return 1
        except SystemExit:
            pass
        seal_manifest(man1, doc1)

        prev = _sha256_file(man1)
        obj_c = root / "000000010000000000000002.wal.enc"
        obj_c.write_bytes(seal_plain(b"flowforge-wal-c"))
        doc2 = build_document(
            chain="wal",
            seq=2,
            prev_sha256=prev,
            objects=[_object_from_path("wal", str(obj_c))],
        )
        man2 = root / "000000010000000000000002.manifest.enc"
        seal_manifest(man2, doc2)

        ns = argparse.Namespace(dir=str(root), chain="wal", allow_resume=False)
        if _cmd_verify_chain(ns) != 0:
            return 1

        broken = build_document(
            chain="wal",
            seq=2,
            prev_sha256="0" * 64,
            objects=[_object_from_path("wal", str(obj_c))],
        )
        seal_manifest(man2, broken)
        try:
            _cmd_verify_chain(ns)
            print("selftest: broken chain was accepted", file=sys.stderr)
            return 1
        except SystemExit:
            pass
        seal_manifest(man2, doc2)

        state = root / "chain-state.json"
        _state_write(state, man2, "wal")
        nxt, prev_out = _state_read(state, "wal")
        if nxt != 3 or prev_out != _sha256_file(man2):
            print("selftest: chain state mismatch", file=sys.stderr)
            return 1
        tip = root / "chain-tip.manifest.enc"
        tip.write_bytes(man2.read_bytes())
        try:
            _state_resume(state, tip, "wal")
        except SystemExit:
            print("selftest: matching chain tip was rejected", file=sys.stderr)
            return 1
        tip.write_bytes(man1.read_bytes())
        try:
            _state_resume(state, tip, "wal")
            print("selftest: mismatched chain tip was accepted", file=sys.stderr)
            return 1
        except SystemExit:
            pass

        # Logical set: exact directory rejects an unlisted ciphertext.
        logical = root / "logical"
        logical.mkdir()
        dump = logical / "flowforge.sql.enc"
        dump.write_bytes(seal_plain(b"-- flowforge dump\n"))
        logical_doc = build_document(
            chain="logical",
            seq=1,
            prev_sha256="",
            objects=[_object_from_path("logical-dump", str(dump))],
        )
        logical_man = logical / "flowforge.manifest.enc"
        seal_manifest(logical_man, logical_doc)
        _verify_doc(_open_doc(logical_man), logical, exact=True)
        extra = logical / "extra.sql.enc"
        extra.write_bytes(seal_plain(b"extra"))
        try:
            _verify_doc(_open_doc(logical_man), logical, exact=True)
            print("selftest: unlisted object was accepted", file=sys.stderr)
            return 1
        except SystemExit:
            pass

    print("ok manifest selftest format=FFB1")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="manifest.py")
    sub = parser.add_subparsers(dest="cmd", required=True)

    seal = sub.add_parser("seal")
    seal.add_argument("--out", required=True)
    seal.add_argument("--chain", required=True, choices=sorted(CHAINS))
    seal.add_argument("--seq", required=True, type=int)
    seal.add_argument("--prev-sha256", default="")
    seal.add_argument("--object", action="append", required=True)
    seal.set_defaults(func=_cmd_seal)

    verify = sub.add_parser("verify")
    verify.add_argument("--manifest", required=True)
    verify.add_argument("--dir", dest="dir")
    verify.add_argument("--exact", action="store_true")
    verify.set_defaults(func=_cmd_verify)

    listing = sub.add_parser("list")
    listing.add_argument("--manifest", required=True)
    listing.set_defaults(func=_cmd_list)

    chain = sub.add_parser("verify-chain")
    chain.add_argument("--dir", required=True)
    chain.add_argument("--chain", required=True, choices=sorted(CHAINS))
    chain.add_argument("--allow-resume", action="store_true")
    chain.set_defaults(func=_cmd_verify_chain)

    state_read = sub.add_parser("state-read")
    state_read.add_argument("--state", required=True)
    state_read.add_argument("--chain", required=True, choices=sorted(CHAINS))
    state_read.set_defaults(func=_cmd_state_read)

    state_write = sub.add_parser("state-write")
    state_write.add_argument("--state", required=True)
    state_write.add_argument("--manifest", required=True)
    state_write.add_argument("--chain", required=True, choices=sorted(CHAINS))
    state_write.set_defaults(func=_cmd_state_write)

    state_resume = sub.add_parser("state-resume")
    state_resume.add_argument("--state", required=True)
    state_resume.add_argument("--tip")
    state_resume.add_argument("--chain", required=True, choices=sorted(CHAINS))
    state_resume.set_defaults(func=_cmd_state_resume)

    selftest = sub.add_parser("selftest")
    selftest.set_defaults(func=lambda _args: _selftest())

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except BrokenPipeError:
        sys.stderr.close()
        raise SystemExit(1) from None
