#!/usr/bin/env python3
"""
Build consolidated NotebookLM/Gamma export bundles, structured JSON/JS curriculum data,
and PWA manifest/icons from `course.config.json` + Markdown files in `Giao-Trinh/`.
"""

from __future__ import annotations

import json
import re
import struct
import subprocess
import zlib
from pathlib import Path
from typing import Any

from course_config import compile_script_patterns, load_course_config

ROOT, CFG = load_course_config(Path(__file__))
PATTERNS = compile_script_patterns(CFG)

CURRICULUM_DIR = ROOT / "Giao-Trinh"
EXPORT_DIR = ROOT / "Export-NotebookLM-Gamma"
SLIDE_DIR = ROOT / "Slide-Tuong-Tac"

SCRIPT_RE: re.Pattern[str] = PATTERNS["script_re"]
SCRIPT_RUN_RE: re.Pattern[str] | None = PATTERNS["script_run_re"]
FORBIDDEN_RE: re.Pattern[str] | None = PATTERNS["forbidden_re"]
TTS_STRIP_RE: re.Pattern[str] = PATTERNS["tts_strip_re"]
IS_LATIN: bool = PATTERNS["is_latin"]
SCRIPT_CHARS: str = PATTERNS["script_chars"]

FEMALE_ROLES = set(CFG["dialogue_roles"].get("female", []))
MALE_ROLES = set(CFG["dialogue_roles"].get("male", []))

VI_DIACRITICS_RE = re.compile(
    r"[àáảãạăằắẳẵặâầấẩẫậđèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬĐÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴ]"
)


def strip_md(text: str) -> str:
    """Remove simple inline Markdown markers cleanly while preserving content."""
    text = text.strip()
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = text.replace("`", "")
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


def clean_target_for_tts(text: str) -> str:
    """Extract clean target script text suitable for Neural TTS."""
    t = strip_md(text)
    t = re.sub(r"\[[^\]]+\]", "...", t)
    t = re.sub(r"\s+(?:vs|/|hoặc)\s+", " ... ", t, flags=re.IGNORECASE)
    cleaned = TTS_STRIP_RE.sub(" ", t)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def clean_lao_for_tts(text: str) -> str:
    """Backward-compatible alias for clean_target_for_tts."""
    return clean_target_for_tts(text)


def has_target_script(text: str, prefer_non_vi: bool = False) -> bool:
    if not text:
        return False
    if not IS_LATIN:
        return bool(SCRIPT_RE.search(text))
    if prefer_non_vi and VI_DIACRITICS_RE.search(text):
        return False
    return bool(SCRIPT_RE.search(text))


def clean_md_for_external(text: str, prefix_note: str = "") -> str:
    """Normalize Obsidian callouts & strip broken relative links for NotebookLM/Gamma."""
    lines = text.splitlines()
    out: list[str] = []
    if prefix_note:
        out.append(prefix_note)
    for line in lines:
        if line.strip().startswith("> Quay lại:") or line.strip().startswith("> Hoàn thành"):
            continue
        line = re.sub(r"\[([^\]]+)\]\((?!https?://)[^)]+\)", r"**\1**", line)
        line = re.sub(r"^>\s*\[!tip\]\s*", "> **Mẹo hay:** ", line)
        line = re.sub(r"^>\s*\[!warning\]\s*", "> **Lưu ý quan trọng:** ", line)
        line = re.sub(r"^>\s*\[!important\]\s*", "> **Trọng tâm:** ", line)
        line = re.sub(r"^>\s*\[!note\]\s*", "> **Ghi chú:** ", line)
        line = re.sub(r"^>\s*\[!quote\]\s*", "> ", line)
        out.append(line)
    return "\n".join(out).strip()


def split_table_row(line: str) -> list[str]:
    inner = line.strip().strip("|")
    return [cell.strip() for cell in inner.split("|")]


def parse_sentence_line(line: str, context: str) -> dict[str, str] | None:
    """Parse both `Target → *phonetic* (meaning)` and `Vietnamese → Target (*phonetic*)`."""
    body = re.sub(r"^(?:-\s*|\d+\.\s*)", "", line.strip())
    left, right = body.split("→", 1)
    speaker = ""
    m_sp = re.match(r"^([A-Za-zÀ-ỹ0-9 ]{1,20}):\s*(.+)$", left.strip())
    if m_sp:
        speaker = strip_md(m_sp.group(1))
        left_body = m_sp.group(2).strip()
    else:
        left_body = left.strip()

    left_clean = strip_md(left_body)
    right_s = right.strip()

    # Determine direction: for Latin-script target languages, bold Vietnamese or VI diacritics on left marks Case 2
    if IS_LATIN:
        left_is_target = not (left_body.startswith("**") or VI_DIACRITICS_RE.search(left_clean))
        right_is_target = not left_is_target
    else:
        left_is_target = bool(SCRIPT_RE.search(left_clean))
        right_is_target = bool(SCRIPT_RE.search(right_s))

    if left_is_target:
        target = left_clean
        phonetic = ""
        meaning = ""
        m_pm = re.match(r"^\*?([^*(]+?)\*?\s*\((.+)\)\s*(.*)$", right_s)
        if m_pm:
            phonetic = strip_md(m_pm.group(1))
            meaning = strip_md(m_pm.group(2))
            extra = strip_md(m_pm.group(3))
            if extra and extra not in meaning:
                meaning = f"{meaning} {extra}".strip()
        else:
            phonetic = strip_md(right_s)
    elif right_is_target:
        meaning = left_clean
        right_clean = strip_md(right_s)
        m_lp = re.match(r"^([^(\n]+?)\s*\(([^)]+)\)(.*)$", right_clean)
        if m_lp and has_target_script(m_lp.group(1)):
            target = m_lp.group(1).strip()
            phonetic = m_lp.group(2).strip()
            extra = m_lp.group(3).strip().lstrip(" .—–-")
            if extra:
                meaning = f"{meaning} — {extra}"
        else:
            target = right_clean
            phonetic = ""
    else:
        return None

    return {
        "context": f"{context}{(' (' + speaker + ')') if speaker else ''}",
        "target": target,
        "tts_target": clean_target_for_tts(target),
        "phonetic": phonetic,
        "vietnamese": meaning,
    }


