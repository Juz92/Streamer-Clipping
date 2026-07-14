"""Build a route-balanced, blinded 30-clip corpus from three unseen VODs."""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data/clips/training/blind-three-vod-corpus"
BANK = ROOT / "data/clips/training/channel-positive-examples/reference-bank.json"
STREAMS = [
    ("5CFiXyXf1ho", ROOT / "data/clips/job-005-2026-07-09"),
    ("9WJKzVbhFBM", ROOT / "data/clips/job-006-2026-07-12"),
    ("xQvGWXh58MQ", ROOT / "data/clips/job-007-2026-07-05"),
]
STAMP = re.compile(r"^\[(\d{2}):(\d{2}):(\d{2})\]\s*(.*)$")


def seconds(text: str) -> int:
    hour, minute, second = map(int, text.split(":"))
    return hour * 3600 + minute * 60 + second


def timestamp(value: float) -> str:
    value = max(0, int(value))
    return f"{value // 3600:02d}:{value % 3600 // 60:02d}:{value % 60:02d}"


def load_transcript(path: Path) -> list[tuple[int, str]]:
    rows = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        match = STAMP.match(line)
        if match:
            rows.append((int(match[1]) * 3600 + int(match[2]) * 60 + int(match[3]), match[4]))
    if not rows:
        raise ValueError(f"No timestamped transcript rows: {path}")
    return rows


def window_text(rows: list[tuple[int, str]], start: int, duration: int = 45) -> str:
    return " ".join(text for sec, text in rows if start <= sec < start + duration)


def overlaps(candidate: dict, selected: list[dict], margin: int = 15) -> bool:
    return any(candidate["startSec"] < row["endSec"] + margin and candidate["endSec"] > row["startSec"] - margin for row in selected)


def take_nonoverlap(candidates: list[dict], selected: list[dict], count: int) -> list[dict]:
    taken = []
    for candidate in candidates:
        if overlaps(candidate, selected + taken):
            continue
        taken.append(candidate)
        if len(taken) == count:
            break
    if len(taken) != count:
        raise RuntimeError(f"Needed {count} non-overlapping candidates, got {len(taken)}")
    return taken


def reference_document(row: dict) -> str:
    analysis = row["analysis"]
    return " ".join([
        row["title"], analysis["hook"], analysis["premise"], analysis["escalation"],
        analysis["payoff"], analysis["reusable_pattern"], row["transcript_text"],
    ])


def current_candidates(job: Path) -> list[dict]:
    rows = json.loads((job / "recall-candidates.json").read_text(encoding="utf-8"))
    result = []
    for row in rows:
        raw_start, raw_end = float(row["startSec"]), float(row["endSec"])
        duration = min(60.0, max(25.0, raw_end - raw_start + 8.0))
        start = max(0.0, raw_start - 5.0)
        score = float(row.get("viralSubScores", {}).get("blendedFinal", row.get("strength", 0)))
        result.append({
            "route": "current-recall", "startSec": start, "endSec": start + duration,
            "routeScore": score, "evidence": row.get("hook", ""),
        })
    return sorted(result, key=lambda row: row["routeScore"], reverse=True)


def reference_candidates(transcript: list[tuple[int, str]], duration: int, references: list[dict]) -> list[dict]:
    starts = list(range(0, max(1, duration - 45), 15))
    texts = [window_text(transcript, start) for start in starts]
    keep = [index for index, text in enumerate(texts) if len(text.split()) >= 35]
    ref_texts = [reference_document(row) for row in references]
    candidate_texts = [texts[index] for index in keep]
    matrix = TfidfVectorizer(ngram_range=(1, 2), stop_words="english", sublinear_tf=True).fit_transform(ref_texts + candidate_texts)
    similarity = (matrix[len(ref_texts):] @ matrix[:len(ref_texts)].T).toarray()
    best_scores = similarity.max(axis=1)
    best_refs = similarity.argmax(axis=1)
    result = []
    for local_index, source_index in enumerate(keep):
        start = starts[source_index]
        reference = references[int(best_refs[local_index])]
        result.append({
            "route": "reference-retrieval", "startSec": float(start), "endSec": float(start + 45),
            "routeScore": float(best_scores[local_index]), "evidence": reference["title"],
        })
    return sorted(result, key=lambda row: row["routeScore"], reverse=True)


