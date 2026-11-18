#!/usr/bin/env python3
"""
Build a universal EPUB 3 ebook (with EPUB 2 NCX + embedded legal OFL fonts)
optimized for Amazon Kindle (Send to Kindle / E-ink) and iPhone (Apple Books).
Driven dynamically by `course.config.json`.
"""

from __future__ import annotations

import datetime as dt
import html
import re
import uuid
import zipfile
from pathlib import Path
from typing import Any

from course_config import compile_script_patterns, load_course_config

ROOT, CFG = load_course_config(Path(__file__))
PATTERNS = compile_script_patterns(CFG)

CURRICULUM_DIR = ROOT / "Giao-Trinh"
OUTPUT_EPUB = ROOT / CFG["epub"]["output"]
EBOOK_DIR = OUTPUT_EPUB.parent
COVER_PATH = ROOT / "tools" / "cover.png"

TARGET_CODE: str = CFG["target_lang"]["code"]
TARGET_NAME: str = CFG["target_lang"]["name"]
SCRIPT_LABEL_LOWER: str = CFG["target_lang"]["script_label"].lower()
SCRIPT_RUN_RE: re.Pattern[str] | None = PATTERNS["script_run_re"]

FONTS_CFG = CFG["fonts"]
FONT_REGULAR = (ROOT / FONTS_CFG["regular"]) if FONTS_CFG.get("regular") else None
FONT_BOLD = (ROOT / FONTS_CFG["bold"]) if FONTS_CFG.get("bold") else None
FONT_LICENSE = (ROOT / FONTS_CFG["license_file"]) if FONTS_CFG.get("license_file") else None
FONT_FAMILY = FONTS_CFG.get("target_family", "sans-serif")

CALLOUT_LABELS = {
    "tip": "Mẹo học nhanh",
    "info": "Thông tin",
    "warning": "Lưu ý quan trọng",
    "important": "Trọng tâm",
    "note": "Ghi chú",
    "quote": "Ghi nhớ",
}


def xml_escape(text: str) -> str:
    return html.escape(text, quote=False)


def attr_escape(text: str) -> str:
    return html.escape(text, quote=True)


def wrap_target_spans(escaped_html: str) -> str:
    """Wrap target non-Latin script runs inside <span class='target-script'> while ignoring tags."""
    if not SCRIPT_RUN_RE or PATTERNS["is_latin"]:
        return escaped_html
    parts = re.split(r"(<[^>]+>)", escaped_html)
    out: list[str] = []
    for p in parts:
        if p.startswith("<"):
            out.append(p)
        else:
            out.append(
                SCRIPT_RUN_RE.sub(
                    rf'<span class="target-script" xml:lang="{attr_escape(TARGET_CODE)}">\1</span>',
                    p,
                )
            )
    return "".join(out)


def format_inline(text: str, link_map: dict[str, str], current_dir: Path) -> str:
    """Convert inline Markdown (**bold**, *italic*, `code`, [link](target)) safely to XHTML."""
    placeholders: list[str] = []

    def stash(html_frag: str) -> str:
        idx = len(placeholders)
        placeholders.append(html_frag)
        return f"\x00PH{idx}\x00"

    def repl_link(m: re.Match[str]) -> str:
        label, target = m.group(1), m.group(2).strip()
        label_html = format_inline_simple(label)
        if target.startswith("http://") or target.startswith("https://"):
            return stash(f'<a href="{attr_escape(target)}">{label_html}</a>')
        tgt_no_anchor = target.split("#")[0]
        if tgt_no_anchor:
            resolved = (current_dir / tgt_no_anchor).resolve()
            key = resolved.relative_to(ROOT).as_posix() if resolved.is_relative_to(ROOT) else ""
            if key in link_map:
                return stash(f'<a href="{attr_escape(link_map[key])}">{label_html}</a>')
        return stash(f"<strong>{label_html}</strong>")

    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", repl_link, text)

    def repl_code(m: re.Match[str]) -> str:
        inner = wrap_target_spans(xml_escape(m.group(1)))
        return stash(f"<code>{inner}</code>")

    s = re.sub(r"`([^`]+)`", repl_code, s)

    s_html = format_inline_simple(s)
    for idx, frag in enumerate(placeholders):
        s_html = s_html.replace(f"\x00PH{idx}\x00", frag)
    return s_html


