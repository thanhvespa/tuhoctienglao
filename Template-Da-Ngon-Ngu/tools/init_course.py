#!/usr/bin/env python3
"""
Scaffold a clean multi-language course repository (Template-Da-Ngon-Ngu or a new language preset)
from the reusable course factory engine.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

from course_config import DEFAULT_CONFIG

ENGINE_FILES = [
    ".gitignore",
    "tools/course_config.py",
    "tools/build_study_assets.py",
    "tools/build_epub.py",
    "tools/build_web_dist.py",
    "tools/license_cli.py",
    "tools/init_course.py",
    "Web-Server/server.js",
    "Web-Server/test/server.test.js",
    "Cong-Cu-Tao-Audio-Video/generate_media.py",
    "Cong-Cu-Tao-Audio-Video/render_video.swift",
    "Cong-Cu-Tao-Audio-Video/setup_and_generate.sh",
    "Cong-Cu-Tao-Audio-Video/README-Huong-Dan-Tao-Audio-Video.md",
    "Slide-Tuong-Tac/index.html",
    "Slide-Tuong-Tac/styles.css",
    "Slide-Tuong-Tac/app.js",
    "Slide-Tuong-Tac/sw.js",
]

LANGUAGE_PRESETS: dict[str, dict[str, Any]] = {
    "generic": {
        "course_id": "tu-hoc-ngoai-ngu-template",
        "course_title": "Tự Học Nghe – Nói Ngoại Ngữ Cho Người Việt",
        "short_title": "Template Đa Ngôn Ngữ",
        "flag_emoji": "🌐",
        "target_lang": {
            "code": "en",
            "name": "Tiếng Anh",
            "script_label": "Chữ gốc",
            "phonetic_label": "Phiên âm Việt",
            "meaning_label": "Nghĩa Việt",
            "is_latin": True,
            "script_chars": "A-Za-z",
            "script_regex": "[A-Za-z]",
            "script_run_regex": "",
            "tts_keep_pattern": "[^A-Za-z0-9\\s\\.\\,\\?\\!\\-\\']",
            "google_translate_sl": "en",
        },
        "tts": {
            "female_voice": "en-US-JennyNeural",
            "male_voice": "en-US-GuyNeural",
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
        "sample": {
            "hello": ("Hello", "Hê-lô", "Xin chào"),
            "thanks": ("Thank you", "Thén-kiu", "Cảm ơn"),
            "sorry": ("Excuse me", "Ích-xkiu mi", "Xin lỗi / Làm phiền"),
            "how_much": ("How much is this?", "Hao mắtch i-dờ đít?", "Cái này bao nhiêu tiền?"),
            "yes": ("Yes", "I-ét", "Vâng / Có"),
            "no": ("No", "Nâu", "Không"),
        },
    },
    "th": {
        "course_id": "tu-hoc-tieng-thai",
        "course_title": "Tự Học Nghe – Nói Tiếng Thái Cho Người Việt",
        "short_title": "Tự Học Tiếng Thái",
        "flag_emoji": "🇹🇭",
        "target_lang": {
            "code": "th",
            "name": "Tiếng Thái",
            "script_label": "Chữ Thái",
            "is_latin": False,
            "script_chars": "\\u0E00-\\u0E7F",
            "script_regex": "[\\u0E00-\\u0E7F]",
            "script_run_regex": "([\\u0E00-\\u0E7F]+(?:[\\u0E00-\\u0E7F\\s\\u200B]*[\\u0E00-\\u0E7F]+)?)",
            "tts_keep_pattern": "[^\\u0E00-\\u0E7F0-9\\s\\.\\,\\?\\!\\-]",
            "google_translate_sl": "th",
            "alphabet_headers": ["chữ thái", "âm đọc", "từ quen đã học"],
        },
        "tts": {
            "female_voice": "th-TH-PremwadeeNeural",
            "male_voice": "th-TH-NiwatNeural",
            "default_rate": "-8%",
        },
        "fonts": {
            "target_family": "Noto Sans Thai",
            "regular": "assets/fonts/NotoSansThai-Regular.ttf",
            "bold": "assets/fonts/NotoSansThai-Bold.ttf",
            "web_regular": "fonts/NotoSansThai-Regular.ttf",
            "web_bold": "fonts/NotoSansThai-Bold.ttf",
            "video_font_name": "NotoSansThai-Bold",
            "video_fallback_font": "HelveticaNeue-Bold",
            "license_file": "assets/fonts/OFL.txt",
        },
        "sample": {
            "hello": ("สวัสดี", "Sà-wạt-đi", "Xin chào"),
            "thanks": ("ขอบคุณ", "Khọp-khun", "Cảm ơn"),
            "sorry": ("ขอโทษ", "Khỏ-thốt", "Xin lỗi"),
            "how_much": ("เท่าไหร่", "Thâu-rày", "Bao nhiêu tiền?"),
            "yes": ("ใช่", "Chay", "Đúng / Vâng"),
            "no": ("ไม่", "Mây", "Không"),
        },
    },
    "km": {
        "course_id": "tu-hoc-tieng-khmer",
        "course_title": "Tự Học Nghe – Nói Tiếng Khmer Cho Người Việt",
        "short_title": "Tự Học Tiếng Khmer",
        "flag_emoji": "🇰🇭",
        "target_lang": {
            "code": "km",
            "name": "Tiếng Khmer",
            "script_label": "Chữ Khmer",
            "is_latin": False,
            "script_chars": "\\u1780-\\u17FF",
            "script_regex": "[\\u1780-\\u17FF]",
            "script_run_regex": "([\\u1780-\\u17FF]+(?:[\\u1780-\\u17FF\\s\\u200B]*[\\u1780-\\u17FF]+)?)",
            "tts_keep_pattern": "[^\\u1780-\\u17FF0-9\\s\\.\\,\\?\\!\\-]",
            "google_translate_sl": "km",
            "alphabet_headers": ["chữ khmer", "âm đọc", "từ quen đã học"],
        },
        "tts": {
            "female_voice": "km-KH-SreymomNeural",
            "male_voice": "km-KH-PisethNeural",
            "default_rate": "-8%",
        },
        "fonts": {
            "target_family": "Noto Sans Khmer",
            "regular": "assets/fonts/NotoSansKhmer-Regular.ttf",
            "bold": "assets/fonts/NotoSansKhmer-Bold.ttf",
            "web_regular": "fonts/NotoSansKhmer-Regular.ttf",
            "web_bold": "fonts/NotoSansKhmer-Bold.ttf",
            "video_font_name": "NotoSansKhmer-Bold",
            "video_fallback_font": "HelveticaNeue-Bold",
            "license_file": "assets/fonts/OFL.txt",
        },
        "sample": {
            "hello": ("សួស្តី", "Sua-sđây", "Xin chào"),
            "thanks": ("អរគុណ", "O-kun", "Cảm ơn"),
            "sorry": ("សុំទោស", "Som-tôh", "Xin lỗi"),
            "how_much": ("តម្លៃប៉ុន្មាន", "Đam-lay pôn-man", "Bao nhiêu tiền?"),
            "yes": ("បាទ / ចាស", "Bạt (nam) / Chah (nữ)", "Vâng / Dạ"),
            "no": ("ទេ", "Tê", "Không"),
        },
    },
    "my": {
        "course_id": "tu-hoc-tieng-myanmar",
        "course_title": "Tự Học Nghe – Nói Tiếng Myanmar Cho Người Việt",
        "short_title": "Tự Học Tiếng Myanmar",
        "flag_emoji": "🇲🇲",
        "target_lang": {
            "code": "my",
            "name": "Tiếng Myanmar",
            "script_label": "Chữ Myanmar",
            "is_latin": False,
            "script_chars": "\\u1000-\\u109F",
            "script_regex": "[\\u1000-\\u109F]",
            "script_run_regex": "([\\u1000-\\u109F]+(?:[\\u1000-\\u109F\\s\\u200B]*[\\u1000-\\u109F]+)?)",
            "tts_keep_pattern": "[^\\u1000-\\u109F0-9\\s\\.\\,\\?\\!\\-]",
            "google_translate_sl": "my",
            "alphabet_headers": ["chữ myanmar", "âm đọc", "từ quen đã học"],
        },
        "tts": {
            "female_voice": "my-MM-NilarNeural",
            "male_voice": "my-MM-ThihaNeural",
            "default_rate": "-8%",
        },
        "fonts": {
            "target_family": "Noto Sans Myanmar",
            "regular": "assets/fonts/NotoSansMyanmar-Regular.ttf",
            "bold": "assets/fonts/NotoSansMyanmar-Bold.ttf",
            "web_regular": "fonts/NotoSansMyanmar-Regular.ttf",
            "web_bold": "fonts/NotoSansMyanmar-Bold.ttf",
            "video_font_name": "NotoSansMyanmar-Bold",
            "video_fallback_font": "HelveticaNeue-Bold",
            "license_file": "assets/fonts/OFL.txt",
        },
        "sample": {
            "hello": ("မင်္ဂလာပါ", "Min-gà-la-ba", "Xin chào"),
            "thanks": ("ကျေးဇူးတင်ပါတယ်", "Chê-dzu tin-ba-đe", "Cảm ơn"),
            "sorry": ("တောင်းပန်ပါတယ်", "Taung-ban ba-đe", "Xin lỗi"),
            "how_much": ("ဘယ်လောက်လဲ", "Be-lauk le", "Bao nhiêu tiền?"),
            "yes": ("ဟုတ်ကဲ့", "Hốt-kệ", "Vâng / Đúng"),
            "no": ("မဟုတ်ဘူး", "Ma-hốt-bu", "Không phải"),
        },
    },
    "ko": {
        "course_id": "tu-hoc-tieng-han",
        "course_title": "Tự Học Nghe – Nói Tiếng Hàn Cho Người Việt",
        "short_title": "Tự Học Tiếng Hàn",
        "flag_emoji": "🇰🇷",
        "target_lang": {
            "code": "ko",
            "name": "Tiếng Hàn",
            "script_label": "Chữ Hangul",
            "is_latin": False,
            "script_chars": "\\uAC00-\\uD7AF\\u1100-\\u11FF",
            "script_regex": "[\\uAC00-\\uD7AF]",
            "script_run_regex": "([\\uAC00-\\uD7AF]+(?:[\\uAC00-\\uD7AF\\s]*[\\uAC00-\\uD7AF]+)?)",
            "tts_keep_pattern": "[^\\uAC00-\\uD7AF0-9\\s\\.\\,\\?\\!\\-]",
            "google_translate_sl": "ko",
            "alphabet_headers": ["chữ hangul", "âm đọc", "từ quen đã học"],
        },
        "tts": {
            "female_voice": "ko-KR-SunHiNeural",
            "male_voice": "ko-KR-InJoonNeural",
            "default_rate": "-5%",
        },
        "fonts": {
            "target_family": "AppleSDGothicNeo-Bold",
            "regular": "",
            "bold": "",
            "web_regular": "",
            "web_bold": "",
            "video_font_name": "AppleSDGothicNeo-Bold",
            "video_fallback_font": "HelveticaNeue-Bold",
            "license_file": "",
        },
        "sample": {
            "hello": ("안녕하세요", "An-nyơng ha-xê-yô", "Xin chào"),
            "thanks": ("감사합니다", "Kam-xa ham-ni-đa", "Cảm ơn"),
            "sorry": ("죄송합니다", "Chuê-xông ham-ni-đa", "Xin lỗi"),
            "how_much": ("얼마예요?", "Ơn-ma yê-yô?", "Bao nhiêu tiền?"),
            "yes": ("네", "Nê", "Vâng / Có"),
            "no": ("아니요", "A-ni-yô", "Không"),
        },
    },
    "ja": {
        "course_id": "tu-hoc-tieng-nhat",
        "course_title": "Tự Học Nghe – Nói Tiếng Nhật Cho Người Việt",
        "short_title": "Tự Học Tiếng Nhật",
        "flag_emoji": "🇯🇵",
        "target_lang": {
            "code": "ja",
            "name": "Tiếng Nhật",
            "script_label": "Chữ Nhật",
            "is_latin": False,
            "script_chars": "\\u3040-\\u30FF\\u4E00-\\u9FFF",
            "script_regex": "[\\u3040-\\u30FF\\u4E00-\\u9FFF]",
            "script_run_regex": "([\\u3040-\\u30FF\\u4E00-\\u9FFF]+(?:[\\u3040-\\u30FF\\u4E00-\\u9FFF\\s]*[\\u3040-\\u30FF\\u4E00-\\u9FFF]+)?)",
            "tts_keep_pattern": "[^\\u3040-\\u30FF\\u4E00-\\u9FFF0-9\\s\\.\\,\\?\\!\\-]",
            "google_translate_sl": "ja",
            "alphabet_headers": ["chữ nhật", "âm đọc", "từ quen đã học"],
        },
        "tts": {
            "female_voice": "ja-JP-NanamiNeural",
            "male_voice": "ja-JP-KeitaNeural",
            "default_rate": "-5%",
        },
        "fonts": {
            "target_family": "HiraginoSans-W6",
            "regular": "",
            "bold": "",
            "web_regular": "",
            "web_bold": "",
            "video_font_name": "HiraginoSans-W6",
            "video_fallback_font": "HelveticaNeue-Bold",
            "license_file": "",
        },
        "sample": {
            "hello": ("こんにちは", "Kôn-ni-chi-oa", "Xin chào"),
            "thanks": ("ありがとうございます", "A-ri-ga-tô gô-dai-mát", "Cảm ơn"),
            "sorry": ("すみません", "Xư-mi-ma-xen", "Xin lỗi"),
            "how_much": ("いくらですか", "I-kư-ra đêt-xư ka?", "Bao nhiêu tiền?"),
            "yes": ("はい", "Hai", "Vâng"),
            "no": ("いいえ", "I-i-ê", "Không"),
        },
    },
    "zh": {
        "course_id": "tu-hoc-tieng-trung",
        "course_title": "Tự Học Nghe – Nói Tiếng Trung Cho Người Việt",
        "short_title": "Tự Học Tiếng Trung",
        "flag_emoji": "🇨🇳",
        "target_lang": {
            "code": "zh",
            "name": "Tiếng Trung",
            "script_label": "Chữ Hán",
            "phonetic_label": "Pinyin / Bồi",
            "is_latin": False,
            "script_chars": "\\u4E00-\\u9FFF",
            "script_regex": "[\\u4E00-\\u9FFF]",
            "script_run_regex": "([\\u4E00-\\u9FFF]+(?:[\\u4E00-\\u9FFF\\s]*[\\u4E00-\\u9FFF]+)?)",
            "tts_keep_pattern": "[^\\u4E00-\\u9FFF0-9\\s\\.\\,\\?\\!\\-]",
            "google_translate_sl": "zh-CN",
            "alphabet_headers": ["chữ hán", "âm đọc", "từ quen đã học"],
        },
        "tts": {
            "female_voice": "zh-CN-XiaoxiaoNeural",
            "male_voice": "zh-CN-YunxiNeural",
            "default_rate": "-5%",
        },
        "fonts": {
            "target_family": "PingFangSC-Semibold",
            "regular": "",
            "bold": "",
            "web_regular": "",
            "web_bold": "",
            "video_font_name": "PingFangSC-Semibold",
            "video_fallback_font": "HelveticaNeue-Bold",
            "license_file": "",
        },
        "sample": {
            "hello": ("你好", "Nǐ hǎo (Nỉ hảo)", "Xin chào"),
            "thanks": ("谢谢", "Xièxie (Xia xịa)", "Cảm ơn"),
            "sorry": ("对不起", "Duìbuqǐ (Tuây pu chỉ)", "Xin lỗi"),
            "how_much": ("多少钱？", "Duōshao qián? (Tua sảo chén?)", "Bao nhiêu tiền?"),
            "yes": ("是", "Shì (Sư)", "Đúng / Vâng"),
            "no": ("不是", "Bú shì (Pú sư)", "Không phải"),
        },
    },
    "id": {
        "course_id": "tu-hoc-tieng-indonesia",
        "course_title": "Tự Học Nghe – Nói Tiếng Indonesia Cho Người Việt",
        "short_title": "Tự Học Tiếng Indonesia",
        "flag_emoji": "🇮🇩",
        "target_lang": {
            "code": "id",
            "name": "Tiếng Indonesia",
            "script_label": "Chữ Indonesia",
            "is_latin": True,
            "script_chars": "A-Za-z",
            "script_regex": "[A-Za-z]",
            "script_run_regex": "",
            "tts_keep_pattern": "[^A-Za-z0-9\\s\\.\\,\\?\\!\\-\\']",
            "google_translate_sl": "id",
        },
        "tts": {
            "female_voice": "id-ID-GadisNeural",
            "male_voice": "id-ID-ArdiNeural",
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
        "sample": {
            "hello": ("Halo", "Ha-lô", "Xin chào"),
            "thanks": ("Terima kasih", "Tơ-ri-ma ka-xi", "Cảm ơn"),
            "sorry": ("Permisi", "Pơ-mi-xi", "Xin lỗi / Làm phiền"),
            "how_much": ("Berapa harganya?", "Bơ-ra-pa ha-ga-nha?", "Giá bao nhiêu?"),
            "yes": ("Ya", "Da / Ia", "Vâng / Có"),
            "no": ("Tidak", "Ti-đặc", "Không"),
        },
    },
}


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def build_config(lang: str, custom_title: str | None) -> tuple[dict[str, Any], dict[str, tuple[str, str, str]]]:
    preset = copy.deepcopy(LANGUAGE_PRESETS[lang])
    sample = preset.pop("sample")
    tl_name = preset["target_lang"]["name"]

    cfg_override = {
        **preset,
        "chapters": {
            "1": "Khởi Đầu & Chào Hỏi Cơ Bản",
        },
        "epub": {
            "output": f"Ebook/{preset['course_id'].title()}.epub",
            "title": custom_title or preset["course_title"],
            "creator": f"Chương Trình Tự Học {tl_name}",
            "description": f"Giáo trình tự học nghe nói {tl_name} 30–60 phút/ngày.",
            "uuid_seed": f"{preset['course_id']}-vi",
            "intro_titles": {
                "00": "Tổng Quan & Lộ Trình Học",
                "02": "Phương Pháp Học & Nguồn Nghe",
                "01": "Bảng Theo Dõi Tiến Trình",
            },
            "appendix_title": "Phụ Lục: Từ Điển Bỏ Túi Sinh Tồn",
        },
        "pwa": {
            "short_name": preset["short_title"].replace("Tự Học ", ""),
            "name": custom_title or preset["course_title"],
            "description": f"Ứng dụng PWA tự học {tl_name} offline: Flashcard, Shadowing, tự ghi âm & kiểm tra tự chấm điểm.",
            "storage_key": f"{preset['course_id'].replace('-', '_')}_progress_v1",
            "theme_storage_key": f"{preset['course_id'].replace('-', '_')}_theme",
            "theme_color": "#146c53",
            "background_color": "#f6f4ef",
            "export_filename": f"{preset['course_id']}-progress.json",
            "dict_placeholder": f"Gõ tiếng Việt, phiên âm hoặc {preset['target_lang']['script_label']}...",
        },
        "video": {
            "intro_tag": f"KHÓA TỰ HỌC NGHE – NÓI {tl_name.upper()}",
            "intro_target_line": f"{sample['hello'][0]} — {tl_name}",
            "intro_phonetic": "Nhìn nghĩa tiếng Việt -> Nói thử trong 2 giây -> Nghe đáp án chuẩn",
            "intro_note": "Video ôn luyện chủ động (Active Recall Flashcards)",
            "prompt_text": f"⏱️ Nghe & thử nói to bằng {tl_name}...",
            "width": 1280,
            "height": 720,
        },
        "export": {
            "notebooklm_prompt": (
                f"Hãy đóng vai 2 người dẫn chương trình người Việt hướng dẫn một người mới tự học nghe nói {tl_name}.\n"
                "- Giải thích mẹo phát âm ngắn gọn, đọc rõ cụm từ cốt lõi rồi dừng 2 giây để người nghe nhẩm theo.\n"
                "- Cuối podcast kiểm tra nhanh 5 câu phản xạ."
            ),
            "notebooklm_chat_examples": [
                f'"Kiểm tra mình 5 cụm {tl_name} trong Chương 1, chỉ đưa tiếng Việt để mình tự phản xạ."'
            ],
            "practice_hint": "Đọc từng tình huống, đếm thầm 1 - 2 - 3 rồi nói thật to câu trả lời.",
        },
    }
    if custom_title:
        cfg_override["course_title"] = custom_title
    return deep_merge(DEFAULT_CONFIG, cfg_override), sample


def write_starter_markdowns(dest: Path, cfg: dict[str, Any], sample: dict[str, tuple[str, str, str]]) -> None:
    tl = cfg["target_lang"]
    tl_name = tl["name"]
    script_lbl = tl["script_label"]
    ph_lbl = tl["phonetic_label"]
    hello, thanks, sorry, how_much, yes, no = (
        sample["hello"],
        sample["thanks"],
        sample["sorry"],
        sample["how_much"],
        sample["yes"],
        sample["no"],
    )

    (dest / "00-Tong-Quan-Va-Lo-Trinh.md").write_text(
        f"""# {cfg['course_title']}

