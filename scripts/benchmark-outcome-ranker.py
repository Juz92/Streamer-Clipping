"""Benchmark an autonomous transcript ranker against real Short performance.

Training labels are generated without manual review: within each 50-item recency
bucket of official Burnt Peanut Shorts, the five highest-viewed clips are positive
and the five lowest-viewed clips are negative. The final gate is blind separation
of six known strong stream moments from four known rejects.
"""
from __future__ import annotations

import html
import json
import os
import re
import time
from pathlib import Path

import numpy as np
import requests
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, roc_auc_score
from sklearn.model_selection import GroupKFold
from sklearn.preprocessing import normalize

ROOT = Path(__file__).resolve().parents[1]
TRAINING_DIR = ROOT / "data/clips/training/official-shorts"
JOB_DIR = ROOT / "data/clips/job-002-2026-07-04"
EMBEDDING_MODEL = "openai/text-embedding-3-small"


def load_project_env() -> None:
    env_file = ROOT / ".env"
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def merge_caption_lines(lines: list[str]) -> str:
    words_out: list[str] = []
    for raw in lines:
        text = html.unescape(re.sub(r"<[^>]+>", "", raw)).replace(">>", " ").strip()
        if not text or text in {"WEBVTT", "Kind: captions", "Language: en"} or "-->" in text:
            continue
        words = text.split()
        if not words:
            continue
        recent = " ".join(words_out[-80:]).lower()
        whole = " ".join(words).lower()
        if whole and whole in recent:
            continue
        overlap = 0
        for size in range(min(len(words_out), len(words), 40), 0, -1):
            if [x.lower() for x in words_out[-size:]] == [x.lower() for x in words[:size]]:
                overlap = size
                break
        words_out.extend(words[overlap:])
    return " ".join(words_out)


def vtt_text(path: Path) -> str:
    return merge_caption_lines(path.read_text(encoding="utf-8", errors="ignore").splitlines())


def seconds(timestamp: str) -> float:
    parts = timestamp.split(":")
    return float(parts[-1]) + 60 * int(parts[-2]) + 3600 * int(parts[-3])


def interval_vtt(path: Path, start: float, end: float) -> str:
    selected: list[str] = []
    active = False
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if "-->" in line:
            try:
                left, right = line.split("-->", 1)
                cue_start = seconds(left.strip())
                cue_end = seconds(right.strip().split()[0])
                active = cue_end >= start and cue_start <= end
            except (ValueError, IndexError):
                active = False
        elif active:
            selected.append(line)
    return merge_caption_lines(selected)


def embed_texts(texts: list[str], api_key: str) -> list[list[float]]:
    cache = TRAINING_DIR / "embeddings-openai-small.json"
    if cache.exists():
        cached = json.loads(cache.read_text(encoding="utf-8"))
        if cached.get("count") == len(texts) and cached.get("model") == EMBEDDING_MODEL:
            return cached["embeddings"]

    embeddings: list[list[float]] = []
    for offset in range(0, len(texts), 40):
        batch = texts[offset : offset + 40]
        response = None
        for attempt in range(4):
            response = requests.post(
                "https://openrouter.ai/api/v1/embeddings",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://localhost/streamer-clipping",
                    "X-Title": "Streamer-Clipping outcome benchmark",
                },
                json={
                    "model": EMBEDDING_MODEL,
                    "input": batch,
                    "provider": {"data_collection": "deny"},
                },
                timeout=180,
            )
            if response.ok:
                break
            time.sleep(2**attempt)
        assert response is not None
        response.raise_for_status()
        data = sorted(response.json()["data"], key=lambda item: item["index"])
        embeddings.extend(item["embedding"] for item in data)
        print(f"Embedded {len(embeddings)}/{len(texts)}")

    cache.write_text(
        json.dumps({"model": EMBEDDING_MODEL, "count": len(texts), "embeddings": embeddings}),
        encoding="utf-8",
    )
    return embeddings