def format_inline_simple(text: str) -> str:
    s = xml_escape(text)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"\*([^*]+)\*", r"<em>\1</em>", s)
    s = wrap_target_spans(s)
    return s


def split_table_row(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def render_table_for_ereader(
    headers: list[str], rows: list[list[str]], link_map: dict[str, str], current_dir: Path
) -> str:
    """
    Render standard Vocab & Dialogue tables as stacked Kindle/iPhone Phrase Cards
    so small E-ink & phone screens never suffer cramped horizontal columns.
    """
    h_lower = [re.sub(r"[`*]", "", h).strip().lower() for h in headers]

    if h_lower and h_lower[0] == "vai" and len(headers) >= 4:
        blocks = ['<div class="dialogue-box">']
        for r in rows:
            role = format_inline(r[0], link_map, current_dir)
            tgt = format_inline(r[1], link_map, current_dir)
            ph = format_inline(r[2], link_map, current_dir)
            vi = format_inline(r[3], link_map, current_dir)
            blocks.append(
                f'<div class="dlg-turn">'
                f'<div class="dlg-head"><span class="speaker">{role}</span> '
                f'<span class="target-big">{tgt}</span></div>'
                f'<div class="phonetic">{ph}</div>'
                f'<div class="vi-sub">{vi}</div>'
                f"</div>"
            )
        blocks.append("</div>")
        return "\n".join(blocks)

    is_vocab_card = (
        len(headers) in (3, 4)
        and h_lower[0] in ("tiếng việt", "số", "số tiền", "giá trị / nghĩa")
        and any((SCRIPT_LABEL_LOWER in h) or ("chữ " in h) or ("tiếng " in h) for h in h_lower[1:])
    )
    if is_vocab_card:
        blocks = ['<div class="card-list">']
        for r in rows:
            vi = format_inline(r[0], link_map, current_dir) if len(r) > 0 else ""
            tgt = format_inline(r[1], link_map, current_dir) if len(r) > 1 else ""
            ph = format_inline(r[2], link_map, current_dir) if len(r) > 2 else ""
            note = format_inline(r[3], link_map, current_dir) if len(r) > 3 and r[3] else ""
            note_html = f'<div class="card-note">{note}</div>' if note else ""
            blocks.append(
                f'<div class="phrase-card">'
                f'<div class="card-vi">{vi}</div>'
                f'<div class="card-target">{tgt}</div>'
                f'<div class="phonetic">{ph}</div>'
                f"{note_html}"
                f"</div>"
            )
        blocks.append("</div>")
        return "\n".join(blocks)

    ths = "".join(f"<th>{format_inline(h, link_map, current_dir)}</th>" for h in headers)
    trs: list[str] = []
    for r in rows:
        tds = "".join(f"<td>{format_inline(c, link_map, current_dir)}</td>" for c in r)
        trs.append(f"<tr>{tds}</tr>")
    return f'<table class="ref-table"><thead><tr>{ths}</tr></thead><tbody>{"".join(trs)}</tbody></table>'


def markdown_to_xhtml_body(
    raw_md: str, source_path: Path, link_map: dict[str, str], is_exam: bool = False
) -> str:
    lines = raw_md.splitlines()
    current_dir = source_path.parent
    out: list[str] = []
    i = 0
    in_ul = False
    in_ol = False

    def close_lists() -> None:
        nonlocal in_ul, in_ol
        if in_ul:
            out.append("</ul>")
            in_ul = False
        if in_ol:
            out.append("</ol>")
            in_ol = False

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("> Quay lại:") or stripped.startswith("> Hoàn thành toàn bộ"):
            i += 1
            continue

        if not stripped:
            close_lists()
            i += 1
            continue

        if stripped == "---":
            close_lists()
            out.append("<hr />")
            i += 1
            continue

        m_h = re.match(r"^(#{1,4})\s+(.+)$", stripped)
        if m_h:
            close_lists()
            level = len(m_h.group(1))
            htext = m_h.group(2).strip()
            if is_exam and level == 1 and "Đáp Án" in htext:
                out.append('<div class="page-break" id="dap-an"></div>')
            out.append(f"<h{level}>{format_inline(htext, link_map, current_dir)}</h{level}>")
            i += 1
            continue

        if stripped.startswith(">"):
            close_lists()
            quote_lines: list[str] = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                q = re.sub(r"^>\s?", "", lines[i].strip())
                if not q.startswith("Quay lại:"):
                    quote_lines.append(q)
                i += 1
            if quote_lines:
                first = quote_lines[0]
                m_call = re.match(r"^\[!(\w+)\]\s*(.*)$", first)
                if m_call:
                    kind = m_call.group(1).lower()
                    title = m_call.group(2).strip() or CALLOUT_LABELS.get(kind, "Ghi chú")
                    body_lines = quote_lines[1:]
                    body_html = render_blockquote_body(body_lines, link_map, current_dir)
                    out.append(
                        f'<div class="callout">'
                        f'<div class="callout-title">{format_inline(title, link_map, current_dir)}</div>'
                        f"{body_html}</div>"
                    )
                else:
                    body_html = render_blockquote_body(quote_lines, link_map, current_dir)
                    out.append(f"<blockquote>{body_html}</blockquote>")
            continue

        if stripped.startswith("```"):
            close_lists()
            i += 1
            code_lines: list[str] = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code_lines.append(xml_escape(lines[i]))
                i += 1
            i += 1
            out.append(f'<pre class="prompt-box">{chr(10).join(code_lines)}</pre>')
            continue

        if (
            stripped.startswith("|")
            and i + 1 < len(lines)
            and re.match(r"^\|\s*[:\-| ]+\|\s*$", lines[i + 1].strip())
        ):
            close_lists()
            headers = split_table_row(line)
            rows: list[list[str]] = []
            j = i + 2
            while j < len(lines) and lines[j].strip().startswith("|"):
                cells = split_table_row(lines[j])
                while len(cells) < len(headers):
                    cells.append("")
                rows.append(cells[: len(headers)])
                j += 1
            out.append(render_table_for_ereader(headers, rows, link_map, current_dir))
            i = j
            continue

        m_chk = re.match(r"^-\s+\[( |x|X)\]\s+(.+)$", stripped)
        if m_chk:
            if in_ol:
                out.append("</ol>")
                in_ol = False
            if not in_ul:
                out.append('<ul class="checklist">')
                in_ul = True
            mark = "&#9745;" if m_chk.group(1).lower() == "x" else "&#9744;"
            out.append(f"<li>{mark} {format_inline(m_chk.group(2), link_map, current_dir)}</li>")
            i += 1
            continue

        m_ul = re.match(r"^(\s*)[-*]\s+(.+)$", line)
        if m_ul:
            if in_ol:
                out.append("</ol>")
                in_ol = False
            if not in_ul:
                out.append("<ul>")
                in_ul = True
            indent_cls = ' class="sub-item"' if len(m_ul.group(1)) >= 2 else ""
            out.append(f"<li{indent_cls}>{format_inline(m_ul.group(2), link_map, current_dir)}</li>")
            i += 1
            continue

        m_ol = re.match(r"^\d+\.\s+(.+)$", stripped)
        if m_ol:
            if in_ul:
                out.append("</ul>")
                in_ul = False
            if not in_ol:
                out.append("<ol>")
                in_ol = True
            item_html = format_inline(m_ol.group(1), link_map, current_dir)
            sub_opts: list[str] = []
            j = i + 1
            while j < len(lines) and re.match(r"^\s{2,}-\s+(.+)$", lines[j]):
                opt_txt = re.match(r"^\s{2,}-\s+(.+)$", lines[j]).group(1)
                sub_opts.append(f"<li>{format_inline(opt_txt, link_map, current_dir)}</li>")
                j += 1
            if sub_opts:
                item_html += f'<ul class="sub-opts">{"".join(sub_opts)}</ul>'
                i = j
            else:
                i += 1
            out.append(f"<li>{item_html}</li>")
            continue

        close_lists()
        para_lines = [stripped]
        j = i + 1
        while (
            j < len(lines)
            and lines[j].strip()
            and not lines[j].strip().startswith(("#", ">", "|", "-", "```"))
            and not re.match(r"^\d+\.\s+", lines[j].strip())
        ):
            para_lines.append(lines[j].strip())
            j += 1
        out.append(f"<p>{format_inline(' '.join(para_lines), link_map, current_dir)}</p>")
        i = j

    close_lists()
    return "\n".join(out)


def render_blockquote_body(lines: list[str], link_map: dict[str, str], current_dir: Path) -> str:
    items: list[str] = []
    paras: list[str] = []
    for l in lines:
        s = l.strip()
        if not s:
            continue
        m_li = re.match(r"^(?:-|\d+\.)\s+(.+)$", s)
        if m_li:
            items.append(f"<li>{format_inline(m_li.group(1), link_map, current_dir)}</li>")
        else:
            if items:
                paras.append(f"<ul>{''.join(items)}</ul>")
                items = []
            paras.append(f"<p>{format_inline(s, link_map, current_dir)}</p>")
    if items:
        paras.append(f"<ul>{''.join(items)}</ul>")
    return "".join(paras)


def wrap_xhtml(title: str, body_html: str) -> str:
    src_lang = CFG["source_lang"]["code"]
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<!DOCTYPE html>\n'
        f'<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{attr_escape(src_lang)}" lang="{attr_escape(src_lang)}">\n'
        "<head>\n"
        '  <meta charset="utf-8" />\n'
        f"  <title>{xml_escape(title)}</title>\n"
        '  <link rel="stylesheet" type="text/css" href="styles.css" />\n'
        "</head>\n"
        "<body>\n"
        f"{body_html}\n"
        "</body>\n"
        "</html>\n"
    )


