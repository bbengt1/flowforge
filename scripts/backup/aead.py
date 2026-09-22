#!/usr/bin/env python3
"""FlowForge backup AEAD seal/open (G.1.4 / C3).

Format FFB1 (binary):
  magic(4)=FFB1 | salt(16) | iterations uint32 BE | nonce(12) | ciphertext+tag

Key: PBKDF2-HMAC-SHA256(passphrase, salt, iterations) → 32 bytes
Cipher: AES-256-GCM (AEAD). AAD = magic || iterations.

Never prints the passphrase, DSN, or plaintext. Reads passphrase from
BACKUP_ENCRYPTION_KEY. Streams plaintext through a private temp file
(umask 077) so large dumps are not held entirely in RAM.

Usage:
  pg_dump … | python3 scripts/backup/aead.py seal > dump.sql.enc
  python3 scripts/backup/aead.py open < dump.sql.enc | psql …
"""
from __future__ import annotations

import os
import struct
import sys
import tempfile

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

MAGIC = b"FFB1"
DEFAULT_ITERATIONS = 600_000
SALT_LEN = 16
NONCE_LEN = 12
KEY_LEN = 32


def _passphrase() -> bytes:
    raw = os.environ.get("BACKUP_ENCRYPTION_KEY")
    if raw is None or raw == "":
        raise SystemExit("BACKUP_ENCRYPTION_KEY is required")
    return raw.encode("utf-8")


def _derive(passphrase: bytes, salt: bytes, iterations: int) -> bytes:
    if iterations < 100_000:
        raise SystemExit("PBKDF2 iteration count too low")
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_LEN,
        salt=salt,
        iterations=iterations,
    )
    return kdf.derive(passphrase)


def _aad(iterations: int) -> bytes:
    return MAGIC + struct.pack(">I", iterations)


def seal(stdin: "sys.stdin.buffer", stdout: "sys.stdout.buffer") -> None:
    iterations = int(os.environ.get("BACKUP_PBKDF2_ITERATIONS", str(DEFAULT_ITERATIONS)))
    if iterations < 100_000:
        raise SystemExit("BACKUP_PBKDF2_ITERATIONS too low")
    passphrase = _passphrase()
    salt = os.urandom(SALT_LEN)
    nonce = os.urandom(NONCE_LEN)
    key = _derive(passphrase, salt, iterations)

    # Private spool for plaintext; never share across users.
    umask_prev = os.umask(0o077)
    try:
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024, mode="w+b") as spool:
            while True:
                chunk = stdin.read(1024 * 1024)
                if not chunk:
                    break
                spool.write(chunk)
            spool.seek(0)
            plaintext = spool.read()
    finally:
        os.umask(umask_prev)

    if not plaintext:
        raise SystemExit("plaintext dump is empty")

    ciphertext = AESGCM(key).encrypt(nonce, plaintext, _aad(iterations))
    # Drop plaintext reference promptly.
    del plaintext

    stdout.write(MAGIC)
    stdout.write(salt)
    stdout.write(struct.pack(">I", iterations))
    stdout.write(nonce)
    stdout.write(ciphertext)
    stdout.flush()


def open_blob(stdin: "sys.stdin.buffer", stdout: "sys.stdout.buffer") -> None:
    passphrase = _passphrase()
    header = stdin.read(4 + SALT_LEN + 4 + NONCE_LEN)
    if len(header) < 4 + SALT_LEN + 4 + NONCE_LEN:
        raise SystemExit("backup blob truncated")
    magic = header[:4]
    if magic != MAGIC:
        raise SystemExit("unsupported backup format (expected FFB1 AEAD)")
    salt = header[4 : 4 + SALT_LEN]
    iterations = struct.unpack(">I", header[4 + SALT_LEN : 4 + SALT_LEN + 4])[0]
    nonce = header[4 + SALT_LEN + 4 :]
    ciphertext = stdin.read()
    if not ciphertext:
        raise SystemExit("backup ciphertext missing")

    key = _derive(passphrase, salt, iterations)
    try:
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, _aad(iterations))
    except Exception:
        # Do not echo cryptography error details (may include lengths).
        raise SystemExit("backup decrypt/authenticate failed") from None

    stdout.write(plaintext)
    stdout.flush()


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] == "selftest":
        return _selftest()
    if len(argv) != 2 or argv[1] not in ("seal", "open"):
        print("usage: aead.py seal|open|selftest", file=sys.stderr)
        return 2
    # Binary stdio — backups are not text.
    if argv[1] == "seal":
        seal(sys.stdin.buffer, sys.stdout.buffer)
    else:
        open_blob(sys.stdin.buffer, sys.stdout.buffer)
    return 0


def _selftest() -> int:
    os.environ["BACKUP_ENCRYPTION_KEY"] = "flowforge-aead-selftest-key"
    plain = b"flowforge-backup-aead-selftest\n" + os.urandom(1024)
    import io

    sealed_buf = io.BytesIO()
    seal(io.BytesIO(plain), sealed_buf)
    blob = sealed_buf.getvalue()
    if blob[:4] != MAGIC:
        print("selftest: bad magic", file=sys.stderr)
        return 1
    # Tamper must fail closed.
    tampered = bytearray(blob)
    tampered[-1] ^= 0x01
    try:
        open_blob(io.BytesIO(bytes(tampered)), io.BytesIO())
        print("selftest: tamper was accepted", file=sys.stderr)
        return 1
    except SystemExit:
        pass
    out = io.BytesIO()
    open_blob(io.BytesIO(blob), out)
    if out.getvalue() != plain:
        print("selftest: round-trip mismatch", file=sys.stderr)
        return 1
    print("ok aead selftest format=FFB1")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except BrokenPipeError:
        # Downstream consumer closed early; do not dump a traceback.
        sys.stderr.close()
        raise SystemExit(1) from None