def control_candidates(stream_id: str, transcript: list[tuple[int, str]], duration: int) -> list[dict]:
    rng = random.Random(int(hashlib.sha1(stream_id.encode()).hexdigest()[:12], 16))
    result = []
    third = duration / 3
    for segment in range(3):
        choices = list(range(int(segment * third) + 30, max(int(segment * third) + 31, int((segment + 1) * third) - 75), 15))
        rng.shuffle(choices)
        for start in choices:
            text = window_text(transcript, start)
            if len(text.split()) >= 35:
                result.append({
                    "route": "stratified-control", "startSec": float(start), "endSec": float(start + 45),
                    "routeScore": None, "evidence": "speech-dense random window",
                })
                break
    if len(result) != 3:
        raise RuntimeError(f"Could not create three controls for {stream_id}")
    return result


def select() -> dict:
    bank = json.loads(BANK.read_text(encoding="utf-8"))
    references = [row for row in bank["examples"] if row["analysis"]["comedy_positive"] is True]
    hidden = []
    review_streams = []
    for stream_id, job in STREAMS:
        manifest = json.loads((job / "manifest.json").read_text(encoding="utf-8"))
        transcript = load_transcript(job / "source/transcript_clean.txt")
        selected = take_nonoverlap(current_candidates(job), [], 4)
        selected += take_nonoverlap(reference_candidates(transcript, manifest["durationSec"], references), selected, 3)
        selected += take_nonoverlap(control_candidates(stream_id, transcript, manifest["durationSec"]), selected, 3)
        rng = random.Random(20260713 + int(hashlib.sha1(stream_id.encode()).hexdigest()[:8], 16))
        rng.shuffle(selected)
        review_items = []
        for index, row in enumerate(selected, 1):
            item_id = f"{stream_id}-{index:02d}"
            filename = f"{item_id}.mp4"
            hidden.append({"itemId": item_id, "streamId": stream_id, "title": manifest["title"], "file": filename, **row})
            review_items.append({
                "itemId": item_id, "file": f"clips/{filename}", "reaction": None,
                "allowedReactions": ["lol", "smiled", "nothing", "context-missing"],
            })
        review_streams.append({"streamId": stream_id, "title": manifest["title"], "items": review_items})
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "clips").mkdir(exist_ok=True)
    hidden_report = {"version": 1, "blind": True, "routeQuotaPerVod": {"current-recall": 4, "reference-retrieval": 3, "stratified-control": 3}, "items": hidden}
    review = {"version": 1, "blinded": True, "scoring": {"lol": 1.0, "smiled": 0.5, "nothing": 0.0, "context-missing": 0.0}, "streams": review_streams}
    (DATA / "selection-evidence.json").write_text(json.dumps(hidden_report, indent=2, ensure_ascii=False), encoding="utf-8")
    (DATA / "review-manifest.json").write_text(json.dumps(review, indent=2, ensure_ascii=False), encoding="utf-8")
    return hidden_report


def download_one(row: dict) -> str:
    target = DATA / "clips" / row["file"]
    if target.exists() and target.stat().st_size > 100_000:
        return row["itemId"]
    source = DATA / "sources" / f"{row['streamId']}.mp4"
    if not source.exists():
        raise RuntimeError(f"Missing low-resolution source: {source}")
    duration = row["endSec"] - row["startSec"]
    command = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", str(row["startSec"]),
        "-i", str(source), "-t", str(duration), "-c:v", "libx264", "-preset", "veryfast",
        "-crf", "22", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(target),
    ]
    completed = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, timeout=300)
    if completed.returncode or not target.exists():
        raise RuntimeError(f"{row['itemId']} download failed: {(completed.stderr + completed.stdout)[-1200:]}")
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", str(target)],
        text=True, capture_output=True, timeout=60,
    )
    streams = {item["codec_type"] for item in json.loads(probe.stdout)["streams"]}
    if not {"audio", "video"}.issubset(streams):
        raise RuntimeError(f"{row['itemId']} missing streams: {streams}")
    return row["itemId"]