def build_styles_css(has_regular: bool, has_bold: bool, regular_name: str, bold_name: str) -> str:
    font_faces: list[str] = []
    if has_regular:
        font_faces.append(
            f'@font-face {{\n'
            f'  font-family: "TargetScript";\n'
            f'  font-style: normal;\n'
            f'  font-weight: normal;\n'
            f'  src: url("fonts/{regular_name}") format("truetype");\n'
            f'}}'
        )
    if has_bold:
        font_faces.append(
            f'@font-face {{\n'
            f'  font-family: "TargetScript";\n'
            f'  font-style: normal;\n'
            f'  font-weight: bold;\n'
            f'  src: url("fonts/{bold_name}") format("truetype");\n'
            f'}}'
        )
    font_face_block = "\n\n".join(font_faces)
    target_stack = f'"TargetScript", "{FONT_FAMILY}", sans-serif'

    return f"""{font_face_block}

body {{
  font-family: -apple-system, Georgia, serif;
  line-height: 1.6;
  margin: 0.6em;
  color: #1c1f1d;
}}

h1 {{
  font-size: 1.45em;
  line-height: 1.25;
  border-bottom: 2px solid #146c53;
  padding-bottom: 0.25em;
  margin-top: 0.4em;
  margin-bottom: 0.6em;
}}

h2 {{
  font-size: 1.18em;
  color: #146c53;
  margin-top: 1.2em;
  margin-bottom: 0.4em;
}}

h3 {{
  font-size: 1.05em;
  margin-top: 1em;
  margin-bottom: 0.35em;
}}

p {{
  margin: 0.45em 0;
}}

ul, ol {{
  margin: 0.45em 0;
  padding-left: 1.35em;
}}

li {{
  margin-bottom: 0.3em;
}}

ul.checklist {{
  list-style: none;
  padding-left: 0.4em;
}}

ul.sub-opts {{
  list-style: none;
  padding-left: 1em;
  margin-top: 0.25em;
}}

li.sub-item {{
  margin-left: 1em;
}}

hr {{
  border: none;
  border-top: 1px solid #c9c3b8;
  margin: 1em 0;
}}

code {{
  font-size: 0.94em;
  background-color: #f2efe9;
  padding: 0.08em 0.3em;
  border-radius: 3px;
}}

pre.prompt-box {{
  white-space: pre-wrap;
  word-wrap: break-word;
  font-size: 0.88em;
  background-color: #f4f2ec;
  border-left: 3px solid #146c53;
  padding: 0.6em 0.8em;
  margin: 0.6em 0;
}}

.target-script, .lao {{
  font-family: {target_stack};
  line-height: 1.5;
}}

.callout, blockquote {{
  background-color: #f4f3ee;
  border-left: 4px solid #146c53;
  padding: 0.55em 0.8em;
  margin: 0.7em 0;
}}

.callout-title {{
  font-weight: bold;
  margin-bottom: 0.25em;
}}

.card-list, .dialogue-box {{
  margin: 0.6em 0;
}}

.phrase-card, .dlg-turn {{
  border: 1px solid #d5cfc2;
  border-left: 4px solid #146c53;
  border-radius: 6px;
  padding: 0.48em 0.7em;
  margin-bottom: 0.5em;
  page-break-inside: avoid;
  break-inside: avoid;
}}

.dlg-turn {{
  border-left-color: #b45309;
}}

.card-vi {{
  font-weight: bold;
  font-size: 0.98em;
}}

.card-target, .target-big, .card-lao, .lao-big {{
  font-family: {target_stack};
  font-size: 1.32em;
  font-weight: bold;
  margin: 0.12em 0;
}}

.phonetic {{
  font-style: italic;
  font-weight: bold;
  color: #9a4715;
  font-size: 0.96em;
}}

.card-note, .vi-sub {{
  font-size: 0.88em;
  color: #4b524d;
  margin-top: 0.15em;
}}

.speaker {{
  display: inline-block;
  font-weight: bold;
  font-size: 0.85em;
  padding: 0.08em 0.45em;
  border-radius: 4px;
  background-color: #ebe6db;
  margin-right: 0.4em;
}}

table.ref-table {{
  width: 100%;
  border-collapse: collapse;
  margin: 0.65em 0;
  font-size: 0.86em;
}}

table.ref-table th, table.ref-table td {{
  border: 1px solid #c9c3b8;
  padding: 0.35em 0.42em;
  text-align: left;
  vertical-align: top;
}}

table.ref-table th {{
  background-color: #ece8de;
  font-weight: bold;
}}

.page-break {{
  page-break-before: always;
  break-before: page;
}}

.chapter-banner {{
  text-align: center;
  padding: 2em 0.5em;
}}

.chapter-banner .chap-num {{
  font-size: 0.95em;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #146c53;
  font-weight: bold;
}}

.chapter-banner h1 {{
  border: none;
  font-size: 1.65em;
  margin: 0.4em 0;
}}
"""