def parse_tables_and_sections(lines: list[str]) -> tuple[list[dict[str, Any]], list[str]]:
    """Parse headings, section 1 tips, tables, sample sentences, and practice items."""
    tables: list[dict[str, Any]] = []
    tips: list[str] = []
    sentences: list[dict[str, str]] = []
    practice_items: list[str] = []

    current_h2 = ""
    current_h3 = ""
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("## "):
            current_h2 = strip_md(line[3:])
            current_h3 = ""
            i += 1
            continue
        if line.startswith("### "):
            current_h3 = strip_md(line[4:])
            i += 1
            continue

        if current_h2.startswith("1."):
            stripped = line.strip()
            if stripped and stripped != "---" and not stripped.startswith("> Quay"):
                cleaned = re.sub(r"^>\s*\[!\w+\]\s*", "Mẹo: ", stripped)
                cleaned = re.sub(r"^>\s*", "", cleaned)
                cleaned = strip_md(cleaned)
                if cleaned:
                    tips.append(cleaned)

        if "Thực Hành" in current_h2:
            stripped = line.strip()
            if re.match(r"^(\d+\.|-)\s+", stripped) and not stripped.startswith("- ["):
                item_text = strip_md(re.sub(r"^(\d+\.|-)\s+", "", stripped))
                if item_text:
                    prefix = f"[{current_h3}] " if current_h3 else ""
                    practice_items.append(prefix + item_text)

        if (
            line.strip().startswith("|")
            and i + 1 < len(lines)
            and re.match(r"^\|\s*[:\-| ]+\|\s*$", lines[i + 1].strip())
        ):
            headers = [strip_md(h) for h in split_table_row(line)]
            rows: list[list[str]] = []
            j = i + 2
            while j < len(lines) and lines[j].strip().startswith("|"):
                row_cells = split_table_row(lines[j])
                while len(row_cells) < len(headers):
                    row_cells.append("")
                rows.append(row_cells[: len(headers)])
                j += 1
            tables.append(
                {"h2": current_h2, "h3": current_h3, "headers": headers, "rows": rows}
            )
            i = j
            continue

        stripped = line.strip()
        if (
            (stripped.startswith("- ") or re.match(r"^\d+\.\s+", stripped))
            and not stripped.startswith("- [")
            and "→" in stripped
            and has_target_script(stripped)
            and "Thực Hành" not in current_h2
        ):
            parsed = parse_sentence_line(stripped, current_h3 or current_h2)
            if parsed:
                sentences.append(parsed)
        elif (
            "Mẫu Câu" in current_h2
            and stripped.startswith("- **")
            and "→" not in stripped
            and not line.startswith("  ")
        ):
            vi_head = strip_md(stripped[2:])
            j = i + 1
            target_parts: list[str] = []
            ph_parts: list[str] = []
            while j < len(lines) and (lines[j].startswith("  ") or not lines[j].strip()):
                sub = lines[j].strip()
                if sub.startswith("- "):
                    sub_clean = strip_md(sub[2:])
                    if has_target_script(sub_clean, prefer_non_vi=True):
                        m_lp = re.match(r"^([^\(]+?)\s*\(([^)]+)\)(.*)$", sub_clean)
                        if m_lp and has_target_script(m_lp.group(1)):
                            target_parts.append(m_lp.group(1).strip())
                            ph_parts.append(m_lp.group(2).strip())
                        else:
                            target_parts.append(sub_clean)
                    elif target_parts:
                        ph_parts.append(sub_clean)
                j += 1
            if target_parts:
                sentences.append(
                    {
                        "context": current_h3 or current_h2,
                        "target": " / ".join(target_parts),
                        "tts_target": clean_target_for_tts(target_parts[0]),
                        "phonetic": " | ".join(ph_parts),
                        "vietnamese": vi_head,
                    }
                )
                i = j
                continue

        i += 1

    return (
        [
            {"type": "tables", "data": tables},
            {"type": "tips", "data": tips},
            {"type": "sentences", "data": sentences},
            {"type": "practice", "data": practice_items},
        ],
        [],
    )