Chào mừng bạn đến với hệ thống giáo trình đa phương tiện được xây dựng từ bộ **Template Đa Ngôn Ngữ**.

## 1. Lộ Trình Học 30–60 Phút/Ngày

1. Mở [Bài 1 - Khởi Đầu](Giao-Trinh/Chuong-01-Khoi-Dau/Bai-01-Lam-Quen.md) hoặc học trực tiếp trên **PWA (`Slide-Tuong-Tac/index.html`)**.
2. Luyện **Phản xạ 3 giây**, bấm **🎙️ Thu âm so sánh** để nghe lại giọng mình.
3. Làm [Kiểm tra Chương 1](Giao-Trinh/Chuong-01-Khoi-Dau/Kiem-Tra-Chuong-01.md) hoặc làm trực tiếp trong PWA (tự chấm Phần A & lưu điểm).

## 2. Mục Lục Giáo Trình

- [01-Theo-Doi-Tien-Trinh.md](01-Theo-Doi-Tien-Trinh.md)
- [02-Phuong-Phap-Va-Tai-Nguyen.md](02-Phuong-Phap-Va-Tai-Nguyen.md)
- [03-Tu-Dien-Bo-Tui-So-Tay.md](03-Tu-Dien-Bo-Tui-So-Tay.md)
- [Chương 1 - Bài 1: Chào hỏi làm quen](Giao-Trinh/Chuong-01-Khoi-Dau/Bai-01-Lam-Quen.md)
- [Kiểm tra Chương 1](Giao-Trinh/Chuong-01-Khoi-Dau/Kiem-Tra-Chuong-01.md)
""",
        encoding="utf-8",
    )

    (dest / "01-Theo-Doi-Tien-Trinh.md").write_text(
        f"""# Theo Dõi Tiến Trình Tự Học {tl_name}