def download(report: dict) -> None:
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = [executor.submit(download_one, row) for row in report["items"]]
        for index, future in enumerate(as_completed(futures), 1):
            print(f"downloaded {index}/30 {future.result()}", flush=True)


def render_reels() -> None:
    review = json.loads((DATA / "review-manifest.json").read_text(encoding="utf-8"))
    parts_dir = DATA / "reel-parts"
    parts_dir.mkdir(exist_ok=True)

    def render_part(item: dict) -> Path:
        source = DATA / item["file"]
        target = parts_dir / f"{item['itemId']}.mp4"
        command = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(source),
            "-vf", (
                "scale=640:360:force_original_aspect_ratio=decrease,"
                "pad=640:360:(ow-iw)/2:(oh-ih)/2,"
                f"drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='{item['itemId']}':x=18:y=18:fontsize=24:fontcolor=white:"
                "box=1:boxcolor=black@0.65:boxborderw=8"
            ),
            "-af", "aresample=48000", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(target),
        ]
        completed = subprocess.run(command, text=True, capture_output=True, timeout=300)
        if completed.returncode:
            raise RuntimeError(f"Reel part failed {item['itemId']}: {completed.stderr[-800:]}")
        return target

    for stream in review["streams"]:
        with ThreadPoolExecutor(max_workers=3) as executor:
            parts = list(executor.map(render_part, stream["items"]))
        concat_file = parts_dir / f"{stream['streamId']}.txt"
        concat_file.write_text("\n".join(f"file '{path.as_posix()}'" for path in parts), encoding="utf-8")
        reel = DATA / f"review-reel-{stream['streamId']}.mp4"
        completed = subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
             "-i", str(concat_file), "-c", "copy", "-movflags", "+faststart", str(reel)],
            text=True, capture_output=True, timeout=300,
        )
        if completed.returncode:
            raise RuntimeError(f"Reel concat failed {stream['streamId']}: {completed.stderr[-800:]}")
        for part in parts:
            part.unlink()
        concat_file.unlink()
        print(f"rendered {reel.name}")
    parts_dir.rmdir()


def validate() -> None:
    hidden = json.loads((DATA / "selection-evidence.json").read_text(encoding="utf-8"))
    review = json.loads((DATA / "review-manifest.json").read_text(encoding="utf-8"))
    assert len(hidden["items"]) == 30 and sum(len(row["items"]) for row in review["streams"]) == 30
    for stream_id, _ in STREAMS:
        rows = [row for row in hidden["items"] if row["streamId"] == stream_id]
        assert len(rows) == 10
        assert {route: sum(row["route"] == route for row in rows) for route in hidden["routeQuotaPerVod"]} == hidden["routeQuotaPerVod"]
    files = list((DATA / "clips").glob("*.mp4"))
    if files:
        assert len(files) == 30 and all(path.stat().st_size > 100_000 for path in files)
    print(f"PASS blind corpus: 3 VODs, 30 items, {len(files)} downloaded clips")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--select", action="store_true")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--validate", action="store_true")
    parser.add_argument("--reels", action="store_true")
    args = parser.parse_args()
    report = select() if args.select else json.loads((DATA / "selection-evidence.json").read_text(encoding="utf-8"))
    if args.download:
        download(report)
    if args.reels:
        render_reels()
    if args.validate or args.download or args.reels:
        validate()


if __name__ == "__main__":
    main()
