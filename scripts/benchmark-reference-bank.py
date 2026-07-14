"""Benchmark the smallest useful ways to consume the comedy reference bank."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

ROOT = Path(__file__).resolve().parents[1]
BANK = ROOT / "data/clips/training/channel-positive-examples/reference-bank.json"
LABELS = ROOT / "data/clips/qwen-omni-benchmark/labels.json"
REPORT = ROOT / "data/clips/training/channel-positive-examples/reference-bank-benchmark.json"
CACHE = ROOT / "data/clips/training/channel-positive-examples/luna-reference-cache"
MODEL = "gpt-5.6-luna"


def reference_text(row: dict) -> str:
    analysis = row["analysis"]
    return "\n".join([
        row["title"], analysis["hook"], analysis["premise"],
        analysis["escalation"], analysis["payoff"], analysis["reusable_pattern"],
        row["transcript_text"],
    ])


def metrics(rows: list[dict], scores: list[float]) -> dict:
    labels = np.asarray([row["label"] == "LOL" for row in rows], dtype=int)
    values = np.asarray(scores, dtype=float)
    positive = values[labels == 1]
    negative = values[labels == 0]
    pairwise = sum(a > b for a in positive for b in negative)
    top5 = np.argsort(values)[::-1][:5]
    auc = float(roc_auc_score(labels, values))
    pairwise_accuracy = pairwise / (len(positive) * len(negative))
    winners = int(labels[top5].sum())
    return {
        "auc": auc,
        "pairwiseAccuracy": pairwise_accuracy,
        "knownWinnersInTop5": winners,
        "pass": auc >= 0.8 and pairwise_accuracy >= 0.75 and winners >= 4,
    }


def tfidf_scores(positives: list[dict], evaluation: list[dict]) -> tuple[list[float], list[list[int]], np.ndarray]:
    texts = [reference_text(row) for row in positives] + [row["transcript"] for row in evaluation]
    matrix = TfidfVectorizer(ngram_range=(1, 2), stop_words="english", sublinear_tf=True).fit_transform(texts)
    similarities = (matrix[len(positives):] @ matrix[:len(positives)].T).toarray()
    nearest = np.argsort(similarities, axis=1)[:, ::-1]
    return similarities.max(axis=1).tolist(), nearest.tolist(), matrix


def logistic_scores(positives: list[dict], evaluation: list[dict]) -> list[float]:
    scores = []
    for candidate in evaluation:
        negatives = [row for row in evaluation if row["label"] == "NOT_FUNNY" and row["id"] != candidate["id"]]
        train_texts = [reference_text(row) for row in positives] + [row["transcript"] for row in negatives]
        vectorizer = TfidfVectorizer(ngram_range=(1, 2), stop_words="english", sublinear_tf=True)
        matrix = vectorizer.fit_transform(train_texts + [candidate["transcript"]])
        labels = np.asarray([1] * len(positives) + [0] * len(negatives))
        model = LogisticRegression(C=0.25, class_weight="balanced", max_iter=2000).fit(matrix[:-1], labels)
        scores.append(float(model.predict_proba(matrix[-1])[:, 1][0]))
    return scores


def codex_helpers():
    path = Path.home() / "AppData/Local/hermes/scripts/openai_codex_ocr.py"
    spec = importlib.util.spec_from_file_location("codex_helper", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module._codex_token_and_headers, module._extract_stream_text


def luna_score(candidate: dict, positive_refs: list[dict], negative_refs: list[dict], headers: dict, extract_stream_text) -> dict:
    prompt = "\n\n".join([
        "Predict Justin's reaction to the CANDIDATE using the contrastive references.",
        "Taste scale: LOL=1.0, SMILED=0.5, NOTHING=0.0. Generic gameplay, yelling, profanity, randomness, or activity without a distinctive premise, escalation, and payoff scores 0.",
        "CANDIDATE:\n" + candidate["transcript"],
        *[f"KNOWN COMEDY POSITIVE {i + 1}:\n{reference_text(row)[:5000]}" for i, row in enumerate(positive_refs)],
        *[f"KNOWN HARD NEGATIVE {i + 1}:\n{row['transcript']}" for i, row in enumerate(negative_refs)],
        'Return JSON only: {"score":0.0,"label":"LOL|SMILED|NOTHING","reason":"one sentence"}',
    ])
    digest = hashlib.sha1((MODEL + prompt).encode("utf-8")).hexdigest()
    cache = CACHE / f"{candidate['id']}.json"
    if cache.exists():
        saved = json.loads(cache.read_text(encoding="utf-8"))
        if saved.get("promptHash") == digest:
            return saved
    body = {
        "model": MODEL,
        "instructions": "You are a conservative comedy taste ranker. Follow the requested JSON schema exactly.",
        "input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
        "store": False,
        "stream": True,
        "reasoning": {"effort": "low", "summary": "auto"},
        "include": ["reasoning.encrypted_content"],
    }
    request = urllib.request.Request(
        "https://chatgpt.com/backend-api/codex/responses",
        data=json.dumps(body).encode("utf-8"), headers=headers, method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            text = extract_stream_text(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Codex HTTP {error.code}: {error.read().decode('utf-8', 'replace')[:800]}") from error
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError(f"No JSON from Luna: {text[:400]}")
    verdict = json.loads(match.group(0))
    verdict["score"] = min(1.0, max(0.0, float(verdict["score"])))
    verdict.update({"id": candidate["id"], "promptHash": digest})
    CACHE.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(verdict, indent=2), encoding="utf-8")
    return verdict


def self_check() -> None:
    rows = [{"label": "LOL"}, {"label": "LOL"}, {"label": "NOT_FUNNY"}, {"label": "NOT_FUNNY"}]
    result = metrics(rows, [0.9, 0.8, 0.2, 0.1])
    assert result["auc"] == 1.0 and result["pairwiseAccuracy"] == 1.0 and result["knownWinnersInTop5"] == 2
    print("PASS reference-bank benchmark self-check")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--skip-luna", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return

    bank = json.loads(BANK.read_text(encoding="utf-8"))
    positives = [row for row in bank["examples"] if row["analysis"]["comedy_positive"] is True]
    evaluation = json.loads(LABELS.read_text(encoding="utf-8"))
    retrieval, nearest, _ = tfidf_scores(positives, evaluation)
    logistic = logistic_scores(positives, evaluation)
    methods = {
        "tfidfNearestPositive": {"scores": retrieval, "metrics": metrics(evaluation, retrieval)},
        "tfidfLogisticPublicPositivesVsHardNegatives": {"scores": logistic, "metrics": metrics(evaluation, logistic)},
    }

    if not args.skip_luna:
        _, headers = codex_helpers()[0]()
        extract_stream_text = codex_helpers()[1]
        negatives = [row for row in evaluation if row["label"] == "NOT_FUNNY"]
        verdicts: list[dict | None] = [None] * len(evaluation)
        def judge(index: int) -> tuple[int, dict]:
            candidate = evaluation[index]
            pos = [positives[i] for i in nearest[index][:3]]
            neg_pool = [row for row in negatives if row["id"] != candidate["id"]]
            neg_scores, neg_nearest, _ = tfidf_scores(
                [{"title": row["id"], "analysis": {"hook": "", "premise": "", "escalation": "", "payoff": "", "reusable_pattern": ""}, "transcript_text": row["transcript"]} for row in neg_pool],
                [candidate],
            )
            del neg_scores
            neg = [neg_pool[i] for i in neg_nearest[0][:2]]
            return index, luna_score(candidate, pos, neg, headers, extract_stream_text)
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(judge, index) for index in range(len(evaluation))]
            for completed, future in enumerate(as_completed(futures), 1):
                index, verdict = future.result()
                verdicts[index] = verdict
                print(f"Luna {completed}/{len(evaluation)} {evaluation[index]['id']}: {verdict['score']}", flush=True)
        luna_scores = [float(row["score"]) for row in verdicts if row]
        methods["lunaContrastiveReferences"] = {"scores": luna_scores, "verdicts": verdicts, "metrics": metrics(evaluation, luna_scores)}

    winner = max(methods, key=lambda name: (methods[name]["metrics"]["knownWinnersInTop5"], methods[name]["metrics"]["pairwiseAccuracy"]))
    report = {
        "version": 1,
        "evaluation": {"positives": 6, "negatives": 10, "publicComedyReferences": len(positives)},
        "methods": methods,
        "winner": winner,
        "recommendation": "Use only as a shadow feature" if methods[winner]["metrics"]["pass"] else "Do not integrate; proceed to blind-corpus labeling",
    }
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({name: row["metrics"] for name, row in methods.items()}, indent=2))
    print(f"winner={winner} recommendation={report['recommendation']}")


if __name__ == "__main__":
    main()
