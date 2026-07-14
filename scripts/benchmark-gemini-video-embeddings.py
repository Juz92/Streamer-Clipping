"""Benchmark Gemini Embedding 2 video vectors on known clip decisions."""
from __future__ import annotations

import base64
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import requests
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, precision_score, recall_score, roc_auc_score

ROOT = Path(__file__).resolve().parents[1]
PROBES = ROOT / "data/clips/job-002-2026-07-04/review/recall-v1/analysis-probes/pairwise"
CACHE = ROOT / "data/clips/training/gemini-video-embeddings"
REPORT = ROOT / "data/clips/job-002-2026-07-04/analysis/gemini-video-embedding-benchmark.json"
MODEL = "gemini-embedding-2"
DIMENSIONS = 768


def env_key(name: str) -> str:
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError(f"{name} is not configured")


def label_for(path: Path) -> int:
    return int(path.name[:2] in {"01", "02", "03", "04", "05", "06"})


def embed(path: Path, key: str) -> np.ndarray:
    CACHE.mkdir(parents=True, exist_ok=True)
    cached = CACHE / f"{path.stem}.{MODEL}.{DIMENSIONS}.json"
    if cached.exists():
        return np.asarray(json.loads(cached.read_text(encoding="utf-8"))["values"], dtype=np.float32)
    body = {
        "model": f"models/{MODEL}",
        "content": {
            "parts": [
                {
                    "inline_data": {
                        "mime_type": "video/mp4",
                        "data": base64.b64encode(path.read_bytes()).decode("ascii"),
                    }
                }
            ]
        },
        "outputDimensionality": DIMENSIONS,
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:embedContent"
    last_error = ""
    for attempt in range(6):
        response = requests.post(url, headers={"x-goog-api-key": key}, json=body, timeout=300)
        if response.ok:
            values = response.json()["embedding"]["values"]
            cached.write_text(
                json.dumps({"model": MODEL, "dimensions": DIMENSIONS, "source": path.name, "values": values}),
                encoding="utf-8",
            )
            return np.asarray(values, dtype=np.float32)
        last_error = f"{response.status_code}: {response.text[:800]}"
        if response.status_code != 429:
            break
        time.sleep(min(65, 5 * (attempt + 1)))
    raise RuntimeError(f"Embedding failed for {path.name}: {last_error}")


def normalize(matrix: np.ndarray) -> np.ndarray:
    return matrix / np.maximum(np.linalg.norm(matrix, axis=1, keepdims=True), 1e-9)


def evaluate(labels: np.ndarray, scores: np.ndarray, predictions: np.ndarray) -> dict:
    return {
        "auc": float(roc_auc_score(labels, scores)),
        "accuracy": float(accuracy_score(labels, predictions)),
        "precision": float(precision_score(labels, predictions, zero_division=0)),
        "recall": float(recall_score(labels, predictions, zero_division=0)),
    }


def main() -> None:
    files = sorted(PROBES.glob("*.mp4"))
    key = env_key("GEMINI_API_KEY")
    vectors: dict[str, np.ndarray] = {}
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = {executor.submit(embed, path, key): path for path in files}
        for future in as_completed(futures):
            path = futures[future]
            vectors[path.name] = future.result()
            print(f"embedded {path.name}", flush=True)
    matrix = normalize(np.vstack([vectors[path.name] for path in files]))
    labels = np.asarray([label_for(path) for path in files], dtype=np.int32)
    centroid_scores = []
    nearest_scores = []
    logistic_scores = []
    for index in range(len(files)):
        train = np.arange(len(files)) != index
        train_matrix, train_labels = matrix[train], labels[train]
        positive_center = normalize(train_matrix[train_labels == 1].mean(axis=0, keepdims=True))[0]
        negative_center = normalize(train_matrix[train_labels == 0].mean(axis=0, keepdims=True))[0]
        centroid_scores.append(float(matrix[index] @ positive_center - matrix[index] @ negative_center))
        similarities = train_matrix @ matrix[index]
        nearest_index = int(np.argmax(similarities))
        nearest_scores.append(float(train_labels[nearest_index]))
        classifier = LogisticRegression(C=0.1, class_weight="balanced", max_iter=2000)
        classifier.fit(train_matrix, train_labels)
        logistic_scores.append(float(classifier.predict_proba(matrix[index : index + 1])[0, 1]))
    centroid = np.asarray(centroid_scores)
    nearest = np.asarray(nearest_scores)
    logistic = np.asarray(logistic_scores)
    methods = {
        "leaveOneOutCentroid": evaluate(labels, centroid, (centroid >= 0).astype(int)),
        "leaveOneOutNearestNeighbor": evaluate(labels, nearest, (nearest >= 0.5).astype(int)),
        "leaveOneOutLogistic": evaluate(labels, logistic, (logistic >= 0.5).astype(int)),
    }
    best_auc = max(row["auc"] for row in methods.values())
    report = {
        "version": 1,
        "model": MODEL,
        "dimensions": DIMENSIONS,
        "benchmark": "six known strong vs four known rejects",
        "methods": methods,
        "exploratoryPass": best_auc >= 0.8,
        "productionReady": False,
        "productionBlocker": "Requires an independent VOD holdout with both strong and rejected clips.",
        "items": [
            {
                "file": path.name,
                "label": int(labels[index]),
                "centroidScore": float(centroid[index]),
                "nearestScore": float(nearest[index]),
                "logisticScore": float(logistic[index]),
            }
            for index, path in enumerate(files)
        ],
    }
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