| Chương | Bài đã học | Điểm kiểm tra (/100) | Trạng thái |
|---|---|---|---|
| Chương 1 | Bài 1 | /100 | Chưa bắt đầu |
""",
        encoding="utf-8",
    )

    (dest / "02-Phuong-Phap-Va-Tai-Nguyen.md").write_text(
        f"""# Phương Pháp Tự Học Nghe – Nói {tl_name}

- **15 phút đầu:** Nghe audio bản địa + nhẩm theo **Quy tắc 3 giây**.
- **15 phút giữa:** Đọc mẫu câu + **Tự ghi âm** trên PWA để so sánh ngữ điệu với giọng mẫu.
- **15 phút cuối:** Đóng vai hội thoại Shadowing và tắt hiển thị chữ gốc.
""",
        encoding="utf-8",
    )

    (dest / "03-Tu-Dien-Bo-Tui-So-Tay.md").write_text(
        f"""# Từ Điển Bỏ Túi Sinh Tồn ({tl_name})

## 1. Cụm Từ Sống Còn

| Tiếng Việt | {script_lbl} | {ph_lbl} | Ghi chú |
|---|---|---|---|
| {hello[2]} | {hello[0]} | *{hello[1]}* | Chào lịch sự |
| {thanks[2]} | {thanks[0]} | *{thanks[1]}* | Cảm ơn |
| {sorry[2]} | {sorry[0]} | *{sorry[1]}* | Xin lỗi / Gọi phục vụ |
| {how_much[2]} | {how_much[0]} | *{how_much[1]}* | Hỏi giá khi mua sắm |
| {yes[2]} | {yes[0]} | *{yes[1]}* | Đồng ý |
| {no[2]} | {no[0]} | *{no[1]}* | Từ chối lịch sự |
""",
        encoding="utf-8",
    )

    ch1 = dest / "Giao-Trinh" / "Chuong-01-Khoi-Dau"
    ch1.mkdir(parents=True, exist_ok=True)

    (ch1 / "Bai-01-Lam-Quen.md").write_text(
        f"""# Chương 1 – Bài 1: Chào Hỏi & Làm Quen ({tl_name})