def classify_table(tbl: dict[str, Any]) -> tuple[str, list[dict[str, str]]]:
    """Convert a parsed Markdown table into either dialogue lines or vocab items."""
    hdrs = [h.lower() for h in tbl["headers"]]
    rows = tbl["rows"]
    alphabet_hdrs = [h.lower() for h in CFG["target_lang"].get("alphabet_headers", [])]

    if hdrs and hdrs[0] == "vai":
        lines = []
        for idx, r in enumerate(rows):
            role = strip_md(r[0]) if len(r) > 0 else ""
            target = strip_md(r[1]) if len(r) > 1 else ""
            phonetic = strip_md(r[2]) if len(r) > 2 else ""
            vi = strip_md(r[3]) if len(r) > 3 else ""
            if role in FEMALE_ROLES:
                gender = "female"
            elif role in MALE_ROLES:
                gender = "male"
            else:
                gender = "female" if idx % 2 == 0 else "male"
            if target:
                lines.append(
                    {
                        "role": role,
                        "gender": gender,
                        "target": target,
                        "tts_target": clean_target_for_tts(target),
                        "phonetic": phonetic,
                        "vietnamese": vi,
                    }
                )
        return "dialogue", lines

    vocab: list[dict[str, str]] = []
    if "cặp số" in hdrs[0] or "tên gọi gần đúng" in hdrs[0]:
        for r in rows:
            label = strip_md(r[0])
            target = strip_md(r[1])
            phonetic = strip_md(r[2])
            meaning = strip_md(r[3]) if len(r) > 3 else ""
            note = strip_md(r[4]) if len(r) > 4 else ""
            vi = f"{meaning} ({label})" if meaning else label
            vocab.append(
                {
                    "target": target,
                    "tts_target": clean_target_for_tts(target),
                    "phonetic": phonetic,
                    "vietnamese": vi,
                    "note": note,
                }
            )
        return "vocab", vocab

    if hdrs[0] == "tháng":
        for r in rows:
            month_vi = strip_md(r[0])
            casual = strip_md(r[1])
            formal = strip_md(r[2])
            ph_formal = strip_md(r[3]) if len(r) > 3 else ""
            m_l = re.match(r"^([^(]+?)\s*\(([^)]+)\)", casual)
            if m_l:
                tgt_c = strip_md(m_l.group(1))
                ph_c = strip_md(m_l.group(2))
            else:
                tgt_c, ph_c = casual, ""
            vocab.append(
                {
                    "target": tgt_c,
                    "tts_target": clean_target_for_tts(tgt_c),
                    "phonetic": ph_c,
                    "vietnamese": month_vi,
                    "note": f"Trang trọng: {formal} ({ph_formal})" if formal else "",
                }
            )
        return "vocab", vocab

    if alphabet_hdrs and hdrs == alphabet_hdrs:
        for r in rows:
            ch = strip_md(r[0])
            sound = strip_md(r[1])
            example = strip_md(r[2])
            m_ex = SCRIPT_RUN_RE.search(example) if SCRIPT_RUN_RE else SCRIPT_RE.search(example)
            tts = m_ex.group(0) if m_ex else clean_target_for_tts(ch)
            vocab.append(
                {
                    "target": ch,
                    "tts_target": tts,
                    "phonetic": sound,
                    "vietnamese": example,
                    "note": tbl["h3"] or f"Mặt chữ {CFG['target_lang']['name']}",
                }
            )
        return "vocab", vocab

    if len(hdrs) >= 4 and "biển hiệu" in hdrs[1]:
        for r in rows:
            target = strip_md(r[1])
            phonetic = strip_md(r[2])
            vi = strip_md(r[3])
            note = strip_md(r[4]) if len(r) > 4 else ""
            vocab.append(
                {
                    "target": target,
                    "tts_target": clean_target_for_tts(target),
                    "phonetic": phonetic,
                    "vietnamese": vi,
                    "note": note,
                }
            )
        return "vocab", vocab

    for r in rows:
        vi = strip_md(r[0]) if len(r) > 0 else ""
        target = strip_md(r[1]) if len(r) > 1 else ""
        phonetic = strip_md(r[2]) if len(r) > 2 else ""
        note = strip_md(r[3]) if len(r) > 3 else ""
        if target:
            vocab.append(
                {
                    "target": target,
                    "tts_target": clean_target_for_tts(target),
                    "phonetic": phonetic,
                    "vietnamese": vi,
                    "note": note,
                }
            )
    return "vocab", vocab


def extract_target_prompts(raw_text: str) -> list[str]:
    clean = strip_md(raw_text)
    if SCRIPT_RUN_RE:
        return [m.strip() for m in SCRIPT_RUN_RE.findall(clean) if m.strip()]
    if not IS_LATIN:
        pattern = re.compile(rf"([{SCRIPT_CHARS}][^{chr(10)}→\(\)*]+[{SCRIPT_CHARS}\?\!]*)")
        return [m.strip() for m in pattern.findall(clean) if m.strip()]
    m_bold = re.search(r"\*\*([^*]+)\*\*", raw_text)
    if m_bold:
        return [strip_md(m_bold.group(1))]
    return []


def parse_numbered_block(lines: list[str]) -> list[dict[str, Any]]:
    """Parse top-level `1. ...` items with optional nested bullet options `- A. ...`."""
    items: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    for line in lines:
        s = line.strip()
        if not s or s == "---":
            continue
        m_num = re.match(r"^(\d+)\.\s+(.+)$", s)
        if m_num:
            if cur:
                items.append(cur)
            raw_text = m_num.group(2).strip()
            target_matches = extract_target_prompts(raw_text)
            cur = {
                "num": int(m_num.group(1)),
                "text": strip_md(raw_text),
                "target_prompt": target_matches[0] if target_matches else "",
                "options": [],
            }
        elif cur and (s.startswith("- ") or re.match(r"^\([a-z]\)\s+", s)):
            cur["options"].append(strip_md(re.sub(r"^-\s+", "", s)))
    if cur:
        items.append(cur)
    return items