def main() -> None:
    load_project_env()
    api_key = os.environ["OPENROUTER_API_KEY"]

    sample = json.loads((TRAINING_DIR / "sample.json").read_text(encoding="utf-8"))["items"]
    training: list[dict] = []
    for item in sample:
        caption_path = TRAINING_DIR / "captions" / f"{item['id']}.en-orig.vtt"
        if not caption_path.exists():
            continue
        training.append(
            {
                **item,
                "text": f"TITLE: {item['title']}\nTRANSCRIPT: {vtt_text(caption_path)}",
            }
        )

    known = json.loads((JOB_DIR / "deep-funny-candidates.json").read_text(encoding="utf-8"))["candidates"]
    evaluation: list[dict] = [
        {
            "name": item["title"],
            "label": 1,
            "text": f"TITLE: {item['title']}\nTRANSCRIPT: {item['transcriptEvidence']}",
        }
        for item in known
    ]

    manifest = json.loads((JOB_DIR / "review/recall-v1/manifest.json").read_text(encoding="utf-8"))
    stream_vtt = JOB_DIR / "source/stream.en.vtt"
    for item in manifest["newFindings"]:
        title = Path(item["file"]).stem
        transcript = interval_vtt(
            stream_vtt,
            item["sourceStartSec"],
            item["sourceStartSec"] + item["durationSec"],
        )
        evaluation.append(
            {
                "name": title,
                "label": 0,
                "text": f"TITLE: {title}\nTRANSCRIPT: {transcript}",
            }
        )

    texts = [item["text"] for item in training + evaluation]
    embeddings = embed_texts(texts, api_key)

    x_train = normalize(np.asarray(embeddings[: len(training)], dtype=np.float32))
    y_train = np.asarray([1 if item["label"] == "high" else 0 for item in training])
    groups = np.asarray([item["recencyBlock"] for item in training])

    predictions = np.zeros(len(training))
    folds: list[dict] = []
    for train_indices, test_indices in GroupKFold(5).split(x_train, y_train, groups):
        model = LogisticRegression(C=0.25, max_iter=2000, class_weight="balanced")
        model.fit(x_train[train_indices], y_train[train_indices])
        predictions[test_indices] = model.predict_proba(x_train[test_indices])[:, 1]
        folds.append(
            {
                "groups": sorted(set(groups[test_indices].tolist())),
                "accuracy": float(accuracy_score(y_train[test_indices], predictions[test_indices] >= 0.5)),
                "auc": float(roc_auc_score(y_train[test_indices], predictions[test_indices])),
            }
        )

    model = LogisticRegression(C=0.25, max_iter=2000, class_weight="balanced")
    model.fit(x_train, y_train)
    x_evaluation = normalize(np.asarray(embeddings[len(training) :], dtype=np.float32))
    scores = model.predict_proba(x_evaluation)[:, 1]
    for item, score in zip(evaluation, scores):
        item["score"] = round(float(score), 6)

    labels = [item["label"] for item in evaluation]
    positive_scores = [item["score"] for item in evaluation if item["label"] == 1]
    negative_scores = [item["score"] for item in evaluation if item["label"] == 0]
    pairwise_wins = sum(a > b for a in positive_scores for b in negative_scores)
    pairwise_total = len(positive_scores) * len(negative_scores)
    blind_auc = float(roc_auc_score(labels, scores))
    pairwise_accuracy = pairwise_wins / pairwise_total

    report = {
        "version": 1,
        "training": {
            "count": len(training),
            "labels": {"high": int(y_train.sum()), "low": int((1 - y_train).sum())},
            "strategy": "top/bottom 5 within 50-item recency buckets",
            "embedding": EMBEDDING_MODEL,
        },
        "crossValidation": {
            "accuracy": float(accuracy_score(y_train, predictions >= 0.5)),
            "auc": float(roc_auc_score(y_train, predictions)),
            "folds": folds,
        },
        "blindKnownWinsVsRejects": {
            "auc": blind_auc,
            "pairwiseWins": pairwise_wins,
            "pairwiseTotal": pairwise_total,
            "pairwiseAccuracy": pairwise_accuracy,
            "pass": blind_auc >= 0.8 and pairwise_accuracy >= 0.75,
            "items": sorted(evaluation, key=lambda item: item["score"], reverse=True),
        },
    }
    report_path = TRAINING_DIR / "outcome-ranker-benchmark.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
