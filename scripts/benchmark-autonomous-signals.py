"""Evaluate deterministic autonomous signals on known strong/rejected clips."""
from __future__ import annotations

import importlib.util
import json
import math
import re
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parents[1]
JOB = ROOT / "data/clips/job-002-2026-07-04"


def load_caption_helpers():
    path = ROOT / "scripts/benchmark-outcome-ranker.py"
    spec = importlib.util.spec_from_file_location("outcome_benchmark", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


def transcript_features(text: str, duration: float) -> dict[str, float]:
    words = re.findall(r"[a-zA-Z']+", text.lower())
    counts: dict[str, int] = {}
    for word in words:
        counts[word] = counts.get(word, 0) + 1
    return {
        "durationSec": duration,
        "wordCount": float(len(words)),
        "wordsPerSec": len(words) / max(duration, 1),
        "uniqueWordRatio": len(counts) / max(len(words), 1),
        "maxWordRepetition": float(max(counts.values(), default=0)),
        "laughterMarkers": float(len(re.findall(r"\b(?:laugh|laughter|haha|hehe)\b", text.lower()))),
        "questionCount": float(text.count("?")),
    }


def load_items() -> list[dict]:
    helpers = load_caption_helpers()
    deep = json.loads((JOB / "deep-funny-candidates.json").read_text(encoding="utf-8"))["candidates"]
    items = [
        {
            "name": row["title"],
            "label": 1,
            "start": float(row["startSec"]),
            "end": float(row["endSec"]),
            "text": row["transcriptEvidence"],
        }
        for row in deep
    ]
    manifest = json.loads((JOB / "review/recall-v1/manifest.json").read_text(encoding="utf-8"))
    source_vtt = JOB / "source/stream.en.vtt"
    for row in manifest["newFindings"]:
        start = float(row["sourceStartSec"])
        end = start + float(row["durationSec"])
        items.append(
            {
                "name": Path(row["file"]).stem,
                "label": 0,
                "start": start,
                "end": end,
                "text": helpers.interval_vtt(source_vtt, start, end),
            }
        )
    for item in items:
        item["features"] = transcript_features(item["text"], item["end"] - item["start"])
        item["audio"] = []
    return items


def attach_audio(items: list[dict]) -> None:
    timestamp = None
    with (JOB / "audio_levels.txt").open(encoding="utf-8", errors="ignore") as handle:
        for line in handle:
            if "pts_time:" in line:
                match = re.search(r"pts_time:([0-9.]+)", line)
                timestamp = float(match.group(1)) if match else None
                continue
            if timestamp is None or "RMS_level=" not in line:
                continue
            value_text = line.rsplit("=", 1)[-1].strip()
            if value_text == "-inf":
                value = -100.0
            else:
                try:
                    value = float(value_text)
                except ValueError:
                    continue
            for item in items:
                if item["start"] <= timestamp <= item["end"]:
                    item["audio"].append(value)
    for item in items:
        values = np.asarray(item.pop("audio"), dtype=np.float32)
        if not len(values):
            continue
        finite = values[np.isfinite(values)]
        item["features"].update(
            {
                "audioMeanRms": float(np.mean(finite)),
                "audioStdRms": float(np.std(finite)),
                "audioP95Rms": float(np.percentile(finite, 95)),
                "audioRobustRange": float(np.percentile(finite, 99) - np.percentile(finite, 5)),
                "audioVolatility": float(np.mean(np.abs(np.diff(finite)))) if len(finite) > 1 else 0.0,
                "audioLoudRate": float(np.mean(finite > -20.0)),
                "audioActiveRate": float(np.mean(finite > -40.0)),
            }
        )


def main() -> None:
    items = load_items()
    attach_audio(items)
    labels = np.asarray([item["label"] for item in items])
    feature_names = sorted(set.intersection(*(set(item["features"]) for item in items)))
    metrics = []
    for feature in feature_names:
        values = np.asarray([item["features"][feature] for item in items])
        auc = float(roc_auc_score(labels, values))
        best_auc = max(auc, 1.0 - auc)
        metrics.append(
            {
                "feature": feature,
                "aucHigherMeansStrong": auc,
                "bestDirectionalAuc": best_auc,
                "strongDirection": "higher" if auc >= 0.5 else "lower",
                "pass": best_auc >= 0.8,
            }
        )
    report = {
        "version": 1,
        "benchmark": "six known strong vs four known rejects",
        "metrics": sorted(metrics, key=lambda row: row["bestDirectionalAuc"], reverse=True),
        "items": [
            {"name": item["name"], "label": item["label"], "features": item["features"]}
            for item in items
        ],
    }
    output = JOB / "analysis/autonomous-signal-benchmark.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
