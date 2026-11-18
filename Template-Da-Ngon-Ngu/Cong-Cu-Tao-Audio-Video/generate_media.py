#!/usr/bin/env python3
"""
Automated Target-Language Audio (.mp3 / .m4a) & Flashcard Video (.mp4) Generator.
Driven dynamically by `course.config.json`:
- Target voices via Microsoft Edge Neural TTS (`tts.female_voice` / `tts.male_voice`)
  with strict timeouts, atomic writes, and live % progress.
- Vietnamese prompt voices via offline macOS `say -v Linh` + `afconvert` when available,
  falling back to Edge TTS `tts.vi_voice`.
- Native macOS `render_video` binary (Swift AVFoundation + CoreText OFL font registration)
  for Pimsleur `.m4a` & 720p/1080p `.mp4` (supports `--portrait` 9:16 for Shorts/TikTok).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

TOOLS_DIR = Path(__file__).resolve().parent
ROOT = TOOLS_DIR.parent
sys.path.insert(0, str(ROOT / "tools"))

from course_config import load_course_config  # noqa: E402

ROOT, CFG = load_course_config(ROOT)
DATA_FILE = ROOT / "Slide-Tuong-Tac" / "curriculum_data.json"
RENDER_SWIFT = TOOLS_DIR / "render_video.swift"
RENDER_BIN = TOOLS_DIR / "render_video"

CARDS_AUDIO_DIR = ROOT / "Media-Audio" / "cards"
PROMPTS_AUDIO_DIR = ROOT / "Media-Audio" / "prompts_vi"
LESSONS_AUDIO_DIR = ROOT / "Media-Audio" / "lessons"
VIDEO_DIR = ROOT / "Media-Video"
TEMP_DIR = TOOLS_DIR / ".tmp_storyboards"

TTS_CFG = CFG["tts"]
VOICE_TARGET_FEMALE = TTS_CFG["female_voice"]
VOICE_TARGET_MALE = TTS_CFG["male_voice"]
VOICE_VI_FEMALE = TTS_CFG.get("vi_voice", "vi-VN-HoaiMyNeural")


def check_edge_tts() -> Any:
    try:
        import edge_tts  # type: ignore
        return edge_tts
    except ImportError:
        print(
            "Chưa cài thư viện `edge-tts`.\n"
            "Hãy chạy lệnh sau để cài đặt tự động vào môi trường riêng:\n"
            f"  bash \"{TOOLS_DIR / 'setup_and_generate.sh'}\" 1\n",
            file=sys.stderr,
        )
        sys.exit(1)


def ensure_render_binary() -> None:
    needs_build = (
        not RENDER_BIN.exists()
        or (RENDER_SWIFT.exists() and RENDER_SWIFT.stat().st_mtime > RENDER_BIN.stat().st_mtime)
    )
    if needs_build:
        if shutil.which("swiftc") is None:
            raise FileNotFoundError(
                f"Không tìm thấy binary {RENDER_BIN} và thiếu `swiftc` để biên dịch {RENDER_SWIFT}."
            )
        print("Đang biên dịch trình dựng video Swift (`render_video`)...", flush=True)
        subprocess.run(
            [
                "swiftc",
                "-O",
                "-module-cache-path",
                "/tmp/swift_modcache",
                str(RENDER_SWIFT),
                "-o",
                str(RENDER_BIN),
            ],
            check=True,
        )


def has_macos_say_linh() -> bool:
    if shutil.which("say") is None or shutil.which("afconvert") is None:
        return False
    try:
        res = subprocess.run(["say", "-v", "?"], capture_output=True, text=True, check=True)
        return any(
            line.startswith("Linh ") or "\tvi_VN" in line or " vi_VN " in line
            for line in res.stdout.splitlines()
        )
    except Exception:
        return False


def get_audio_duration(path: Path) -> float:
    """Measure audio duration cleanly using macOS native `afinfo`."""
    try:
        res = subprocess.run(
            ["afinfo", str(path)],
            capture_output=True,
            text=True,
            check=True,
        )
        for line in res.stdout.splitlines():
            if "estimated duration:" in line:
                val = line.split("estimated duration:")[1].strip().split()[0]
                return float(val)
    except Exception:
        pass
    return 2.2


def synth_vi_offline_say(text: str, out_m4a: Path) -> bool:
    """Synthesize Vietnamese prompt locally via macOS `say -v Linh` + `afconvert`."""
    safe_text = re.sub(r"\s+", " ", text.strip().lstrip("- ")).strip()
    if not safe_text:
        return True
    if out_m4a.exists() and out_m4a.stat().st_size > 200:
        return True
    out_m4a.parent.mkdir(parents=True, exist_ok=True)
    tmp_aiff = out_m4a.with_suffix(".tmp.aiff")
    tmp_m4a = out_m4a.with_suffix(".tmp.m4a")
    try:
        subprocess.run(
            ["say", "-v", "Linh", "-r", "185", "-o", str(tmp_aiff), safe_text],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["afconvert", "-f", "m4af", "-d", "aac", str(tmp_aiff), str(tmp_m4a)],
            check=True,
            capture_output=True,
        )
        if tmp_m4a.exists() and tmp_m4a.stat().st_size > 200:
            tmp_m4a.replace(out_m4a)
            return True
        raise RuntimeError(f"Output empty for {out_m4a.name}")
    finally:
        tmp_aiff.unlink(missing_ok=True)
        tmp_m4a.unlink(missing_ok=True)


async def synth_one_edge(
    edge_tts: Any,
    sem: asyncio.Semaphore,
    text: str,
    voice: str,
    rate: str,
    out_path: Path,
    counter: dict[str, int],
    label: str,
    overwrite: bool = False,
) -> bool:
    if not text.strip():
        counter["done"] += 1
        return False

    if out_path.exists() and out_path.stat().st_size <= 200:
        out_path.unlink(missing_ok=True)

    if out_path.exists() and out_path.stat().st_size > 200 and not overwrite:
        counter["done"] += 1
        return True

    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(".tmp.mp3")

    success = False
    last_exc: Exception | None = None
    async with sem:
        for attempt in range(4):
            try:
                tmp_path.unlink(missing_ok=True)
                comm = edge_tts.Communicate(text=text, voice=voice, rate=rate)
                await asyncio.wait_for(comm.save(str(tmp_path)), timeout=18.0)
                if tmp_path.exists() and tmp_path.stat().st_size > 200:
                    tmp_path.replace(out_path)
                    success = True
                    break
                raise RuntimeError("Empty audio file received")
            except Exception as exc:
                last_exc = exc
                tmp_path.unlink(missing_ok=True)
                err_s = str(exc)
                if "nodename nor servname" in err_s or "ClientConnectorDNSError" in type(exc).__name__:
                    raise RuntimeError(f"Mất kết nối mạng / bị sandbox chặn DNS ({out_path.name}): {exc}") from exc
                if attempt < 3:
                    await asyncio.sleep(1.5 * (attempt + 1))
        await asyncio.sleep(0.25)

    if not success:
        raise RuntimeError(f"TTS lỗi cho {out_path.name} ({text!r}): {last_exc}")

    counter["done"] += 1
    done, total = counter["done"], counter["total"]
    if done % 5 == 0 or done == total:
        pct = int(done * 100 / max(1, total))
        print(f"  [{label}] {done}/{total} ({pct}%)", flush=True)
    return True


def _item_tts(item: dict[str, Any]) -> str:
    return item.get("tts_target") or item.get("tts_lao") or ""


def _item_target(item: dict[str, Any]) -> str:
    return item.get("target") or item.get("lao") or ""


def collect_jobs_for_chapters(
    data: dict[str, Any], target_chapters: list[int]
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    target_jobs: list[dict[str, str]] = []
    vi_jobs: list[dict[str, str]] = []

    for ch in data["chapters"]:
        if ch["number"] not in target_chapters:
            continue
        for les in ch["lessons"]:
            for v in les["vocab"]:
                tts = _item_tts(v)
                if tts:
                    target_jobs.append(
                        {
                            "id": v["audio_id"],
                            "text": tts,
                            "voice": VOICE_TARGET_FEMALE,
                            "vi_text": v["vietnamese"],
                        }
                    )
            for s in les["sentences"]:
                tts = _item_tts(s)
                if tts:
                    target_jobs.append(
                        {
                            "id": s["audio_id"],
                            "text": tts,
                            "voice": VOICE_TARGET_FEMALE,
                            "vi_text": s["vietnamese"],
                        }
                    )
            for d in les["dialogue"]["lines"]:
                tts = _item_tts(d)
                if tts:
                    voice = VOICE_TARGET_MALE if d.get("gender") == "male" else VOICE_TARGET_FEMALE
                    target_jobs.append(
                        {
                            "id": d["audio_id"],
                            "text": tts,
                            "voice": voice,
                            "vi_text": "",
                        }
                    )
        ex = ch.get("exam")
        if ex:
            for it in ex["part_a"]["items"]:
                tts = _item_tts(it)
                if tts:
                    target_jobs.append(
                        {"id": it["audio_id"], "text": tts, "voice": VOICE_TARGET_FEMALE, "vi_text": ""}
                    )
            for it in ex["part_b"]["items"]:
                tts = _item_tts(it)
                if tts:
                    target_jobs.append(
                        {"id": it["audio_id"], "text": tts, "voice": VOICE_TARGET_FEMALE, "vi_text": ""}
                    )

    for job in target_jobs:
        vi_clean = job["vi_text"].split("(")[0].strip()
        if vi_clean:
            vi_jobs.append({"id": job["id"], "text": vi_clean, "voice": VOICE_VI_FEMALE})

    return target_jobs, vi_jobs


def resolve_prompt_path(audio_id: str) -> Path | None:
    for ext in ("_vi.m4a", "_vi.mp3"):
        p = PROMPTS_AUDIO_DIR / f"{audio_id}{ext}"
        if p.exists() and p.stat().st_size > 200:
            return p
    return None


async def run_tts_batch(
    edge_tts: Any,
    target_jobs: list[dict[str, str]],
    vi_jobs: list[dict[str, str]],
    rate: str,
    generate_vi_prompts: bool,
    concurrency: int = 2,
) -> None:
    sem = asyncio.Semaphore(concurrency)
    target_name = CFG["target_lang"]["name"]

    print(f"[1/3] Đang xử lý {len(target_jobs)} file audio {target_name} (Edge Neural TTS)...", flush=True)
    target_counter = {"done": 0, "total": len(target_jobs)}
    tasks = [
        synth_one_edge(
            edge_tts,
            sem,
            j["text"],
            j["voice"],
            rate,
            CARDS_AUDIO_DIR / f"{j['id']}.mp3",
            target_counter,
            "Target MP3",
        )
        for j in target_jobs
    ]
    results = await asyncio.gather(*tasks)
    ok_count = sum(1 for r in results if r)
    print(f"  -> Hoàn tất {target_name}: {ok_count}/{len(target_jobs)} file hợp lệ.", flush=True)

    if generate_vi_prompts and vi_jobs:
        if has_macos_say_linh():
            print(f"[2/3] Đang tạo {len(vi_jobs)} file gợi ý tiếng Việt (offline macOS Linh voice)...", flush=True)
            vi_ok = 0
            for idx, j in enumerate(vi_jobs, 1):
                existing_mp3 = PROMPTS_AUDIO_DIR / f"{j['id']}_vi.mp3"
                if existing_mp3.exists() and existing_mp3.stat().st_size > 200:
                    vi_ok += 1
                else:
                    existing_mp3.unlink(missing_ok=True)
                    if synth_vi_offline_say(j["text"], PROMPTS_AUDIO_DIR / f"{j['id']}_vi.m4a"):
                        vi_ok += 1
                if idx % 20 == 0 or idx == len(vi_jobs):
                    pct = int(idx * 100 / len(vi_jobs))
                    print(f"  [VN Prompts] {idx}/{len(vi_jobs)} ({pct}%)", flush=True)
            print(f"  -> Hoàn tất gợi ý tiếng Việt: {vi_ok}/{len(vi_jobs)} file hợp lệ.", flush=True)
        else:
            print(f"[2/3] Đang tạo {len(vi_jobs)} file gợi ý tiếng Việt (Edge TTS)...", flush=True)
            vi_counter = {"done": 0, "total": len(vi_jobs)}
            vi_tasks = [
                synth_one_edge(
                    edge_tts,
                    sem,
                    j["text"],
                    j["voice"],
                    "+5%",
                    PROMPTS_AUDIO_DIR / f"{j['id']}_vi.mp3",
                    vi_counter,
                    "VN Prompts",
                )
                for j in vi_jobs
            ]
            vi_res = await asyncio.gather(*vi_tasks)
            print(f"  -> Hoàn tất gợi ý tiếng Việt: {sum(1 for r in vi_res if r)}/{len(vi_jobs)} file.", flush=True)


def _font_paths_for_video() -> list[str]:
    fonts_cfg = CFG["fonts"]
    paths: list[str] = []
    for key in ("regular", "bold"):
        rel = fonts_cfg.get(key)
        if rel:
            p = ROOT / rel
            if p.exists():
                paths.append(str(p))
    return paths


def build_chapter_videos(
    data: dict[str, Any],
    target_chapters: list[int],
    max_cards_per_lesson: int = 0,
    portrait: bool = False,
) -> None:
    ensure_render_binary()
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    LESSONS_AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    TEMP_DIR.mkdir(parents=True, exist_ok=True)

    v_cfg = CFG["video"]
    f_cfg = CFG["fonts"]
    font_files = _font_paths_for_video()
    font_name = f_cfg.get("video_font_name", "HelveticaNeue-Bold")
    fallback_font = f_cfg.get("video_fallback_font", "HelveticaNeue-Bold")
    width = 1080 if portrait else int(v_cfg.get("width", 1280))
    height = 1920 if portrait else int(v_cfg.get("height", 720))
    suffix = "-Shorts" if portrait else ""

    for ch in data["chapters"]:
        if ch["number"] not in target_chapters:
            continue

        print(f"[3/3] Đang ghép track nghe-nói từng bài & dựng video Chương {ch['number']} ({width}x{height})...", flush=True)
        slides: list[dict[str, Any]] = [
            {
                "tag": v_cfg.get("intro_tag", CFG["course_title"].upper()),
                "vietnamese": f"Chương {ch['number']}: {ch['title']}",
                "target": v_cfg.get("intro_target_line", CFG["target_lang"]["name"]),
                "phonetic": v_cfg.get("intro_phonetic", ""),
                "note": v_cfg.get("intro_note", ""),
                "duration": 3.5,
                "reveal_after": 0.0,
                "audio_path": None,
                "audio_delay": None,
                "prompt_audio_path": None,
                "prompt_text": v_cfg.get("prompt_text", "⏱️ Nghe & thử nói to..."),
                "font_name": font_name,
                "fallback_font_name": fallback_font,
                "font_files": font_files,
                "width": width,
                "height": height,
            }
        ]

        for les in ch["lessons"]:
            lesson_slides: list[dict[str, Any]] = []
            cards = les["vocab"][:max_cards_per_lesson] if max_cards_per_lesson > 0 else les["vocab"]
            for v in cards:
                tgt_mp3 = CARDS_AUDIO_DIR / f"{v['audio_id']}.mp3"
                vi_clip = resolve_prompt_path(v["audio_id"])

                vi_dur = get_audio_duration(vi_clip) if vi_clip else 1.2
                tgt_dur = get_audio_duration(tgt_mp3) if (tgt_mp3.exists() and tgt_mp3.stat().st_size > 200) else 2.0

                think_gap = max(2.2, round(vi_dur + 1.4, 1))
                total_dur = round(think_gap + tgt_dur + 0.8, 1)

                slide_obj = {
                    "tag": f"Chương {ch['number']} • Bài {les['number']}",
                    "vietnamese": v["vietnamese"],
                    "target": _item_target(v),
                    "phonetic": v["phonetic"],
                    "note": v.get("note", ""),
                    "duration": total_dur,
                    "reveal_after": think_gap,
                    "prompt_audio_path": str(vi_clip) if vi_clip else None,
                    "audio_path": str(tgt_mp3) if (tgt_mp3.exists() and tgt_mp3.stat().st_size > 200) else None,
                    "audio_delay": think_gap + 0.1,
                    "prompt_text": v_cfg.get("prompt_text", "⏱️ Nghe & thử nói to..."),
                    "font_name": font_name,
                    "fallback_font_name": fallback_font,
                    "font_files": font_files,
                    "width": width,
                    "height": height,
                }
                slides.append(slide_obj)
                lesson_slides.append(slide_obj)

            if lesson_slides and not portrait:
                les_sb = TEMP_DIR / f"storyboard_{les['id']}.json"
                les_sb.write_text(json.dumps(lesson_slides, ensure_ascii=False, indent=2), encoding="utf-8")
                les_m4a = LESSONS_AUDIO_DIR / f"{les['id']}_pimsleur.m4a"
                subprocess.run([str(RENDER_BIN), str(les_sb), str(les_m4a)], check=True)
                print(f"  -> Track nghe-nói bài {les['number']}: {les_m4a.name} ({les_m4a.stat().st_size // 1024} KB)", flush=True)

        sb_path = TEMP_DIR / f"storyboard_chuong_{ch['number']:02d}{suffix}.json"
        sb_path.write_text(json.dumps(slides, ensure_ascii=False, indent=2), encoding="utf-8")
        out_mp4 = VIDEO_DIR / f"Chuong-{ch['number']:02d}-Flashcard-Nghe-Noi{suffix}.mp4"

        print(f"  -> Đang render video {out_mp4.name} ({len(slides)} slide)...", flush=True)
        subprocess.run([str(RENDER_BIN), str(sb_path), str(out_mp4)], check=True)
        print(f"  -> Hoàn thành video: {out_mp4.name} ({out_mp4.stat().st_size // 1024} KB)", flush=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Tạo Audio MP3/M4A và Video MP4 học ngoại ngữ.")
    p.add_argument("--chapters", nargs="+", type=int, default=[1], help="Danh sách số chương (vd: --chapters 1 2)")
    p.add_argument("--all", action="store_true", help="Tạo toàn bộ các chương")
    p.add_argument("--cards-only", action="store_true", help="Chỉ tạo file MP3 từng thẻ (không dựng MP4)")
    p.add_argument("--video-only", action="store_true", help="Chỉ dựng M4A & MP4 từ các file audio đã có")
    p.add_argument("--portrait", action="store_true", help="Xuất video dọc 1080x1920 (TikTok/Reels/Shorts)")
    p.add_argument("--rate", default=TTS_CFG.get("default_rate", "-8%"), help="Tốc độ đọc TTS (mặc định từ config)")
    p.add_argument("--max-video-cards", type=int, default=0, help="Giới hạn số thẻ mỗi bài trong video (0 = tất cả)")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    all_nums = [ch["number"] for ch in data["chapters"]]
    target_chapters = all_nums if args.all else sorted(set(args.chapters))

    if not args.video_only:
        edge_tts = check_edge_tts()
        target_jobs, vi_jobs = collect_jobs_for_chapters(data, target_chapters)
        asyncio.run(
            run_tts_batch(
                edge_tts,
                target_jobs,
                vi_jobs,
                rate=args.rate,
                generate_vi_prompts=not args.cards_only,
            )
        )

    if not args.cards_only:
        build_chapter_videos(
            data,
            target_chapters,
            max_cards_per_lesson=args.max_video_cards,
            portrait=args.portrait,
        )


if __name__ == "__main__":
    main()