def collect_book_entries() -> tuple[list[dict[str, Any]], dict[str, str]]:
    """Build ordered chapters/pages list and relative-path link lookup map."""
    pages: list[dict[str, Any]] = []
    link_map: dict[str, str] = {}
    intro_titles = CFG["epub"].get("intro_titles", {})

    intro_files = [
        ("intro_00.xhtml", intro_titles.get("00", "Tổng Quan & Lộ Trình Học"), ROOT / "00-Tong-Quan-Va-Lo-Trinh.md"),
        ("intro_02.xhtml", intro_titles.get("02", "Phương Pháp Học & Tài Nguyên"), ROOT / "02-Phuong-Phap-Va-Tai-Nguyen.md"),
        ("intro_01.xhtml", intro_titles.get("01", "Bảng Theo Dõi Tiến Trình"), ROOT / "01-Theo-Doi-Tien-Trinh.md"),
    ]
    for href, title, path in intro_files:
        if not path.exists():
            continue
        rel = path.relative_to(ROOT).as_posix()
        link_map[rel] = href
        pages.append(
            {
                "id": href.replace(".xhtml", ""),
                "href": href,
                "title": title,
                "path": path,
                "is_exam": False,
                "group": "Phần Mở Đầu",
            }
        )

    chap_titles = CFG.get("chapters", {})
    chap_dirs = sorted(
        d for d in CURRICULUM_DIR.iterdir() if d.is_dir() and d.name.startswith("Chuong-")
    )
    for c_idx, c_dir in enumerate(chap_dirs, 1):
        lessons = sorted(c_dir.glob("Bai-*.md"))
        tests = sorted(c_dir.glob("Kiem-Tra-*.md"))
        raw_slug = re.sub(r"^Chuong-\d{2}-", "", c_dir.name).replace("-", " ")
        chap_name = chap_titles.get(str(c_idx), raw_slug)
        chap_label = f"Chương {c_idx}: {chap_name}"

        chap_href = f"ch{c_idx:02d}_cover.xhtml"
        pages.append(
            {
                "id": f"ch{c_idx:02d}_cover",
                "href": chap_href,
                "title": chap_label,
                "path": None,
                "chap_num": c_idx,
                "chap_title": chap_name,
                "lessons": lessons,
                "has_exam": bool(tests),
                "is_exam": False,
                "group": chap_label,
                "is_chapter_divider": True,
            }
        )

        for l_idx, lf in enumerate(lessons, 1):
            href = f"ch{c_idx:02d}_b{l_idx:02d}.xhtml"
            rel = lf.relative_to(ROOT).as_posix()
            link_map[rel] = href
            first_line = lf.read_text(encoding="utf-8").splitlines()[0].lstrip("# ").strip()
            pages.append(
                {
                    "id": f"ch{c_idx:02d}_b{l_idx:02d}",
                    "href": href,
                    "title": first_line,
                    "path": lf,
                    "is_exam": False,
                    "group": chap_label,
                }
            )

        for tf in tests:
            href = f"ch{c_idx:02d}_test.xhtml"
            rel = tf.relative_to(ROOT).as_posix()
            link_map[rel] = href
            first_line = tf.read_text(encoding="utf-8").splitlines()[0].lstrip("# ").strip()
            pages.append(
                {
                    "id": f"ch{c_idx:02d}_test",
                    "href": href,
                    "title": first_line,
                    "path": tf,
                    "is_exam": True,
                    "group": chap_label,
                    "answer_sub_title": f"Đáp Án & Thang Điểm Chương {c_idx}",
                }
            )

    dict_path = ROOT / "03-Tu-Dien-Bo-Tui-So-Tay.md"
    if dict_path.exists():
        dict_href = "appendix_dict.xhtml"
        link_map[dict_path.relative_to(ROOT).as_posix()] = dict_href
        pages.append(
            {
                "id": "appendix_dict",
                "href": dict_href,
                "title": CFG["epub"].get("appendix_title", "Phụ Lục: Từ Điển Bỏ Túi Sinh Tồn"),
                "path": dict_path,
                "is_exam": False,
                "group": "Phụ Lục Tra Cứu Nhanh",
            }
        )

    return pages, link_map


