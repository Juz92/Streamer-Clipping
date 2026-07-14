"""Align outcome-labelled official Shorts to source VOD windows by transcript n-grams."""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLIPS = ROOT / "data/clips"
TRAINING = CLIPS / "training/official-shorts"
N = 5


def timestamp(value: str) -> float:
    parts = value.strip().replace(",", ".").split(":")
    return float(parts[-1]) + 60 * int(parts[-2]) + 3600 * int(parts[-3])


def tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", re.sub(r"<[^>]+>", " ", text.lower()))


def cue_tokens(path: Path) -> tuple[list[str], list[float]]:
    words, times, start, text = [], [], 0.0, []
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    for line in lines + ["-->"]:
        if "-->" in line:
            if text:
                row = tokens(" ".join(text))
                # YouTube VTT often repeats the exact same cumulative cue.
                if row and words[-len(row):] != row:
                    words.extend(row)
                    times.extend([start] * len(row))
            text = []
            try:
                start = timestamp(line.split("-->", 1)[0])
            except ValueError:
                start = 0.0
        elif line.strip() and not line.startswith(("WEBVTT", "Kind:", "Language:", "NOTE")):
            text.append(line.strip())
    return words, times


def caption_tokens(path: Path) -> list[str]:
    words, _ = cue_tokens(path)
    return words


def build_index(words: list[str]) -> dict[tuple[str, ...], list[int]]:
    result: dict[tuple[str, ...], list[int]] = defaultdict(list)
    for index in range(len(words) - N + 1):
        key = tuple(words[index:index + N])
        if len(set(key)) >= 3:
            result[key].append(index)
    return result


def align(short: list[str], vod_words: list[str], vod_times: list[float], index: dict) -> dict | None:
    offsets, pairs = Counter(), []
    for short_pos in range(0, len(short) - N + 1, 2):
        key = tuple(short[short_pos:short_pos + N])
        positions = index.get(key, [])
        if len(positions) > 8:
            continue
        for vod_pos in positions:
            offsets[vod_pos - short_pos] += 1
            pairs.append((vod_pos - short_pos, vod_pos, short_pos))
    if not offsets:
        return None
    best_offset, matches = offsets.most_common(1)[0]
    tolerance = 4
    matched = [(vod_pos, short_pos) for offset, vod_pos, short_pos in pairs if abs(offset - best_offset) <= tolerance]
    covered = set()
    for _, short_pos in matched:
        covered.update(range(short_pos, short_pos + N))
    coverage = len(covered) / max(1, len(short))
    if matches < 4 or coverage < 0.12:
        return None
    vod_positions = [vod_pos for vod_pos, _ in matched]
    start_pos = max(0, min(vod_positions) - min(short_pos for _, short_pos in matched))
    end_pos = min(len(vod_times) - 1, start_pos + len(short) + N)
    return {
        "startSec": round(vod_times[start_pos], 3),
        "endSec": round(max(vod_times[end_pos] + 4, vod_times[start_pos] + 8), 3),
        "coverage": round(coverage, 4),
        "matchingNgrams": matches,
    }


def main() -> None:
    sample = json.loads((TRAINING / "sample.json").read_text(encoding="utf-8"))["items"]
    outcomes = {row["id"]: row for row in sample}
    vods = []
    for manifest_path in CLIPS.glob("job-*/manifest.json"):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        subtitle = Path(manifest["subtitlePath"])
        if not subtitle.exists() or any(row["streamId"] == manifest["streamId"] for row in vods):
            continue
        words, times = cue_tokens(subtitle)
        vods.append({"streamId": manifest["streamId"], "words": words, "times": times, "index": build_index(words)})

    aligned, ambiguous, unmatched = [], [], []
    for caption in sorted((TRAINING / "captions").glob("*.vtt")):
        video_id = caption.name.split(".", 1)[0]
        short = caption_tokens(caption)
        candidates = []
        for vod in vods:
            result = align(short, vod["words"], vod["times"], vod["index"])
            if result:
                candidates.append({"streamId": vod["streamId"], **result})
        candidates.sort(key=lambda row: (row["coverage"], row["matchingNgrams"]), reverse=True)
        if not candidates:
            unmatched.append(video_id)
            continue
        if len(candidates) > 1 and candidates[1]["coverage"] >= candidates[0]["coverage"] * 0.9:
            ambiguous.append({"videoId": video_id, "candidates": candidates[:2]})
            continue
        outcome = outcomes.get(video_id, {})
        aligned.append({
            "videoId": video_id,
            "views": outcome.get("views"),
            "uploadDate": outcome.get("uploadDate"),
            "title": outcome.get("title"),
            **candidates[0],
        })
    report = {"version": 1, "nGram": N, "aligned": aligned, "ambiguous": ambiguous, "unmatched": unmatched}
    output = TRAINING / "source-vod-alignments.json"
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"aligned": len(aligned), "ambiguous": len(ambiguous), "unmatched": len(unmatched)}, indent=2))


if __name__ == "__main__":
    main()