## 1. Mẹo Phát Âm Cốt Lõi
- Nghe thật kỹ audio mẫu 3 lần trước khi nhìn chữ gốc.
- Đọc thành tiếng và dùng nút thu âm trên app để đối chiếu trọng âm.

## 2. Từ Vựng Trọng Tâm

| Tiếng Việt | {script_lbl} | {ph_lbl} | Ghi chú |
|---|---|---|---|
| {hello[2]} | {hello[0]} | *{hello[1]}* | Dùng mọi thời điểm trong ngày |
| {thanks[2]} | {thanks[0]} | *{thanks[1]}* | Nói kèm nụ cười thân thiện |
| {sorry[2]} | {sorry[0]} | *{sorry[1]}* | Xin lỗi hoặc xin phép đi qua |
| {how_much[2]} | {how_much[0]} | *{how_much[1]}* | Rất hay dùng ngoài chợ |

## 3. Mẫu Câu Giao Tiếp Xương Sống
- {hello[0]} → *{hello[1]}* ({hello[2]})
- {thanks[0]} → *{thanks[1]}* ({thanks[2]})
- {how_much[0]} → *{how_much[1]}* ({how_much[2]})

## 4. Hội Thoại Thực Tế
**Tình huống:** Gặp nhau lần đầu & cảm ơn lịch sự.