def build_cover_xhtml(has_cover: bool) -> str:
    title = CFG["epub"].get("title", CFG["course_title"])
    if has_cover:
        body = (
            '<div style="text-align:center;margin:0;padding:0;">'
            f'<img src="cover.png" alt="{attr_escape(title)}" '
            'style="max-width:100%;max-height:98vh;height:auto;" />'
            "</div>"
        )
    else:
        body = (
            '<div class="chapter-banner">'
            f'<div class="chap-num">{xml_escape(CFG.get("subtitle", ""))}</div>'
            f'<h1>{xml_escape(title)}</h1>'
            f'<p>{xml_escape(CFG["epub"].get("creator", ""))}</p>'
            "</div>"
        )
    return wrap_xhtml("Bìa Sách", body)


def build_chapter_divider_xhtml(page: dict[str, Any], link_map: dict[str, str]) -> str:
    items_html = []
    for lf in page["lessons"]:
        rel = lf.relative_to(ROOT).as_posix()
        href = link_map[rel]
        first = lf.read_text(encoding="utf-8").splitlines()[0].lstrip("# ").strip()
        items_html.append(f'<li><a href="{attr_escape(href)}">{xml_escape(first)}</a></li>')
    if page.get("has_exam"):
        items_html.append(
            f'<li><a href="ch{page["chap_num"]:02d}_test.xhtml">Kiểm Tra Cuối Chương {page["chap_num"]}</a></li>'
        )
    body = (
        f'<div class="chapter-banner">'
        f'<div class="chap-num">Chương {page["chap_num"]}</div>'
        f'<h1>{xml_escape(page["chap_title"])}</h1>'
        f"</div>"
        f"<h2>Nội dung trong chương</h2>"
        f"<ol>{''.join(items_html)}</ol>"
    )
    return wrap_xhtml(page["title"], body)


