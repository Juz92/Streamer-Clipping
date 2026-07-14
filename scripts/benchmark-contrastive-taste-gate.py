"""Benchmark a Justin-specific LOL gate against labeled clips; no production mutation."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
CLIPS = ROOT / "data/clips"
FEEDBACK = CLIPS / "manual-review-feedback.json"
NEGATIVE_MANIFEST = CLIPS / "new-system-shadow-review/manifest.json"
POSITIVE_DIR = CLIPS / "job-002-2026-07-04/review/deep-candidates-final-split-v8"
PROXIES = CLIPS / "training/taste-gate-proxies"
REPORT = CLIPS / "contrastive-taste-gate-report.json"
MODEL = "gemini-2.5-flash"


def env_key() -> str:
    if os.getenv("GEMINI_API_KEY"):
        return os.environ["GEMINI_API_KEY"]
    for path in [ROOT / ".env", ROOT / "packages/pipeline/.env"]:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("GEMINI_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError("GEMINI_API_KEY not found")


def atomic_json(path: Path, value: object) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(path)


def labeled_clips() -> list[dict]:
    feedback = json.loads(FEEDBACK.read_text(encoding="utf-8"))
    first = feedback["records"][0]
    notes = {row["file"]: row.get("notes", "") for row in first["decisions"] if row["status"] == "KEEP"}
    rows = [
        {"id": path.stem, "path": path, "label": "LOL", "description": notes.get(path.name, path.stem.replace("-", " "))}
        for path in sorted(POSITIVE_DIR.glob("*.mp4"))
    ]
    manifest = json.loads(NEGATIVE_MANIFEST.read_text(encoding="utf-8"))
    rows.extend(
        {
            "id": item["file"].removesuffix(".mp4"),
            "path": NEGATIVE_MANIFEST.parent / item["file"],
            "label": "NOT_FUNNY",
            "description": item["hook"],
        }
        for item in manifest["items"]
    )
    if len(rows) != 16 or sum(row["label"] == "LOL" for row in rows) != 6:
        raise RuntimeError(f"Expected 6 LOL + 10 NOT_FUNNY clips, found {len(rows)}")
    if any(not row["path"].exists() for row in rows):
        raise RuntimeError("A labeled clip file is missing")
    return rows


def proxy_for(row: dict) -> Path:
    source: Path = row["path"]
    digest = hashlib.sha1(f"{source.resolve()}:{source.stat().st_size}:{source.stat().st_mtime_ns}".encode()).hexdigest()[:16]
    PROXIES.mkdir(parents=True, exist_ok=True)
    proxy = PROXIES / f"{digest}.mp4"
    if proxy.exists():
        return proxy
    subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(source), "-vf", "scale=-2:480", "-c:v", "libx264", "-preset", "veryfast", "-crf", "34", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", "-y", str(proxy)],
        check=True,
        timeout=600,
    )
    return proxy


def prompt_for() -> str:
    return "\n".join([
        "The first video is the candidate. The second is a known LOL reference. The third is a known NOT_FUNNY reference.",
        "Justin is the reviewer and does not appear in these videos; the streamer is Peanut.",
        "Predict Justin's reaction by comparing the candidate to both references, not by applying generic content-quality standards.",
        "LOL requires a distinctive premise, sustained social/semantic escalation, and a real payoff. Activity, yelling, combat, profanity, randomness, or one mildly amusing line are NOT enough. When uncertain, choose NOT_FUNNY.",
        'Return JSON only: {"label":"LOL or NOT_FUNNY","lol_probability":0.0,"reason":"one sentence comparing the candidate to both references"}',
    ])


def upload_file(key: str, path: Path) -> dict:
    start = requests.post(
        "https://generativelanguage.googleapis.com/upload/v1beta/files",
        headers={
            "x-goog-api-key": key,
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(path.stat().st_size),
            "X-Goog-Upload-Header-Content-Type": "video/mp4",
            "Content-Type": "application/json",
        },
        json={"file": {"display_name": "candidate.mp4"}},
        timeout=60,
    )
    start.raise_for_status()
    upload_url = start.headers["x-goog-upload-url"]
    with path.open("rb") as handle:
        finish = requests.post(
            upload_url,
            headers={"X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "Content-Length": str(path.stat().st_size)},
            data=handle,
            timeout=300,
        )
    finish.raise_for_status()
    return finish.json()["file"]


def wait_for_file(key: str, uploaded: dict) -> dict:
    while True:
        response = requests.get(f"https://generativelanguage.googleapis.com/v1beta/{uploaded['name']}", headers={"x-goog-api-key": key}, timeout=60)
        response.raise_for_status()
        current = response.json()
        state = current.get("state")
        if state == "ACTIVE":
            return current
        if state == "FAILED":
            raise RuntimeError(f"Gemini processing failed: {uploaded['name']}")
        time.sleep(2)


def judge(key: str, candidate: dict, positive: dict, negative: dict) -> str:
    file_part = lambda uploaded: {"file_data": {"mime_type": uploaded["mimeType"], "file_uri": uploaded["uri"]}}
    response = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent",
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
        json={
            "contents": [{"role": "user", "parts": [file_part(candidate), file_part(positive), file_part(negative), {"text": prompt_for()}]}],
            "generationConfig": {"temperature": 0.0, "responseMimeType": "application/json"},
        },
        timeout=300,
    )
    response.raise_for_status()
    return response.json()["candidates"][0]["content"]["parts"][0]["text"]


def delete_file(key: str, uploaded: dict) -> None:
    requests.delete(f"https://generativelanguage.googleapis.com/v1beta/{uploaded['name']}", headers={"x-goog-api-key": key}, timeout=60).raise_for_status()


def parse_json(text: str) -> dict:
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        raise ValueError(f"No JSON object in: {text[:200]}")
    value = json.loads(match.group(0))
    if value.get("label") not in {"LOL", "NOT_FUNNY"}:
        raise ValueError(f"Invalid label: {value.get('label')}")
    value["lol_probability"] = min(1.0, max(0.0, float(value["lol_probability"])))
    return value


def metrics(results: list[dict]) -> dict:
    valid = [row for row in results if "error" not in row]
    correct = sum(row["label"] == row["predicted"] for row in valid)
    positives = [row for row in valid if row["label"] == "LOL"]
    negatives = [row for row in valid if row["label"] == "NOT_FUNNY"]
    top5 = sorted(valid, key=lambda row: row["lol_probability"], reverse=True)[:5]
    return {
        "evaluated": len(valid),
        "accuracy": correct / len(valid) if valid else 0.0,
        "positiveRecall": sum(row["predicted"] == "LOL" for row in positives) / len(positives) if positives else 0.0,
        "negativeSpecificity": sum(row["predicted"] == "NOT_FUNNY" for row in negatives) / len(negatives) if negatives else 0.0,
        "knownWinnersInTop5": sum(row["label"] == "LOL" for row in top5),
        "gatePassed": len(valid) == 16 and correct / len(valid) >= 0.80 and sum(row["label"] == "LOL" for row in top5) >= 4,
    }


def self_check() -> None:
    sample = [
        {"label": "LOL", "predicted": "LOL", "lol_probability": 0.9},
        {"label": "NOT_FUNNY", "predicted": "NOT_FUNNY", "lol_probability": 0.1},
    ]
    result = metrics(sample)
    assert result["accuracy"] == 1.0 and result["knownWinnersInTop5"] == 1
    assert parse_json('{"label":"LOL","lol_probability":1.2,"reason":"x"}')["lol_probability"] == 1.0
    print("PASS contrastive taste gate self-check")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return
    rows = labeled_clips()
    key = env_key()
    uploaded: dict[str, dict] = {}
    results = []
    try:
        for index, row in enumerate(rows, 1):
            uploaded[row["id"]] = wait_for_file(key, upload_file(key, proxy_for(row)))
            print(f"uploaded {index}/{len(rows)}", flush=True)
        for index, row in enumerate(rows, 1):
            try:
                positive = next(item for item in rows if item is not row and item["label"] == "LOL")
                negative = next(item for item in rows if item is not row and item["label"] == "NOT_FUNNY")
                verdict = parse_json(judge(key, uploaded[row["id"]], uploaded[positive["id"]], uploaded[negative["id"]]))
                result = {"id": row["id"], "label": row["label"], "predicted": verdict["label"], "lol_probability": verdict["lol_probability"], "reason": verdict.get("reason", "")}
            except Exception as error:
                result = {"id": row["id"], "label": row["label"], "error": str(error)}
            results.append(result)
            atomic_json(REPORT, {"version": 2, "model": MODEL, "results": results, "metrics": metrics(results)})
            print(f"{index}/{len(rows)} {row['label']} -> {result.get('predicted', 'ERROR')}", flush=True)
            time.sleep(2)
    finally:
        for item in uploaded.values():
            try:
                delete_file(key, item)
            except Exception:
                pass
    report = {"version": 2, "model": MODEL, "results": results, "metrics": metrics(results)}
    atomic_json(REPORT, report)
    print(json.dumps(report["metrics"], indent=2))


if __name__ == "__main__":
    main()