| Vai | {script_lbl} | {ph_lbl} | Tiếng Việt |
|---|---|---|---|
| A | {hello[0]} | *{hello[1]}* | {hello[2]} |
| B | {hello[0]} | *{hello[1]}* | {hello[2]} |
| A | {how_much[0]} | *{how_much[1]}* | {how_much[2]} |
| B | {thanks[0]} | *{thanks[1]}* | {thanks[2]} |

## 5. Thực Hành Phản Xạ 15 Phút
1. Đứng trước gương, tự nói câu "{hello[2]}" bằng {tl_name} 5 lần và thu âm kiểm tra.
2. Khi được giúp đỡ, phản xạ ngay câu "{thanks[2]}" trong vòng 2 giây.
""",
        encoding="utf-8",
    )

    (ch1 / "Kiem-Tra-Chuong-01.md").write_text(
        f"""# Kiểm Tra Chương 1: Chào Hỏi & Giao Tiếp Cơ Bản

## Phần A: Nghe hiểu & Nhận diện (25 điểm)
1. Nghe câu mẫu **{hello[0]}** và chọn nghĩa đúng:
   - A. Tạm biệt
   - B. {hello[2]}
   - C. Xin lỗi
2. Khi nghe thấy **{thanks[0]}**, người nói muốn diễn đạt điều gì?
   - A. {thanks[2]}
   - B. {no[2]}
   - C. {yes[2]}