def build_nav_xhtml(pages: list[dict[str, Any]]) -> str:
    nav_items: list[str] = ['      <li><a href="cover.xhtml">Bìa Sách</a></li>']
    cur_group = None
    sub_items: list[tuple[str, str]] = []

    def flush_group() -> None:
        nonlocal cur_group, sub_items
        if cur_group and sub_items:
            first_href = sub_items[0][0]
            children = "\n".join(f'          <li><a href="{attr_escape(h)}">{xml_escape(t)}</a></li>' for h, t in sub_items)
            nav_items.append(
                f'      <li>\n        <a href="{attr_escape(first_href)}">{xml_escape(cur_group)}</a>\n'
                f'        <ol>\n{children}\n        </ol>\n      </li>'
            )
        sub_items = []

    for p in pages:
        grp = p["group"]
        if grp != cur_group:
            flush_group()
            cur_group = grp
        if p.get("is_chapter_divider"):
            sub_items.append((p["href"], f"Tổng quan {p['title'].split(':')[0]}"))
        else:
            sub_items.append((p["href"], p["title"]))
            if p.get("is_exam") and p.get("answer_sub_title"):
                sub_items.append((f"{p['href']}#dap-an", p["answer_sub_title"]))
    flush_group()

    body = (
        '<nav epub:type="toc" id="toc">\n'
        "  <h1>Mục Lục</h1>\n"
        "  <ol>\n"
        + "\n".join(nav_items)
        + "\n  </ol>\n"
        "</nav>"
    )
    return wrap_xhtml("Mục Lục", body)