def enrich_part_a_grading(item: dict[str, Any], points_each: float) -> None:
    """Detect question_type ('mcq' | 'text') and canonical expected answer for auto-grading."""
    opts = item.get("options", [])
    ans_raw = strip_md(item.get("answer", ""))
    item["points"] = points_each

    # Handle single sub-question line containing slash choices like "(Từ 1 / Từ 2 / Từ 3)"
    if len(opts) == 1:
        m_slash = re.search(r"\(([^)]+/[^)]+)\)\s*$", opts[0])
        if m_slash:
            choices = [c.strip() for c in m_slash.group(1).split("/") if c.strip()]
            if len(choices) >= 2:
                prompt_extra = opts[0][: m_slash.start()].strip()
                if prompt_extra and prompt_extra not in item["text"]:
                    item["text"] = f"{item['text']} — {prompt_extra}"
                opts = choices
                item["options"] = opts

    if len(opts) >= 2:
        item["question_type"] = "mcq"
        correct_idx = -1
        # Pattern 1: Answer starts with option letter A/B/C/D
        m_let = re.match(r"^([A-D])(?:\b|[\.\)\:\s])", ans_raw)
        if m_let:
            letter = m_let.group(1).upper()
            for idx, op in enumerate(opts):
                if re.match(rf"^{letter}[\.\)\:\s]", op.strip(), re.IGNORECASE):
                    correct_idx = idx
                    break
            if correct_idx < 0:
                letter_pos = ord(letter) - ord("A")
                if 0 <= letter_pos < len(opts):
                    correct_idx = letter_pos
        # Pattern 2: Answer explicitly contains one of the option strings (e.g. "Từ 1")
        if correct_idx < 0:
            ans_low = ans_raw.lower()
            for idx, op in enumerate(opts):
                if op.lower() in ans_low:
                    correct_idx = idx
                    break
        item["correct_index"] = correct_idx
        item["expected_answer"] = opts[correct_idx] if correct_idx >= 0 else ans_raw
    else:
        item["question_type"] = "text"
        item["correct_index"] = -1
        item["expected_answer"] = re.sub(r"\s+", "", ans_raw).lower()


def parse_exam(path: Path, chap_num: int) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    lines = raw.splitlines()
    title = strip_md(lines[0].lstrip("# ").strip()) if lines else path.stem

    q_sections: dict[str, list[str]] = {}
    a_sections: dict[str, list[str]] = {}
    in_answers = False
    cur_key = ""

    for line in lines[1:]:
        if line.startswith("# Đáp Án"):
            in_answers = True
            cur_key = ""
            continue
        if line.startswith("## "):
            heading = strip_md(line[3:])
            cur_key = heading
            target_map = a_sections if in_answers else q_sections
            target_map[cur_key] = []
            continue
        if cur_key:
            target_map = a_sections if in_answers else q_sections
            target_map[cur_key].append(line)

    def find_section(secs: dict[str, list[str]], prefix: str) -> tuple[str, list[str]]:
        for k, v in secs.items():
            if prefix in k:
                return k, v
        return "", []

    pa_title, pa_lines = find_section(q_sections, "Phần A")
    pb_title, pb_lines = find_section(q_sections, "Phần B")
    pc_title, pc_lines = find_section(q_sections, "Phần C")
    pd_title, pd_lines = find_section(q_sections, "Phần D")

    _, aa_lines = find_section(a_sections, "Phần A")
    _, ab_lines = find_section(a_sections, "Phần B")
    _, ac_lines = find_section(a_sections, "Phần C")
    _, ad_lines = find_section(a_sections, "Phần D")

    pa_items = parse_numbered_block(pa_lines)
    aa_items = parse_numbered_block(aa_lines)
    aa_map = {x["num"]: x["text"] for x in aa_items}
    pa_pts = round(25.0 / max(1, len(pa_items)), 2)
    for idx, item in enumerate(pa_items, 1):
        item["answer"] = aa_map.get(item["num"], "")
        item["tts_target"] = clean_target_for_tts(item["target_prompt"]) if item["target_prompt"] else ""
        item["audio_id"] = f"c{chap_num:02d}_test_a{idx:02d}"
        enrich_part_a_grading(item, pa_pts)

    pb_items = parse_numbered_block(pb_lines)
    ab_items = parse_numbered_block(ab_lines)
    ab_map = {x["num"]: x for x in ab_items}
    pb_pts = round(30.0 / max(1, len(pb_items)), 2)
    for idx, item in enumerate(pb_items, 1):
        ans = ab_map.get(item["num"], {})
        ans_text = ans.get("text", "")
        m_ap = re.match(r"^([^(\n]+?)\s*\(([^)]+)\)(.*)$", ans_text)
        if m_ap and has_target_script(m_ap.group(1)):
            tgt_ans = m_ap.group(1).strip()
            ph_ans = m_ap.group(2).strip()
            extra = m_ap.group(3).strip()
        else:
            tgt_ans = ans.get("target_prompt", "")
            ph_ans = ""
            extra = ans_text
        item["answer_target"] = tgt_ans
        item["tts_target"] = clean_target_for_tts(tgt_ans) if tgt_ans else ""
        item["answer_phonetic"] = ph_ans
        item["answer_full"] = ans_text if not extra else f"{tgt_ans} ({ph_ans}) {extra}".strip()
        item["audio_id"] = f"c{chap_num:02d}_test_b{idx:02d}"
        item["points"] = pb_pts

    pc_items = parse_numbered_block(pc_lines)
    ac_items = parse_numbered_block(ac_lines)
    ac_map = {x["num"]: x for x in ac_items}
    pc_pts = round(20.0 / max(1, len(pc_items)), 2)
    for item in pc_items:
        ans = ac_map.get(item["num"], {})
        item["answer"] = ans.get("text", "")
        if ans.get("options"):
            item["answer"] += " | " + "; ".join(ans["options"])
        item["points"] = pc_pts

    pd_prompt = "\n".join(strip_md(l) for l in pd_lines if l.strip() and l.strip() != "---")
    pd_rubric = "\n".join(strip_md(l) for l in ad_lines if l.strip() and l.strip() != "---")

    return {
        "id": f"c{chap_num:02d}_test",
        "filename": path.name,
        "title": title,
        "part_a": {"title": pa_title, "max_points": 25, "items": pa_items},
        "part_b": {"title": pb_title, "max_points": 30, "items": pb_items},
        "part_c": {"title": pc_title, "max_points": 20, "items": pc_items},
        "part_d": {"title": pd_title, "max_points": 25, "prompt": pd_prompt, "rubric": pd_rubric},
        "raw_md": raw,
    }