3. Nghe câu hỏi **{how_much[0]}**, viết lại nghĩa tiếng Việt ngắn gọn:

## Phần B: Phản xạ nói Việt → {tl_name} (30 điểm)
1. Nói "{hello[2]}":
2. Nói "{thanks[2]}":

## Phần C: Hiểu tình huống (20 điểm)
1. Khi muốn hỏi giá món đồ ở cửa hàng, bạn dùng cụm từ nào?
   - A. {hello[0]}
   - B. {how_much[0]}
   - C. {sorry[0]}

## Phần D: Đóng vai giao tiếp thực tế (25 điểm)
Đóng vai người đi mua đồ: mở lời chào người bán hàng, hỏi giá món đồ rồi cảm ơn. Thu âm lại đoạn hội thoại 30 giây.

---

# Đáp Án

## Phần A
1. B ({hello[2]})
2. A ({thanks[2]})
3. bao nhieu tien

## Phần B
1. {hello[0]} ({hello[1]}) — {hello[2]}
2. {thanks[0]} ({thanks[1]}) — {thanks[2]}

## Phần C
1. B ({how_much[0]})

## Phần D
- Điểm 20–25: Phát âm rõ, phản xạ dưới 3 giây, dùng đủ chào + hỏi giá + cảm ơn.
- Điểm 15–19: Diễn đạt được ý chính nhưng còn ngập ngừng.
""",
        encoding="utf-8",
    )


def write_template_readme(dest: Path, lang: str, cfg: dict[str, Any]) -> None:
    font_hint = (
        f"- Copy font hợp pháp (SIL Open Font License `OFL.txt` + `.ttf`) vào `assets/fonts/` và `Slide-Tuong-Tac/fonts/` trùng khớp đường dẫn trong `course.config.json` (`{cfg['fonts'].get('regular') or 'tự chọn trên fonts.google.com'}`)."
    )
    readme = f"""# Template Khóa Học Đa Ngôn Ngữ (Multi-Language Course Factory)

