"""Benchmark no-auth Twitch VOD chat as an autonomous clip-quality signal."""
from __future__ import annotations

import json
import math
import re
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data/clips/training/twitch-chat/benchmark"
LAUGH_RE = re.compile(r"(?:\bl+o+l+\b|\blmao+\b|\brofl\b|\bh+a+h+a+\b|kekw|omegalul|lulw|wheeze|😂|🤣)", re.I)


def body(comment: dict) -> str:
    return str(comment.get("message", {}).get("body", "")).strip()


def author(comment: dict) -> str:
    return str((comment.get("commenter") or {}).get("_id") or (comment.get("commenter") or {}).get("name") or "")


def normalize_message(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", text.lower()))


def rate_ratio(core_count: float, core_seconds: float, base_count: float, base_seconds: float, prior: float = 1.0) -> float:
    core_rate = (core_count + prior) / max(core_seconds, 1.0)
    base_rate = (base_count + prior * base_seconds / max(core_seconds, 1.0)) / max(base_seconds, 1.0)
    return core_rate / max(base_rate, 1e-9)


def peak_count(comments: list[dict], start: float, end: float, width: float = 5.0) -> int:
    bins: Counter[int] = Counter()
    for row in comments:
        t = float(row.get("content_offset_seconds", -1))
        if start <= t <= end:
            bins[int((t - start) // width)] += 1
    return max(bins.values(), default=0)


def extract(item: dict, comments: list[dict]) -> dict[str, float]:
    start = float(item["twitchStart"])
    end = float(item["twitchEnd"])
    # Include delayed audience reaction after the source window.
    core_start, core_end = start, end + 12.0
    before_start, before_end = max(0.0, start - 110.0), max(0.0, start - 10.0)
    after_start, after_end = end + 30.0, end + 110.0
    core = [row for row in comments if core_start <= float(row.get("content_offset_seconds", -1)) <= core_end]
    base = [
        row
        for row in comments
        if before_start <= float(row.get("content_offset_seconds", -1)) <= before_end
        or after_start <= float(row.get("content_offset_seconds", -1)) <= after_end
    ]
    core_seconds = core_end - core_start
    base_seconds = max(0.0, before_end - before_start) + max(0.0, after_end - after_start)
    core_bodies = [body(row) for row in core]
    base_bodies = [body(row) for row in base]
    core_laughs = sum(bool(LAUGH_RE.search(text)) for text in core_bodies)
    base_laughs = sum(bool(LAUGH_RE.search(text)) for text in base_bodies)
    core_emotes = sum(bool(row.get("message", {}).get("emoticons")) for row in core)
    base_emotes = sum(bool(row.get("message", {}).get("emoticons")) for row in base)
    core_short = sum(0 < len(normalize_message(text).split()) <= 2 for text in core_bodies)
    base_short = sum(0 < len(normalize_message(text).split()) <= 2 for text in base_bodies)
    normalized = [normalize_message(text) for text in core_bodies if normalize_message(text)]
    duplicate_share = max(Counter(normalized).values(), default=0) / max(len(normalized), 1)
    core_peak = peak_count(comments, core_start, core_end)
    expected_peak = len(base) / max(base_seconds, 1.0) * 5.0
    return {
        "chatRateLift": rate_ratio(len(core), core_seconds, len(base), base_seconds),
        "uniqueChatterRateLift": rate_ratio(len({author(r) for r in core if author(r)}), core_seconds, len({author(r) for r in base if author(r)}), base_seconds),
        "laughRateLift": rate_ratio(core_laughs, core_seconds, base_laughs, base_seconds, prior=0.5),
        "emoteRateLift": rate_ratio(core_emotes, core_seconds, base_emotes, base_seconds, prior=0.5),
        "shortReactionRateLift": rate_ratio(core_short, core_seconds, base_short, base_seconds, prior=0.5),
        "peak5sLift": (core_peak + 1.0) / max(expected_peak + 1.0, 1e-9),
        "duplicateShare": duplicate_share,
        "coreMessages": float(len(core)),
        "coreMessagesPerSec": len(core) / max(core_seconds, 1.0),
        "coreLaughShare": core_laughs / max(len(core), 1),
    }


def main() -> None:
    items = json.loads((DATA / "benchmark-items.json").read_text(encoding="utf-8"))
    for item in items:
        payload = json.loads((ROOT / item["file"]).read_text(encoding="utf-8"))
        item["features"] = extract(item, payload.get("comments", []))
    labels = np.asarray([item["label"] for item in items])
    names = sorted(items[0]["features"])
    metrics = []
    for name in names:
        values = np.asarray([item["features"][name] for item in items])
        auc = float(roc_auc_score(labels, values))
        directional = max(auc, 1.0 - auc)
        metrics.append({
            "feature": name,
            "aucHigherMeansStrong": auc,
            "bestDirectionalAuc": directional,
            "strongDirection": "higher" if auc >= 0.5 else "lower",
            "pass": directional >= 0.8,
        })
    report = {
        "version": 1,
        "benchmark": "six known strong vs four known rejects",
        "clockOffset": "Twitch = YouTube + 9 seconds",
        "metrics": sorted(metrics, key=lambda row: row["bestDirectionalAuc"], reverse=True),
        "items": items,
    }
    output = ROOT / "data/clips/job-002-2026-07-04/analysis/twitch-chat-signal-benchmark.json"
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