def parse_lesson(path: Path, chap_num: int, lesson_num: int) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    lines = raw.splitlines()
    title = strip_md(lines[0].lstrip("# ").strip()) if lines else path.stem

    parsed_blocks, _ = parse_tables_and_sections(lines[1:])
    block_map = {b["type"]: b["data"] for b in parsed_blocks}

    vocab: list[dict[str, Any]] = []
    dialogue_lines: list[dict[str, Any]] = []
    dialogue_context = ""

    for l in lines:
        if l.strip().startswith("**Tình huống:**"):
            dialogue_context = strip_md(l.replace("**Tình huống:**", "").strip())
            break

    v_idx = 0
    d_idx = 0
    for tbl in block_map["tables"]:
        kind, items = classify_table(tbl)
        if kind == "dialogue":
            for it in items:
                d_idx += 1
                it["audio_id"] = f"c{chap_num:02d}_b{lesson_num:02d}_d{d_idx:02d}"
                dialogue_lines.append(it)
        else:
            for it in items:
                v_idx += 1
                it["audio_id"] = f"c{chap_num:02d}_b{lesson_num:02d}_v{v_idx:02d}"
                it["section"] = tbl["h3"] or tbl["h2"]
                vocab.append(it)

    sentences = []
    for s_idx, s in enumerate(block_map["sentences"], 1):
        s["audio_id"] = f"c{chap_num:02d}_b{lesson_num:02d}_s{s_idx:02d}"
        sentences.append(s)

    return {
        "id": f"c{chap_num:02d}_b{lesson_num:02d}",
        "number": lesson_num,
        "filename": path.name,
        "title": title,
        "tips": block_map["tips"],
        "vocab": vocab,
        "sentences": sentences,
        "dialogue": {"context": dialogue_context, "lines": dialogue_lines},
        "practice": block_map["practice"],
        "raw_md": raw,
    }


def parse_pocket_dict() -> list[dict[str, str]]:
    p = ROOT / "03-Tu-Dien-Bo-Tui-So-Tay.md"
    if not p.exists():
        return []
    lines = p.read_text(encoding="utf-8").splitlines()
    blocks, _ = parse_tables_and_sections(lines)
    tables = blocks[0]["data"]
    items: list[dict[str, str]] = []
    idx = 0
    for tbl in tables:
        _, rows = classify_table(tbl)
        cat = tbl["h2"] or tbl["h3"] or "Sinh tồn"
        for r in rows:
            idx += 1
            r["category"] = cat
            r["audio_id"] = f"dict_{idx:03d}"
            items.append(r)
    return items


