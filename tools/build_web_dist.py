#!/usr/bin/env python3
"""
Build the clean, production-ready `dist-web/` package for online deployment:
- `dist-web/public/`: App shell + ONLY configured Free Preview chapters & metadata
  (no paid chapter data, no paid exam answers, no `prompts_vi/`, no `Media-Video/`).
- `dist-web/protected/`: Full unlocked `curriculum_data.json` and audio cards/lessons
  served strictly by `Web-Server/server.js` after server-side auth & license verification.
"""

from __future__ import annotations

import argparse
import copy
import html
import json
import shutil
import sys
from pathlib import Path
from typing import Any

from course_config import load_course_config

ROOT, CFG = load_course_config(Path(__file__))
SLIDE_DIR = ROOT / "Slide-Tuong-Tac"
MEDIA_AUDIO_DIR = ROOT / "Media-Audio"


def build_preview_payload(full_data: dict[str, Any], free_chapters: set[int], free_dict_limit: int) -> dict[str, Any]:
    preview = copy.deepcopy(full_data)
    meta = preview.setdefault("meta", {})
    web_cfg = CFG.get("web", {})
    require_auth = bool(web_cfg.get("require_auth", True))

    if not require_auth:
        meta["access_mode"] = "full"
        meta["free_chapters"] = [ch["number"] for ch in full_data.get("chapters", [])]
        meta["web"] = web_cfg
        return preview

    meta["access_mode"] = "preview"
    meta["free_chapters"] = sorted(free_chapters)
    meta["web"] = web_cfg

    preview_chapters: list[dict[str, Any]] = []
    locked_nums: list[int] = []
    for ch in full_data.get("chapters", []):
        num = ch["number"]
        if num in free_chapters:
            preview_chapters.append(copy.deepcopy(ch))
        else:
            locked_nums.append(num)
            preview_chapters.append(
                {
                    "id": ch["id"],
                    "number": num,
                    "folder": ch.get("folder", ""),
                    "title": ch["title"],
                    "locked": True,
                    "lesson_count": len(ch.get("lessons", [])),
                    "vocab_count": sum(len(l.get("vocab", [])) for l in ch.get("lessons", [])),
                    "sentence_count": sum(len(l.get("sentences", [])) for l in ch.get("lessons", [])),
                    "dialogue_count": sum(len(l.get("dialogue", {}).get("lines", [])) for l in ch.get("lessons", [])),
                    "has_exam": bool(ch.get("exam")),
                    "preview_lesson_titles": [l.get("title", "") for l in ch.get("lessons", [])],
                    "lessons": [],
                    "exam": None,
                }
            )

    meta["locked_chapters"] = locked_nums
    preview["chapters"] = preview_chapters
    preview["pocket_dict"] = copy.deepcopy(full_data.get("pocket_dict", [])[: max(0, free_dict_limit)])
    return preview


def copy_tree_clean(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst)


def build_dist_web(out_dir: Path, symlink_media: bool = False) -> None:
    src_json = SLIDE_DIR / "curriculum_data.json"
    if not src_json.exists():
        raise FileNotFoundError(f"Thiếu {src_json}. Hãy chạy `python3 tools/build_study_assets.py` trước.")

    full_data = json.loads(src_json.read_text(encoding="utf-8"))
    web_cfg = CFG.get("web", {})
    free_chapters = set(int(x) for x in web_cfg.get("free_chapters", [1]))
    free_dict_limit = int(web_cfg.get("free_dict_limit", 15))

    public_dir = out_dir / "public"
    protected_dir = out_dir / "protected"
    public_app_dir = public_dir / "Slide-Tuong-Tac"

    if out_dir.exists():
        shutil.rmtree(out_dir)
    public_app_dir.mkdir(parents=True, exist_ok=True)
    protected_dir.mkdir(parents=True, exist_ok=True)

    # Copy static UI shell cleanly (replacing curriculum_data.{json,js} with preview-only data)
    for item in SLIDE_DIR.iterdir():
        if item.name in {"curriculum_data.json", "curriculum_data.js", ".DS_Store"}:
            continue
        dst_item = public_app_dir / item.name
        if item.is_dir():
            copy_tree_clean(item, dst_item)
        elif item.is_file():
            shutil.copy2(item, dst_item)

    # Write stripped preview bundle to public/
    preview_data = build_preview_payload(full_data, free_chapters, free_dict_limit)
    preview_json = json.dumps(preview_data, ensure_ascii=False, indent=2)
    (public_app_dir / "curriculum_data.json").write_text(preview_json, encoding="utf-8")
    (public_app_dir / "curriculum_data.js").write_text(
        f"window.COURSE_CURRICULUM = {preview_json};\nwindow.LAO_CURRICULUM = window.COURSE_CURRICULUM;\n",
        encoding="utf-8",
    )

    # Write root landing page (or fallback redirect page)
    landing_src = ROOT / "Landing-Page" / "index.html"
    if landing_src.exists():
        shutil.copy2(landing_src, public_dir / "index.html")
        # Landing JS lives in its own file so it runs under CSP `script-src 'self'`.
        landing_js = ROOT / "Landing-Page" / "landing.js"
        if landing_js.exists():
            shutil.copy2(landing_js, public_dir / "landing.js")
    else:
        safe_title = html.escape(str(CFG.get("course_title", "Tự Học Nghe – Nói")), quote=False)
        (public_dir / "index.html").write_text(
            f"""<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="0; url=./Slide-Tuong-Tac/" />
  <title>{safe_title}</title>
</head>
<body>
  <p>Đang mở ứng dụng <a href="./Slide-Tuong-Tac/">{safe_title}</a>...</p>
</body>
</html>
""",
            encoding="utf-8",
        )

    # Write full unlocked dataset strictly into protected/ (never publicly served)
    full_copy = copy.deepcopy(full_data)
    full_copy.setdefault("meta", {})["access_mode"] = "full"
    full_copy["meta"]["web"] = web_cfg
    (protected_dir / "curriculum_data.json").write_text(
        json.dumps(full_copy, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # Copy ONLY cards/*.mp3 and lessons/*.m4a into protected/Media-Audio/ (omit prompts_vi & Video)
    prot_media = protected_dir / "Media-Audio"
    prot_media.mkdir(parents=True, exist_ok=True)
    for sub in ("cards", "lessons"):
        src_sub = MEDIA_AUDIO_DIR / sub
        dst_sub = prot_media / sub
        if src_sub.exists():
            if symlink_media:
                dst_sub.symlink_to(src_sub.resolve())
            else:
                copy_tree_clean(src_sub, dst_sub)

    locked_count = sum(1 for c in preview_data["chapters"] if c.get("locked"))
    print(f"dist-web built: {out_dir}")
    print(f"  Public preview chapters: {sorted(free_chapters)} | Locked paid chapters: {locked_count}")
    print(f"  Protected full curriculum: {protected_dir / 'curriculum_data.json'}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Đóng gói bản deploy web bảo mật `dist-web/`.")
    parser.add_argument("--out", default="dist-web", help="Thư mục đầu ra (mặc định: dist-web)")
    parser.add_argument("--symlink-media", action="store_true", help="Tạo symlink audio cục bộ khi dev để tiết kiệm ổ đĩa")
    args = parser.parse_args()
    out = Path(args.out)
    if not out.is_absolute():
        out = (ROOT / out).resolve()
    build_dist_web(out, symlink_media=args.symlink_media)
    return 0


if __name__ == "__main__":
    sys.exit(main())