Thư mục này được sinh tự động từ dự án **Tự Học Nghe – Nói** để bạn nhân bản nhanh sang các ngôn ngữ khác (`th` Thái, `km` Khmer, `my` Myanmar, `ko` Hàn, `ja` Nhật, `zh` Trung, `id` Indonesia...).

## Cấu trúc cốt lõi

- `course.config.json`: Cấu hình toàn bộ ngôn ngữ, regex tách chữ, giọng Edge TTS, font OFL, EPUB metadata, PWA branding & Video canvas.
- `Giao-Trinh/Chuong-XX-.../Bai-XX-....md`: Các bài học Markdown chuẩn (`## 1.`, `## 2.` bảng từ vựng, `## 3.` mẫu câu `→`, `## 4.` hội thoại `Vai`, `## 5.` thực hành).
- `Giao-Trinh/Chuong-XX-.../Kiem-Tra-Chuong-XX.md`: Bài kiểm tra chuẩn (`Phần A..D` + `# Đáp Án`) để PWA tự chấm trắc nghiệm/điền đáp án.
- `tools/build_study_assets.py`: Biên dịch Markdown -> `Slide-Tuong-Tac/curriculum_data.{{json,js}}`, `manifest.webmanifest`, PWA icons & gói `Export-NotebookLM-Gamma/`.
- `tools/build_epub.py`: Đóng gói EPUB 3 + TOC NCX + nhúng font hợp pháp OFL vào `Ebook/`.
- `tools/build_web_dist.py` + `Web-Server/server.js` + `tools/license_cli.py`: Tách bản học thử/trả phí vào `dist-web/` và chạy web server bảo mật kiểm tra đăng nhập & mã kích hoạt.
- `Cong-Cu-Tao-Audio-Video/`: Tạo hàng loạt MP3 giọng bản địa (Edge Neural TTS), track M4A & video flashcard `.mp4` (hỗ trợ cả `--portrait` 9:16).
- `tools/init_course.py`: CLI sinh nhanh thư mục khóa học ngôn ngữ mới.

## Quy trình 4 bước để ra mắt khóa ngôn ngữ mới

1. **Khởi tạo ngôn ngữ mong muốn** (nếu muốn tạo bộ khung cho ngôn ngữ khác preset `{lang}`):
   ```bash
   python3 tools/init_course.py --lang th --out ../Tu-Hoc-Tieng-Thai
   ```
   Các preset có sẵn: `{", ".join(LANGUAGE_PRESETS.keys())}`.