def build_toc_ncx(pages: list[dict[str, Any]], book_id: str) -> str:
    nav_points: list[str] = []
    play_order = 1

    nav_points.append(
        f'    <navPoint id="np-cover" playOrder="{play_order}">\n'
        f'      <navLabel><text>Bìa Sách</text></navLabel>\n'
        f'      <content src="cover.xhtml"/>\n'
        f"    </navPoint>"
    )
    play_order += 1

    for p in pages:
        np_id = f"np-{p['id']}"
        nav_points.append(
            f'    <navPoint id="{attr_escape(np_id)}" playOrder="{play_order}">\n'
            f'      <navLabel><text>{xml_escape(p["title"])}</text></navLabel>\n'
            f'      <content src="{attr_escape(p["href"])}"/>\n'
            f"    </navPoint>"
        )
        play_order += 1
        if p.get("is_exam") and p.get("answer_sub_title"):
            nav_points.append(
                f'    <navPoint id="{attr_escape(np_id)}-ans" playOrder="{play_order}">\n'
                f'      <navLabel><text>{xml_escape(p["answer_sub_title"])}</text></navLabel>\n'
                f'      <content src="{attr_escape(p["href"])}#dap-an"/>\n'
                f"    </navPoint>"
            )
            play_order += 1

    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
        "  <head>\n"
        f'    <meta name="dtb:uid" content="{attr_escape(book_id)}"/>\n'
        '    <meta name="dtb:depth" content="2"/>\n'
        '    <meta name="dtb:totalPageCount" content="0"/>\n'
        '    <meta name="dtb:maxPageNumber" content="0"/>\n'
        "  </head>\n"
        f"  <docTitle><text>{xml_escape(CFG['course_title'])}</text></docTitle>\n"
        "  <navMap>\n"
        + "\n".join(nav_points)
        + "\n  </navMap>\n"
        "</ncx>\n"
    )


def build_content_opf(
    pages: list[dict[str, Any]],
    book_id: str,
    has_cover: bool,
    font_items: list[tuple[str, str, str]],
    has_license: bool,
) -> str:
    now_iso = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    epub_cfg = CFG["epub"]
    manifest = [
        '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
        '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '    <item id="css" href="styles.css" media-type="text/css"/>',
        '    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>',
    ]
    if has_cover:
        manifest.append('    <item id="cover-img" href="cover.png" media-type="image/png" properties="cover-image"/>')
    for fid, href, mtype in font_items:
        manifest.append(f'    <item id="{attr_escape(fid)}" href="{attr_escape(href)}" media-type="{attr_escape(mtype)}"/>')
    if has_license:
        manifest.append('    <item id="font-license" href="fonts/OFL.txt" media-type="text/plain"/>')

    spine = ['    <itemref idref="cover"/>', '    <itemref idref="nav"/>']

    for p in pages:
        manifest.append(
            f'    <item id="{attr_escape(p["id"])}" href="{attr_escape(p["href"])}" media-type="application/xhtml+xml"/>'
        )
        spine.append(f'    <itemref idref="{attr_escape(p["id"])}"/>')

    cover_meta = '    <meta name="cover" content="cover-img"/>\n' if has_cover else ""
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n'
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        f'    <dc:identifier id="bookid">{attr_escape(book_id)}</dc:identifier>\n'
        f'    <dc:title>{xml_escape(epub_cfg.get("title", CFG["course_title"]))}</dc:title>\n'
        f'    <dc:creator>{xml_escape(epub_cfg.get("creator", CFG["course_title"]))}</dc:creator>\n'
        f'    <dc:language>{xml_escape(CFG["source_lang"]["code"])}</dc:language>\n'
        f'    <dc:description>{xml_escape(epub_cfg.get("description", ""))}</dc:description>\n'
        f'    <meta property="dcterms:modified">{now_iso}</meta>\n'
        f"{cover_meta}"
        "  </metadata>\n"
        "  <manifest>\n"
        + "\n".join(manifest)
        + "\n  </manifest>\n"
        '  <spine toc="ncx">\n'
        + "\n".join(spine)
        + "\n  </spine>\n"
        "  <guide>\n"
        '    <reference type="cover" title="Bìa Sách" href="cover.xhtml"/>\n'
        '    <reference type="toc" title="Mục Lục" href="nav.xhtml"/>\n'
        "  </guide>\n"
        "</package>\n"
    )


