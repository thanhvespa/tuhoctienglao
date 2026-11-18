#!/usr/bin/env python3
"""Shared loader and defaults for multi-language `course.config.json`."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

DEFAULT_CONFIG: dict[str, Any] = {
    "course_id": "tu-hoc-ngoai-ngu",
    "course_title": "Tự Học Nghe – Nói Ngoại Ngữ Cho Người Việt",
    "short_title": "Tự Học Giao Tiếp",
    "subtitle": "Nghe – Nói 30–60 phút/ngày",
    "flag_emoji": "🌐",
    "source_lang": {"code": "vi", "name": "Tiếng Việt"},
    "target_lang": {
        "code": "en",
        "name": "Ngoại ngữ",
        "script_label": "Chữ gốc",
        "phonetic_label": "Phiên âm Việt",
        "meaning_label": "Nghĩa Việt",
        "is_latin": True,
        "script_chars": "A-Za-z",
        "script_regex": "[A-Za-z]",
        "script_run_regex": "",
        "tts_keep_pattern": "[^A-Za-z0-9\\s\\.\\,\\?\\!\\-\\']",
        "forbidden_script_regex": "",
        "forbidden_script_name": "",
        "google_translate_sl": "en",
        "google_translate_tl": "vi",
        "alphabet_headers": ["chữ cái", "âm đọc", "từ quen đã học"],
    },
    "tts": {
        "provider": "edge",
        "female_voice": "en-US-JennyNeural",
        "male_voice": "en-US-GuyNeural",
        "vi_voice": "vi-VN-HoaiMyNeural",
        "default_rate": "-5%",
    },
    "fonts": {
        "target_family": "sans-serif",
        "regular": "",
        "bold": "",
        "web_regular": "",
        "web_bold": "",
        "video_font_name": "HelveticaNeue-Bold",
        "video_fallback_font": "HelveticaNeue-Bold",
        "license_file": "",
    },
    "dialogue_roles": {
        "female": ["An", "Linh", "Chị", "Cô", "Lễ tân", "Phục vụ", "Thu ngân", "A", "Việt"],
        "male": ["Minh", "Nam", "Anh", "Bác", "Bạn", "Tài xế", "Nhân viên", "Khách", "B"],
    },
    "chapters": {},
    "epub": {
        "output": "Ebook/Tu-Hoc-Nghe-Noi.epub",
        "title": "Tự Học Nghe – Nói Ngoại Ngữ Cho Người Việt",
        "creator": "Chương Trình Tự Học Ngoại Ngữ",
        "description": "Giáo trình tự học nghe nói 30–60 phút/ngày.",
        "uuid_seed": "tu-hoc-nghe-noi-template",
        "intro_titles": {
            "00": "Tổng Quan & Lộ Trình Học",
            "02": "Phương Pháp Học & Tài Nguyên",
            "01": "Bảng Theo Dõi Tiến Trình",
        },
        "appendix_title": "Phụ Lục: Từ Điển Bỏ Túi Sinh Tồn",
    },
    "pwa": {
        "short_name": "Tự Học",
        "name": "Ứng Dụng Tự Học Nghe – Nói",
        "description": "Ứng dụng PWA luyện nghe nói, phản xạ 3s, tự ghi âm & kiểm tra tự chấm điểm.",
        "storage_key": "self_study_progress_v1",
        "theme_storage_key": "self_study_theme",
        "theme_color": "#146c53",
        "background_color": "#f6f4ef",
        "export_filename": "tien-trinh-hoc.json",
        "dict_placeholder": "Gõ tiếng Việt, phiên âm hoặc chữ gốc...",
    },
    "video": {
        "intro_tag": "KHÓA TỰ HỌC NGHE – NÓI",
        "intro_target_line": "Welcome",
        "intro_phonetic": "Nhìn nghĩa tiếng Việt -> Nói thử trong 2 giây -> Nghe đáp án chuẩn",
        "intro_note": "Video ôn luyện chủ động (Active Recall Flashcards)",
        "prompt_text": "⏱️ Nghe & thử nói to...",
        "width": 1280,
        "height": 720,
    },
    "export": {
        "notebooklm_prompt": "Hãy đóng vai 2 người dẫn chương trình người Việt hướng dẫn tự học nghe nói theo nội dung giáo trình.",
        "notebooklm_chat_examples": [],
        "practice_hint": "Đọc từng tình huống bên dưới, đếm thầm 1 - 2 - 3 rồi nói thật to câu trả lời.",
    },
    "web": {
        "require_auth": True,
        "free_chapters": [1],
        "free_dict_limit": 15,
        "max_devices_per_user": 3,
        "price_note": "Mở khóa trọn bộ giáo trình & toàn bộ audio phát âm chuẩn",
        "contact_hint": "Nhập Email, mật khẩu và Mã kích hoạt nhận được sau khi đặt mua khóa học.",
    },
}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def find_project_root(start: Path | None = None) -> Path:
    cur = (start or Path(__file__)).resolve()
    if cur.is_file():
        cur = cur.parent
    for candidate in [cur, *cur.parents]:
        if (candidate / "course.config.json").exists() or (candidate / "Giao-Trinh").exists():
            return candidate
    return Path(__file__).resolve().parent.parent


def load_course_config(root: Path | None = None) -> tuple[Path, dict[str, Any]]:
    proj_root = find_project_root(root)
    cfg_path = proj_root / "course.config.json"
    if cfg_path.exists():
        raw = json.loads(cfg_path.read_text(encoding="utf-8"))
        cfg = _deep_merge(DEFAULT_CONFIG, raw)
    else:
        cfg = _deep_merge(DEFAULT_CONFIG, {})
    return proj_root, cfg


def compile_script_patterns(cfg: dict[str, Any]) -> dict[str, Any]:
    tl = cfg["target_lang"]
    script_regex_s = tl.get("script_regex") or r"[A-Za-z]"
    script_run_s = tl.get("script_run_regex") or ""
    forbidden_s = tl.get("forbidden_script_regex") or ""
    tts_keep_s = tl.get("tts_keep_pattern") or r"[^\w\s\.\,\?\!\-]"
    return {
        "is_latin": bool(tl.get("is_latin", False)),
        "script_chars": tl.get("script_chars", "A-Za-z"),
        "script_re": re.compile(script_regex_s),
        "script_run_re": re.compile(script_run_s) if script_run_s else None,
        "forbidden_re": re.compile(forbidden_s) if forbidden_s else None,
        "tts_strip_re": re.compile(tts_keep_s),
    }