def build_gamma_markdown(chapter: dict[str, Any]) -> str:
    """Create a Gamma.app paste-ready slide deck markdown with `---` card dividers."""
    tl = CFG["target_lang"]
    script_label = tl["script_label"]
    phonetic_label = tl["phonetic_label"]
    target_name = tl["name"]

    cards: list[str] = [
        f"# Chương {chapter['number']}: {chapter['title']}\n\n"
        f"**{CFG['course_title']}**\n"
        f"- Số bài học: {len(chapter['lessons'])} bài + 1 bài kiểm tra tổng hợp\n"
        f"- Mục tiêu: Phản xạ 3 giây, phát âm chuẩn {target_name}, thực hành ngay"
    ]

    for les in chapter["lessons"]:
        tips_md = (
            "\n".join(f"- {t}" for t in les["tips"][:5])
            if les["tips"]
            else "- Tập trung nghe kỹ âm thanh và ngữ điệu mẫu."
        )
        cards.append(f"## {les['title']} — Trọng Tâm & Mẹo Nhanh\n\n{tips_md}")

        vocab = les["vocab"]
        for start in range(0, len(vocab), 6):
            batch = vocab[start : start + 6]
            part_label = f" (Phần {start // 6 + 1})" if len(vocab) > 6 else ""
            rows_md = [
                f"| {v['vietnamese']} | {v['target']} | {v['phonetic']} | {v['note']} |"
                for v in batch
            ]
            table_md = (
                f"| Tiếng Việt | {script_label} | {phonetic_label} | Ghi chú |\n"
                "|---|---|---|---|\n" + "\n".join(rows_md)
            )
            cards.append(f"### {les['title']} — Từ Vựng{part_label}\n\n{table_md}")

        if les["sentences"]:
            sent_batches = [les["sentences"][i : i + 5] for i in range(0, len(les["sentences"]), 5)]
            for idx, sb in enumerate(sent_batches, 1):
                s_lines = [
                    f"- **{s['target']}** → *{s['phonetic']}* — {s['vietnamese']}"
                    for s in sb
                ]
                suffix = f" ({idx})" if len(sent_batches) > 1 else ""
                cards.append(f"### {les['title']} — Mẫu Câu Giao Tiếp{suffix}\n\n" + "\n".join(s_lines))

        if les["dialogue"]["lines"]:
            ctx = f"**Tình huống:** {les['dialogue']['context']}\n\n" if les["dialogue"]["context"] else ""
            d_rows = [
                f"| **{d['role']}** | {d['target']} | {d['phonetic']} | {d['vietnamese']} |"
                for d in les["dialogue"]["lines"]
            ]
            d_table = (
                f"| Vai | {script_label} | {phonetic_label} | Nghĩa |\n"
                "|---|---|---|---|\n" + "\n".join(d_rows)
            )
            cards.append(f"### {les['title']} — Hội Thoại Thực Hành\n\n{ctx}{d_table}")

        if les["practice"]:
            p_lines = [f"- {p}" for p in les["practice"][:6]]
            cards.append(f"### {les['title']} — Thử Thách Phản Xạ 3 Giây\n\n" + "\n".join(p_lines))

    test = chapter["exam"]
    b_prompts = [f"{it['num']}. {it['text']}" for it in test["part_b"]["items"][:10]]
    cards.append(
        f"## Kiểm Tra Nhanh Cuối Chương {chapter['number']}\n\n"
        f"**Thử thách phản xạ nói Việt → {target_name} (trả lời trong 3 giây):**\n\n"
        + "\n".join(b_prompts)
    )

    return "\n\n---\n\n".join(cards) + "\n"


def write_notebooklm_gamma_exports(chapters: list[dict[str, Any]]) -> None:
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    target_name = CFG["target_lang"]["name"]
    nlm_prompt = CFG["export"].get("notebooklm_prompt", "").strip()
    chat_examples = CFG["export"].get("notebooklm_chat_examples", [])
    chat_md = "\n".join(f"   - {ex}" for ex in chat_examples) if chat_examples else (
        f"   - *\"Kiểm tra mình 10 từ vựng ngẫu nhiên của Chương 1, chỉ đưa tiếng Việt để mình tự phản xạ {target_name}.\"*"
    )

    guide = f"""# Hướng Dẫn Dùng Giáo Trình Với NotebookLM & Gamma

Thư mục này đã gộp toàn bộ giáo trình thành **các gói chuẩn hóa**, giúp bạn import trong 30 giây vào **Google NotebookLM**, **Gamma.app**, **Canva**, hoặc **ChatGPT/Gemini**.

## 1. Cách dùng với Google NotebookLM (Tạo Podcast & Hỏi Đáp AI)

1. Mở [notebooklm.google.com](https://notebooklm.google.com) → Tạo Notebook mới (**Create new**).
2. Chọn tải nguồn (**Add sources**):
   - **Cách gọn nhất (1 file duy nhất):** Tải lên file `Toan-Bo-Giao-Trinh-Master.md`.
   - **Hoặc chia theo từng chương:** Tải lên `Chuong-01.md` ... `Chuong-{len(chapters):02d}.md`.
3. **Bấm tạo Audio Overview (Podcast AI)** với nút **Customize** và dán câu lệnh sau:

```text
{nlm_prompt}
```

4. **Dùng ô Chat trong NotebookLM** để tự ôn:
{chat_md}

---

## 2. Cách tạo Slide Đẹp Trong 1 Phút Với Gamma.app

1. Mở [gamma.app](https://gamma.app) → Chọn **Create new AI** → **Paste in text**.
2. Mở file `Gamma-Slide-Chuong-XX.md`, copy toàn bộ nội dung dán vào Gamma.
3. Chọn **Preserve card breaks (`---`)** → Bấm **Generate**.
"""
    (EXPORT_DIR / "README-Huong-Dan-Import.md").write_text(guide, encoding="utf-8")

    master_parts: list[str] = []
    for root_file in [
        "00-Tong-Quan-Va-Lo-Trinh.md",
        "02-Phuong-Phap-Va-Tai-Nguyen.md",
        "03-Tu-Dien-Bo-Tui-So-Tay.md",
    ]:
        p = ROOT / root_file
        if p.exists():
            master_parts.append(clean_md_for_external(p.read_text(encoding="utf-8")))

    for ch in chapters:
        ch_parts: list[str] = [f"# CHƯƠNG {ch['number']}: {ch['title'].upper()}\n"]
        for les in ch["lessons"]:
            ch_parts.append(clean_md_for_external(les["raw_md"]))
        if ch.get("exam") and ch["exam"].get("raw_md"):
            ch_parts.append(clean_md_for_external(ch["exam"]["raw_md"]))

        ch_doc = "\n\n---\n\n".join(ch_parts) + "\n"
        (EXPORT_DIR / f"Chuong-{ch['number']:02d}.md").write_text(ch_doc, encoding="utf-8")
        (EXPORT_DIR / f"Gamma-Slide-Chuong-{ch['number']:02d}.md").write_text(
            build_gamma_markdown(ch), encoding="utf-8"
        )
        master_parts.append(ch_doc)

    master_doc = "\n\n================================================================\n\n".join(master_parts) + "\n"
    (EXPORT_DIR / "Toan-Bo-Giao-Trinh-Master.md").write_text(master_doc, encoding="utf-8")