def main() -> None:
    EBOOK_DIR.mkdir(parents=True, exist_ok=True)
    pages, link_map = collect_book_entries()
    seed = CFG["epub"].get("uuid_seed", CFG["course_id"])
    book_id = f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_DNS, seed)}"
    has_cover = COVER_PATH.exists()

    has_regular = bool(FONT_REGULAR and FONT_REGULAR.exists())
    has_bold = bool(FONT_BOLD and FONT_BOLD.exists())
    has_license = bool(FONT_LICENSE and FONT_LICENSE.exists())

    reg_name = FONT_REGULAR.name if has_regular else ""
    bold_name = FONT_BOLD.name if has_bold else ""
    styles_css = build_styles_css(has_regular, has_bold, reg_name, bold_name)

    font_items: list[tuple[str, str, str]] = []
    if has_regular:
        font_items.append(("font-target-regular", f"fonts/{reg_name}", "font/ttf"))
    if has_bold:
        font_items.append(("font-target-bold", f"fonts/{bold_name}", "font/ttf"))

    xhtml_files: dict[str, str] = {
        "cover.xhtml": build_cover_xhtml(has_cover),
        "nav.xhtml": build_nav_xhtml(pages),
    }

    for p in pages:
        if p.get("is_chapter_divider"):
            xhtml_files[p["href"]] = build_chapter_divider_xhtml(p, link_map)
        else:
            raw_md = p["path"].read_text(encoding="utf-8")
            body = markdown_to_xhtml_body(raw_md, p["path"], link_map, is_exam=bool(p.get("is_exam")))
            xhtml_files[p["href"]] = wrap_xhtml(p["title"], body)

    container_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        "  <rootfiles>\n"
        '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
        "  </rootfiles>\n"
        "</container>\n"
    )

    with zipfile.ZipFile(OUTPUT_EPUB, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr("META-INF/container.xml", container_xml.encode("utf-8"), compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr(
            "OEBPS/content.opf",
            build_content_opf(pages, book_id, has_cover, font_items, has_license).encode("utf-8"),
            compress_type=zipfile.ZIP_DEFLATED,
        )
        zf.writestr("OEBPS/toc.ncx", build_toc_ncx(pages, book_id).encode("utf-8"), compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("OEBPS/styles.css", styles_css.encode("utf-8"), compress_type=zipfile.ZIP_DEFLATED)
        if has_cover:
            zf.write(COVER_PATH, "OEBPS/cover.png", compress_type=zipfile.ZIP_DEFLATED)
        if has_regular:
            zf.write(FONT_REGULAR, f"OEBPS/fonts/{reg_name}", compress_type=zipfile.ZIP_DEFLATED)
        if has_bold:
            zf.write(FONT_BOLD, f"OEBPS/fonts/{bold_name}", compress_type=zipfile.ZIP_DEFLATED)
        if has_license:
            zf.write(FONT_LICENSE, "OEBPS/fonts/OFL.txt", compress_type=zipfile.ZIP_DEFLATED)
        for name, content in xhtml_files.items():
            zf.writestr(f"OEBPS/{name}", content.encode("utf-8"), compress_type=zipfile.ZIP_DEFLATED)

    print(f"EPUB built: {OUTPUT_EPUB} ({OUTPUT_EPUB.stat().st_size // 1024} KB)")
    print(f"Total XHTML documents: {len(xhtml_files)} | Fonts embedded: regular={has_regular}, bold={has_bold}, ofl={has_license}")


if __name__ == "__main__":
    main()
