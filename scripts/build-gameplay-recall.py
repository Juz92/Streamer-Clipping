"""Prototype a gameplay-first recall lane from Twitch chat eruptions."""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STREAM_ID = "9WJKzVbhFBM"
JOB = ROOT / "data/clips/job-006-2026-07-12"
OUT = ROOT / "data/clips/training/gameplay-recall-prototype"
SOURCE = OUT / f"{STREAM_ID}-source.mp4"
MANIFEST = OUT / "candidates.json"
REACTION = re.compile(r"\b(?:lol|lmao|lmfao|wtf|omg|no way|holy|insane|clutch|dead|crazy|w|rip)\b|😂|🤣", re.I)
STRONG_OUTCOME = re.compile(r"\b(?:double kill|triple kill|multi[- ]?kill|headshot|clutch|we won|i won|got one|got him|killed him|downed one|mission complete)\b", re.I)
WEAK_OUTCOME = re.compile(r"\b(?:kill|killed|dead|won|win|shot|downed|objective|mission|escape|survive|imposter|vote|reload|ammo)\b", re.I)
STAMP = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2})\]\s*(.*)$")


def autonomous_ranker():
    path = ROOT / "scripts/autonomous-ranker.py"
    spec = importlib.util.spec_from_file_location("autonomous_ranker", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def transcript_rows() -> list[tuple[int, str]]:
    rows = []
    for line in (JOB / "source/transcript_clean.txt").read_text(encoding="utf-8", errors="ignore").splitlines():
        match = STAMP.match(line)
        if match:
            rows.append((int(match[1]) * 3600 + int(match[2]) * 60 + int(match[3]), match[4]))
    return rows


def transcript_between(rows: list[tuple[int, str]], start: float, end: float) -> str:
    return " ".join(text for second, text in rows if start <= second <= end)


def select(limit: int = 12) -> dict:
    comments, offset = autonomous_ranker().stream_chat(STREAM_ID)
    bins: dict[int, dict] = defaultdict(lambda: {"count": 0, "reactions": 0, "authors": set()})
    for comment in comments:
        second = float(comment.get("content_offset_seconds", -1))
        if second < 300:
            continue
        bucket = int(second // 5) * 5
        message = str(comment.get("message", {}).get("body", ""))
        author = str((comment.get("commenter") or {}).get("_id") or "")
        bins[bucket]["count"] += 1
        bins[bucket]["reactions"] += int(bool(REACTION.search(message)))
        if author:
            bins[bucket]["authors"].add(author)

    candidates = []
    for bucket, row in bins.items():
        nearby = [bins.get(second, {"count": 0})["count"] for second in range(bucket - 120, bucket + 125, 5) if second != bucket]
        baseline = sorted(nearby)[len(nearby) // 2] if nearby else 0
        lift = (row["count"] + 1) / (baseline + 1)
        score = row["count"] + 2 * row["reactions"] + 0.2 * len(row["authors"]) + min(lift, 5)
        youtube_peak = bucket + 2.5 - offset
        candidates.append({"peakSec": youtube_peak, "score": score, "messages": row["count"], "reactions": row["reactions"], "lift": lift})

    transcript = transcript_rows()
    selected = []
    for row in sorted(candidates, key=lambda item: item["score"], reverse=True):
        if any(abs(row["peakSec"] - prior["peakSec"]) < 90 for prior in selected):
            continue
        row["route"] = "chat-eruption"
        selected.append(row)
        if len(selected) == limit // 2:
            break

    outcome_candidates = []
    for start in range(300, int(transcript[-1][0]) - 55, 10):
        text = transcript_between(transcript, start, start + 55)
        strong = len(STRONG_OUTCOME.findall(text))
        weak = len(WEAK_OUTCOME.findall(text))
        if strong or weak >= 3:
            outcome_candidates.append({
                "peakSec": start + 35.0, "score": strong * 5 + weak,
                "messages": 0, "reactions": 0, "lift": 0, "route": "outcome-callout",
            })
    for row in sorted(outcome_candidates, key=lambda item: item["score"], reverse=True):
        if any(abs(row["peakSec"] - prior["peakSec"]) < 90 for prior in selected):
            continue
        selected.append(row)
        if len(selected) == limit:
            break
    if len(selected) != limit:
        raise RuntimeError(f"Needed {limit} mixed-route candidates, got {len(selected)}")

    for index, row in enumerate(selected, 1):
        row["id"] = f"G{index:02d}"
        row["startSec"] = max(0, row["peakSec"] - 35)
        row["endSec"] = row["peakSec"] + 20
        row["transcript"] = transcript_between(transcript, row["startSec"], row["endSec"])
        row["file"] = f"clips/{row['id']}.mp4"
    report = {"version": 2, "streamId": STREAM_ID, "routes": {"chat-eruption": 6, "outcome-callout": 6}, "offsetSec": offset, "items": selected}
    OUT.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    return report


def run(command: list[str], timeout: int = 600) -> None:
    completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, timeout=timeout)
    if completed.returncode:
        raise RuntimeError((completed.stderr + completed.stdout)[-1200:])


def render(report: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    clips = OUT / "clips"
    clips.mkdir(exist_ok=True)
    if not SOURCE.exists():
        run(["yt-dlp", "--no-warnings", "-f", "133+139", "--merge-output-format", "mp4", "-o", str(SOURCE), f"https://youtube.com/watch?v={STREAM_ID}"], 900)
    parts = []
    for item in report["items"]:
        target = OUT / item["file"]
        run([
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", str(item["startSec"]), "-i", str(SOURCE),
            "-t", str(item["endSec"] - item["startSec"]), "-vf",
            f"scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='{item['id']}':x=18:y=18:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=8",
            "-af", "aresample=48000", "-c:v", "libx264", "-preset", "veryfast", "-crf", "25", "-c:a", "aac", "-b:a", "96k", str(target),
        ])
        parts.append(target)
    concat = OUT / "concat.txt"
    concat.write_text("\n".join(f"file '{path.as_posix()}'" for path in parts), encoding="utf-8")
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(concat), "-c", "copy", "-movflags", "+faststart", str(OUT / "gameplay-candidate-reel.mp4")])
    concat.unlink()


def validate(report: dict) -> None:
    assert len(report["items"]) == 12
    assert len({item["id"] for item in report["items"]}) == 12
    assert Counter(item["route"] for item in report["items"]) == Counter({"chat-eruption": 6, "outcome-callout": 6})
    assert all(abs(a["peakSec"] - b["peakSec"]) >= 90 for index, a in enumerate(report["items"]) for b in report["items"][index + 1:])
    reel = OUT / "gameplay-candidate-reel.mp4"
    if reel.exists():
        probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", str(reel)], capture_output=True, text=True, check=True)
        assert {row["codec_type"] for row in json.loads(probe.stdout)["streams"]} == {"video", "audio"}
    print(f"PASS gameplay recall: {len(report['items'])} separated chat eruptions, reel={reel.exists()}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--select", action="store_true")
    parser.add_argument("--render", action="store_true")
    parser.add_argument("--validate", action="store_true")
    args = parser.parse_args()
    report = select() if args.select else json.loads(MANIFEST.read_text(encoding="utf-8"))
    if args.render:
        render(report)
    if args.validate or args.render:
        validate(report)


if __name__ == "__main__":
    main()