def _write_pure_python_png(path: Path, size: int, hex_bg: str) -> None:
    """Create a crisp rounded-badge RGBA PNG icon with zero external Python packages."""
    rgb = hex_bg.lstrip("#")
    r0, g0, b0 = int(rgb[0:2], 16), int(rgb[2:4], 16), int(rgb[4:6], 16)
    r1, g1, b1 = max(0, r0 - 18), max(0, g0 - 18), max(0, b0 - 12)
    margin = int(size * 0.06)
    rad = int(size * 0.22)
    cx, cy = size / 2.0, size / 2.0
    ring_r_out, ring_r_in = size * 0.30, size * 0.21

    def in_rounded_rect(x: int, y: int) -> bool:
        x0, x1 = margin, size - margin - 1
        y0, y1 = margin, size - margin - 1
        if x < x0 or x > x1 or y < y0 or y > y1:
            return False
        dx = max(x0 + rad - x, 0, x - (x1 - rad))
        dy = max(y0 + rad - y, 0, y - (y1 - rad))
        return (dx * dx + dy * dy) <= rad * rad

    raw_rows = bytearray()
    for y in range(size):
        raw_rows.append(0)
        t = y / max(1, size - 1)
        br = int(r0 * (1 - t) + r1 * t)
        bg = int(g0 * (1 - t) + g1 * t)
        bb = int(b0 * (1 - t) + b1 * t)
        for x in range(size):
            if not in_rounded_rect(x, y):
                raw_rows.extend((0, 0, 0, 0))
                continue
            dist = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
            # Draw stylized speech/sound emblem inside badge
            if ring_r_in <= dist <= ring_r_out or dist <= size * 0.09:
                raw_rows.extend((255, 255, 255, 255))
            elif size * 0.36 <= dist <= size * 0.40 and abs(x - cx) > size * 0.14:
                raw_rows.extend((235, 140, 76, 255))
            else:
                raw_rows.extend((br, bg, bb, 255))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack("!I", len(data)) + tag + data + struct.pack("!I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack("!IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw_rows), 9)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    path.write_bytes(png)