2. **Cài font chữ hợp pháp (nếu là chữ tượng hình/phi-Latin):**
   {font_hint}
   - Tải miễn phí tại [fonts.google.com/noto](https://fonts.google.com/noto) (giấy phép SIL OFL 1.1 cho phép bán thương mại).
3. **Viết hoặc dùng AI sinh nội dung `Giao-Trinh/` đúng chuẩn Markdown.**
4. **Biên dịch toàn bộ sản phẩm số & đóng gói Web bán hàng:**
   ```bash
   python3 tools/build_study_assets.py
   python3 tools/build_epub.py
   bash Cong-Cu-Tao-Audio-Video/setup_and_generate.sh all
   python3 tools/build_web_dist.py
   ```
5. **Sinh mã kích hoạt & chạy Web Server online:**
   ```bash
   python3 tools/license_cli.py generate --count 5
   node Web-Server/server.js
   # Mở trình duyệt tại: http://127.0.0.1:8787/Slide-Tuong-Tac/
   ```
"""
    (dest / "README-TEMPLATE.md").write_text(readme, encoding="utf-8")


def write_fonts_readme(dest: Path, cfg: dict[str, Any]) -> None:
    fonts_dir = dest / "assets" / "fonts"
    fonts_dir.mkdir(parents=True, exist_ok=True)
    web_fonts_dir = dest / "Slide-Tuong-Tac" / "fonts"
    web_fonts_dir.mkdir(parents=True, exist_ok=True)

    text = f"""# Font Hợp Pháp Cho EPUB, Video & PWA (SIL OFL)

Hãy tải cặp font **Noto Sans** (giấy phép **SIL Open Font License 1.1**, cho phép đóng gói thương mại miễn phí) từ Google Fonts:
- Link tải: https://fonts.google.com/noto

Đặt các file vào cả 2 thư mục `assets/fonts/` và `Slide-Tuong-Tac/fonts/` theo cấu hình trong `course.config.json`:
- `fonts.regular`: `{cfg['fonts'].get('regular') or '(không bắt buộc nếu dùng chữ Latin)'}`
- `fonts.bold`: `{cfg['fonts'].get('bold') or '(không bắt buộc nếu dùng chữ Latin)'}`
- `fonts.license_file`: `{cfg['fonts'].get('license_file') or 'assets/fonts/OFL.txt'}`
"""
    (fonts_dir / "README-FONTS.md").write_text(text, encoding="utf-8")
    (web_fonts_dir / "README-FONTS.md").write_text(text, encoding="utf-8")


def scaffold_course(source_root: Path, dest: Path, lang: str, custom_title: str | None, force: bool) -> None:
    if dest.resolve() == source_root.resolve():
        raise ValueError("Thư mục đích không được trùng với thư mục nguồn.")

    if dest.exists() and any(dest.iterdir()) and not force:
        raise FileExistsError(f"Thư mục '{dest}' đã tồn tại và không rỗng. Dùng --force để ghi đè.")

    dest.mkdir(parents=True, exist_ok=True)

    for rel in ENGINE_FILES:
        src = source_root / rel
        if not src.exists():
            raise FileNotFoundError(f"Thiếu file engine nguồn: {src}")
        dst = dest / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        if src.suffix == ".sh" or os.access(src, os.X_OK):
            dst.chmod(0o755)

    cfg, sample = build_config(lang, custom_title)
    (dest / "course.config.json").write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    write_fonts_readme(dest, cfg)
    write_starter_markdowns(dest, cfg, sample)
    write_template_readme(dest, lang, cfg)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Khởi tạo repo Template đa ngôn ngữ hoặc dự án ngôn ngữ mới."
    )
    parser.add_argument(
        "--lang",
        choices=sorted(LANGUAGE_PRESETS.keys()),
        default="generic",
        help="Preset ngôn ngữ mục tiêu (mặc định: generic)",
    )
    parser.add_argument(
        "--out",
        required=True,
        help="Đường dẫn thư mục đầu ra (vd: Template-Da-Ngon-Ngu hoặc ../Tu-Hoc-Tieng-Thai)",
    )
    parser.add_argument(
        "--title",
        default=None,
        help="Tiêu đề tùy chỉnh cho khóa học",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Cho phép ghi đè vào thư mục đích đã tồn tại",
    )
    args = parser.parse_args()

    source_root = Path(__file__).resolve().parent.parent
    dest = Path(args.out)
    if not dest.is_absolute():
        dest = (source_root / dest).resolve()

    scaffold_course(source_root, dest, args.lang, args.title, args.force)
    print(f"Đã tạo template '{args.lang}' tại: {dest}")
    print("Bước tiếp theo:")
    print(f"  cd \"{dest}\"")
    print("  python3 tools/build_study_assets.py && python3 tools/build_epub.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
