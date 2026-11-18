#!/usr/bin/env python3
"""
Admin CLI for generating, listing, and revoking course activation license keys,
or clearing user device sessions in `Web-Server/data/`.
Uses the exact HMAC-SHA256 key-hashing scheme as `Web-Server/server.js`.

The key-hashing secret is resolved exactly like the server does: env LICENSE_SECRET,
then `<DATA_DIR>/.license_secret`. It is independent from SESSION_SECRET and must never
change once keys are issued. A fingerprint of it is stored in `licenses.json`, so running
this CLI with a different secret than the server fails loudly instead of producing keys
that can never be activated.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from course_config import load_course_config

ROOT, CFG = load_course_config(Path(__file__))
DATA_DIR = Path(os.environ["DATA_DIR"]).resolve() if os.environ.get("DATA_DIR") else ROOT / "Web-Server" / "data"
LICENSES_FILE = DATA_DIR / "licenses.json"
USERS_FILE = DATA_DIR / "users.json"
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
LOCK_FILE = DATA_DIR / ".store.lock"
LOCK_STALE_SEC = 30
LOCK_WAIT_SEC = 5


class CliError(Exception):
    """Fatal, user-facing error (printed without a traceback)."""


def normalize_key(raw: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", raw.upper())


def license_secret_fingerprint(secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), b"license-secret-fingerprint", hashlib.sha256).hexdigest()[:16]


def get_license_secret(db: dict[str, Any], allow_create: bool = False) -> str:
    """Resolve the key-hashing secret and verify it matches the one the store was issued with."""
    secret = os.environ.get("LICENSE_SECRET", "")
    secret_path = DATA_DIR / ".license_secret"
    if secret:
        if len(secret) < 32:
            raise CliError("LICENSE_SECRET phải có tối thiểu 32 ký tự.")
    elif secret_path.exists():
        secret = secret_path.read_text(encoding="utf-8").strip()
        if len(secret) < 32:
            raise CliError(f"{secret_path} không hợp lệ (ngắn hơn 32 ký tự).")
    else:
        if db.get("licenses") or not allow_create:
            raise CliError(
                f"Không tìm thấy khóa băm mã kích hoạt (biến LICENSE_SECRET hoặc file {secret_path}).\n"
                "Hãy chạy CLI với đúng LICENSE_SECRET / DATA_DIR mà server đang dùng. "
                "(Bản cũ dùng chung giá trị SESSION_SECRET hoặc file .server_secret.)"
            )
        DATA_DIR.mkdir(parents=True, mode=0o700, exist_ok=True)
        secret = secrets.token_hex(32)
        fd = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(secret + "\n")
        print(f"Đã tạo khóa băm mã mới tại {secret_path} — hãy sao lưu file này, mất nó là mất toàn bộ mã.")

    stored_fp = db.get("secret_fp")
    if stored_fp and stored_fp != license_secret_fingerprint(secret):
        raise CliError(
            "Khóa băm mã (LICENSE_SECRET / .license_secret) KHÔNG khớp với khóa đã dùng để phát hành các mã "
            f"trong {LICENSES_FILE}.\nMã tạo bằng khóa này sẽ không kích hoạt được trên server — đã dừng, không ghi gì."
        )
    return secret


@contextmanager
def store_lock() -> Iterator[None]:
    """Cross-process lock shared with Web-Server/server.js (`.store.lock`, O_EXCL)."""
    DATA_DIR.mkdir(parents=True, mode=0o700, exist_ok=True)
    deadline = time.monotonic() + LOCK_WAIT_SEC
    while True:
        try:
            fd = os.open(LOCK_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            break
        except FileExistsError:
            try:
                if time.time() - LOCK_FILE.stat().st_mtime > LOCK_STALE_SEC:
                    LOCK_FILE.unlink()
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() > deadline:
                raise CliError("Kho dữ liệu đang bị khóa bởi tiến trình khác. Hãy thử lại sau.")
            time.sleep(0.025)
    try:
        yield
    finally:
        os.close(fd)
        try:
            LOCK_FILE.unlink()
        except FileNotFoundError:
            pass


def hash_license_key(raw_key: str, secret: str) -> str:
    norm = normalize_key(raw_key)
    return hmac.new(secret.encode("utf-8"), f"license:{norm}".encode("utf-8"), hashlib.sha256).hexdigest()


def load_db(path: Path, key: str) -> dict[str, Any]:
    """Only a missing file yields an empty store; a corrupt one aborts so it is never overwritten."""
    if not path.exists():
        return {key: []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CliError(f"Kho dữ liệu {path} bị hỏng ({exc}). Khôi phục từ {path}.bak trước khi chạy tiếp.") from exc
    if not isinstance(data, dict) or not isinstance(data.get(key), list):
        raise CliError(f'Kho dữ liệu {path} sai cấu trúc (thiếu mảng "{key}").')
    return data


def save_json_secure(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if path.exists():
        bak = path.with_name(path.name + ".bak")
        fd = os.open(bak, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(path.read_bytes())
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}.{secrets.token_hex(4)}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    tmp.replace(path)


def cmd_generate(args: argparse.Namespace) -> int:
    course_id = args.course or CFG["course_id"]
    tier = getattr(args, "tier", "standard") or "standard"
    if args.prefix and "PRO" in args.prefix.upper():
        tier = "pro"
    tier_tag = "PRO" if tier == "pro" else "STD"
    target_code = re.sub(r"[^A-Z0-9]", "", CFG["target_lang"]["code"].upper()) or "LAO"
    if target_code == "LO":
        target_code = "LAO"
    default_prefix = f"{target_code}-{tier_tag}"
    prefix = re.sub(r"[^A-Z0-9-]", "", args.prefix.upper()) if args.prefix else default_prefix
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    generated: list[str] = []
    with store_lock():
        db = load_db(LICENSES_FILE, "licenses")
        secret = get_license_secret(db, allow_create=True)
        db["secret_fp"] = license_secret_fingerprint(secret)
        for _ in range(args.count):
            code = "".join(ALPHABET[secrets.randbelow(len(ALPHABET))] for _ in range(8))
            raw_key = f"{prefix}-{code[:4]}-{code[4:8]}"
            db["licenses"].append(
                {
                    "id": "lic_" + secrets.token_hex(6),
                    "key_hash": hash_license_key(raw_key, secret),
                    "hint": f"{prefix}-****-{code[4:8]}",
                    "tier": tier,
                    "course_id": course_id,
                    "note": args.note or "",
                    "revoked": False,
                    "bound_user_id": None,
                    "created_at": now_iso,
                }
            )
            generated.append(raw_key)
        save_json_secure(LICENSES_FILE, db)

    print(f"Đã tạo {len(generated)} mã kích hoạt cho khóa '{course_id}':")
    for k in generated:
        print(f"  {k}")

    if args.save_batch:
        out_path = Path(args.save_batch)
        fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write("\n".join(generated) + "\n")
        print(f"Đã lưu lô mã (chế độ 0600) vào: {out_path}")
    return 0


def cmd_list(_args: argparse.Namespace) -> int:
    db = load_db(LICENSES_FILE, "licenses")
    lics = db.get("licenses", [])
    print(f"Tổng số mã: {len(lics)}")
    for lic in lics:
        status = "REVOKED" if lic.get("revoked") else ("ACTIVE" if lic.get("bound_user_id") else "UNUSED")
        bound = lic.get("bound_email_masked") or "-"
        print(f"  {lic['id']} | {lic['hint']} | {lic['course_id']} | {status:7s} | user={bound} | {lic.get('note','')}")
    return 0


def cmd_revoke(args: argparse.Namespace) -> int:
    target = args.target.strip()
    with store_lock():
        db = load_db(LICENSES_FILE, "licenses")
        # Revoking by license ID needs no secret; only a raw key has to be hashed.
        key_hash = None if target.startswith("lic_") else hash_license_key(target, get_license_secret(db))
        changed = 0
        for lic in db["licenses"]:
            if lic.get("id") == target or (key_hash and lic.get("key_hash") == key_hash):
                lic["revoked"] = True
                changed += 1
        if not changed:
            print(f"Không tìm thấy mã hoặc license ID: {target}", file=sys.stderr)
            return 1
        save_json_secure(LICENSES_FILE, db)
    print(f"Đã thu hồi {changed} mã kích hoạt.")
    return 0


def cmd_reset_sessions(args: argparse.Namespace) -> int:
    email = args.email.strip().lower()
    with store_lock():
        db = load_db(USERS_FILE, "users")
        user = next((u for u in db["users"] if u.get("email") == email), None)
        if not user:
            print(f"Không tìm thấy user: {email}", file=sys.stderr)
            return 1
        prev = len(user.get("sessions", []))
        user["sessions"] = []
        save_json_secure(USERS_FILE, db)
    print(f"Đã xóa {prev} phiên thiết bị của {email}.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Quản lý mã kích hoạt & phiên đăng nhập Web Server.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_gen = sub.add_parser("generate", help="Sinh lô mã kích hoạt mới")
    p_gen.add_argument("--count", type=int, default=5, help="Số lượng mã (mặc định: 5)")
    p_gen.add_argument("--tier", choices=["standard", "pro"], default="standard", help="Hạng gói bản quyền: standard (mặc định) hoặc pro")
    p_gen.add_argument("--course", default=None, help="Course ID (hoặc '*' cho mọi khóa)")
    p_gen.add_argument("--prefix", default=None, help="Tiền tố mã (vd: LAO-STD, LAO-PRO)")
    p_gen.add_argument("--note", default="", help="Ghi chú đợt phát hành")
    p_gen.add_argument("--save-batch", default=None, help="Xuất danh sách mã gốc ra file 0600 riêng")

    sub.add_parser("list", help="Liệt kê trạng thái các mã kích hoạt")

    p_rev = sub.add_parser("revoke", help="Thu hồi mã theo ID (`lic_...`) hoặc mã gốc")
    p_rev.add_argument("target", help="License ID (`lic_...`) hoặc raw key")

    p_rst = sub.add_parser("reset-sessions", help="Đăng xuất toàn bộ thiết bị của 1 email")
    p_rst.add_argument("email", help="Email tài khoản")

    args = parser.parse_args()
    if args.cmd == "generate":
        return cmd_generate(args)
    if args.cmd == "list":
        return cmd_list(args)
    if args.cmd == "revoke":
        return cmd_revoke(args)
    if args.cmd == "reset-sessions":
        return cmd_reset_sessions(args)
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except CliError as exc:
        print(f"LỖI: {exc}", file=sys.stderr)
        sys.exit(2)