def ensure_pwa_assets() -> None:
    """Write PWA manifest.webmanifest and generate icons if missing."""
    pwa = CFG["pwa"]
    icons_dir = SLIDE_DIR / "icons"
    icons_dir.mkdir(parents=True, exist_ok=True)

    theme_color = pwa.get("theme_color", "#146c53")
    bg_color = pwa.get("background_color", "#f6f4ef")
    short_title = CFG.get("short_title", pwa.get("short_name", "Tự Học"))

    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
        f'<rect width="512" height="512" rx="112" fill="{theme_color}"/>'
        f'<circle cx="256" cy="240" r="132" fill="none" stroke="#ffffff" stroke-width="26"/>'
        f'<circle cx="256" cy="240" r="56" fill="#eb8c4c"/>'
        f'<text x="256" y="440" text-anchor="middle" font-family="sans-serif" '
        f'font-size="48" font-weight="700" fill="#ffffff">{CFG["target_lang"]["code"].upper()}</text>'
        f'</svg>\n'
    )
    (icons_dir / "icon.svg").write_text(svg, encoding="utf-8")

    for sz in (192, 512):
        png_path = icons_dir / f"icon-{sz}.png"
        if not png_path.exists():
            # Try rendering crisp flag+emblem PNG via Swift/CoreGraphics if on macOS, else pure Python
            swift_ok = False
            if Path("/usr/bin/swift").exists():
                swift_code = (
                    "import AppKit\n"
                    f"let size = CGSize(width: {sz}, height: {sz})\n"
                    "let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!\n"
                    "NSGraphicsContext.saveGraphicsState()\n"
                    "NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)\n"
                    f"let path = NSBezierPath(roundedRect: NSRect(origin: .zero, size: size), xRadius: size.width*0.22, yRadius: size.height*0.22)\n"
                    "NSColor(calibratedRed: 0.078, green: 0.424, blue: 0.325, alpha: 1.0).setFill()\n"
                    "path.fill()\n"
                    "let ring = NSBezierPath(ovalIn: NSRect(x: size.width*0.18, y: size.height*0.18, width: size.width*0.64, height: size.height*0.64))\n"
                    "NSColor.white.withAlphaComponent(0.16).setFill()\n"
                    "ring.fill()\n"
                    f"let flag = \"{CFG['flag_emoji']}\" as NSString\n"
                    f"let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size.width * 0.50)]\n"
                    "let fsz = flag.size(withAttributes: attrs)\n"
                    "flag.draw(at: NSPoint(x: (size.width - fsz.width)/2, y: (size.height - fsz.height)/2), withAttributes: attrs)\n"
                    "NSGraphicsContext.restoreGraphicsState()\n"
                    "if let data = rep.representation(using: .png, properties: [:]) {\n"
                    f"  try data.write(to: URL(fileURLWithPath: \"{png_path.as_posix()}\"))\n"
                    "}\n"
                )
                try:
                    subprocess.run(
                        ["swift", "-module-cache-path", "/tmp/swift_modcache", "-"],
                        input=swift_code,
                        text=True,
                        check=True,
                        capture_output=True,
                    )
                    swift_ok = png_path.exists() and png_path.stat().st_size > 200
                except Exception:
                    swift_ok = False
            if not swift_ok:
                _write_pure_python_png(png_path, sz, theme_color)

    manifest = {
        "name": pwa.get("name", CFG["course_title"]),
        "short_name": pwa.get("short_name", short_title),
        "description": pwa.get("description", ""),
        "start_url": "./index.html",
        "scope": "./",
        "display": "standalone",
        "orientation": "any",
        "background_color": bg_color,
        "theme_color": theme_color,
        "lang": CFG["source_lang"]["code"],
        "icons": [
            {"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable"},
            {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable"},
            {"src": "icons/icon.svg", "sizes": "any", "type": "image/svg+xml"},
        ],
    }
    (SLIDE_DIR / "manifest.webmanifest").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main() -> None:
    chap_dirs = sorted(
        d for d in CURRICULUM_DIR.iterdir() if d.is_dir() and d.name.startswith("Chuong-")
    )
    chapters: list[dict[str, Any]] = []
    chap_titles_cfg = CFG.get("chapters", {})

    for c_idx, c_dir in enumerate(chap_dirs, 1):
        lesson_files = sorted(c_dir.glob("Bai-*.md"))
        test_files = sorted(c_dir.glob("Kiem-Tra-*.md"))

        lessons = [
            parse_lesson(lf, c_idx, l_idx) for l_idx, lf in enumerate(lesson_files, 1)
        ]
        exam = parse_exam(test_files[0], c_idx) if test_files else None

        raw_slug = re.sub(r"^Chuong-\d{2}-", "", c_dir.name)
        title = chap_titles_cfg.get(str(c_idx)) or raw_slug.replace("-", " ")
        chapters.append(
            {
                "id": f"c{c_idx:02d}",
                "number": c_idx,
                "folder": c_dir.name,
                "title": title,
                "lessons": lessons,
                "exam": exam,
            }
        )

    pocket_dict = parse_pocket_dict()

    slim_chapters: list[dict[str, Any]] = []
    stats = {"chapters": len(chapters), "lessons": 0, "vocab": 0, "sentences": 0, "dialogues": 0, "tests": 0}
    for ch in chapters:
        slim_lessons = []
        for les in ch["lessons"]:
            stats["lessons"] += 1
            stats["vocab"] += len(les["vocab"])
            stats["sentences"] += len(les["sentences"])
            stats["dialogues"] += len(les["dialogue"]["lines"])
            slim_lessons.append({k: v for k, v in les.items() if k != "raw_md"})
        slim_exam = {k: v for k, v in ch["exam"].items() if k != "raw_md"} if ch["exam"] else None
        if slim_exam:
            stats["tests"] += 1
        slim_chapters.append(
            {
                "id": ch["id"],
                "number": ch["number"],
                "folder": ch["folder"],
                "title": ch["title"],
                "lessons": slim_lessons,
                "exam": slim_exam,
            }
        )

    payload = {
        "meta": {
            "course_id": CFG["course_id"],
            "course_title": CFG["course_title"],
            "short_title": CFG["short_title"],
            "subtitle": CFG["subtitle"],
            "flag_emoji": CFG["flag_emoji"],
            "source_lang": CFG["source_lang"],
            "target_lang": {
                "code": CFG["target_lang"]["code"],
                "name": CFG["target_lang"]["name"],
                "script_label": CFG["target_lang"]["script_label"],
                "phonetic_label": CFG["target_lang"]["phonetic_label"],
                "meaning_label": CFG["target_lang"]["meaning_label"],
                "google_translate_sl": CFG["target_lang"]["google_translate_sl"],
                "google_translate_tl": CFG["target_lang"]["google_translate_tl"],
            },
            "fonts": {
                "target_family": CFG["fonts"]["target_family"],
                "web_regular": CFG["fonts"].get("web_regular", ""),
                "web_bold": CFG["fonts"].get("web_bold", ""),
            },
            "pwa": CFG["pwa"],
            "practice_hint": CFG["export"].get("practice_hint", ""),
            "stats": stats,
        },
        "chapters": slim_chapters,
        "pocket_dict": pocket_dict,
    }

    SLIDE_DIR.mkdir(parents=True, exist_ok=True)
    json_str = json.dumps(payload, ensure_ascii=False, indent=2)
    (SLIDE_DIR / "curriculum_data.json").write_text(json_str, encoding="utf-8")
    (SLIDE_DIR / "curriculum_data.js").write_text(
        f"window.COURSE_CURRICULUM = {json_str};\nwindow.LAO_CURRICULUM = window.COURSE_CURRICULUM;\n",
        encoding="utf-8",
    )

    ensure_pwa_assets()
    write_notebooklm_gamma_exports(chapters)

    if FORBIDDEN_RE:
        hits = FORBIDDEN_RE.findall(json_str)
        bad_name = CFG["target_lang"].get("forbidden_script_name", "forbidden")
        assert not hits, f"Found unexpected {bad_name} characters: {hits[:10]}"

    empty_lessons = [
        les["id"]
        for ch in slim_chapters
        for les in ch["lessons"]
        if not les["vocab"] and not les["dialogue"]["lines"]
    ]
    assert not empty_lessons, f"Lessons without vocab or dialogue: {empty_lessons}"

    print("Build successful!")
    print("Stats:", json.dumps(stats, ensure_ascii=False))
    print("Pocket dict items:", len(pocket_dict))
    print("Exports in:", EXPORT_DIR)
    print("App data in:", SLIDE_DIR)


if __name__ == "__main__":
    main()
