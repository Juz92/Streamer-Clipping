"""Collect Gemini Embedding 2 vectors for outcome-labelled official Shorts.

Videos are downloaded one at a time to the system temp directory and deleted
immediately after embedding. Completed embeddings are cached for resumability.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
TRAINING = ROOT / "data/clips/training/official-shorts"
SAMPLE = TRAINING / "sample.json"
CACHE = TRAINING / "video-embeddings-gemini2"
MODEL = "gemini-embedding-2"
DIMENSIONS = 768


def env_key(name: str) -> str:
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError(f"{name} is not configured")


def download(short_id: str, temp_dir: Path) -> Path:
    template = str(temp_dir / f"{short_id}.%(ext)s")
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-warnings",
        "--no-playlist",
        "-f",
        "18/b[height<=360]/b",
        "-o",
        template,
        f"https://www.youtube.com/shorts/{short_id}",
    ]
    process = subprocess.run(command, capture_output=True, text=True, timeout=180)
    if process.returncode:
        raise RuntimeError((process.stdout + "\n" + process.stderr)[-1200:])
    matches = [path for path in temp_dir.glob(f"{short_id}.*") if path.is_file()]
    if not matches:
        raise RuntimeError("yt-dlp returned success without an output file")
    return max(matches, key=lambda path: path.stat().st_size)


def embed(video: Path, key: str) -> list[float]:
    mime = mimetypes.guess_type(video.name)[0] or "video/mp4"
    body = {
        "model": f"models/{MODEL}",
        "content": {
            "parts": [
                {
                    "inline_data": {
                        "mime_type": mime,
                        "data": base64.b64encode(video.read_bytes()).decode("ascii"),
                    }
                }
            ]
        },
        "outputDimensionality": DIMENSIONS,
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:embedContent"
    last_error = ""
    for attempt in range(8):
        response = requests.post(url, headers={"x-goog-api-key": key}, json=body, timeout=300)
        if response.ok:
            return response.json()["embedding"]["values"]
        last_error = f"{response.status_code}: {response.text[:900]}"
        if response.status_code != 429:
            break
        time.sleep(min(70, 8 * (attempt + 1)))
    raise RuntimeError(last_error)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0, help="Process at most this many uncached items")
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    items = json.loads(SAMPLE.read_text(encoding="utf-8"))["items"]
    key = env_key("GEMINI_API_KEY")
    completed = 0
    errors = []
    with tempfile.TemporaryDirectory(prefix="official-shorts-") as raw_temp:
        temp_dir = Path(raw_temp)
        for index, item in enumerate(items, 1):
            output = CACHE / f"{item['id']}.json"
            if output.exists():
                continue
            if args.limit and completed >= args.limit:
                break
            video = None
            try:
                video = download(item["id"], temp_dir)
                values = embed(video, key)
                output.write_text(
                    json.dumps(
                        {
                            "version": 1,
                            "model": MODEL,
                            "dimensions": DIMENSIONS,
                            "id": item["id"],
                            "label": item["label"],
                            "views": item["views"],
                            "recencyBlock": item["recencyBlock"],
                            "values": values,
                        }
                    ),
                    encoding="utf-8",
                )
                completed += 1
                print(f"[{index}/{len(items)}] cached {item['id']} {item['label']}", flush=True)
            except Exception as error:
                errors.append({"id": item["id"], "error": str(error)})
                print(f"[{index}/{len(items)}] ERROR {item['id']}: {error}", flush=True)
            finally:
                for path in temp_dir.glob(f"{item['id']}.*"):
                    path.unlink(missing_ok=True)
    report = {
        "sampleItems": len(items),
        "cached": len(list(CACHE.glob("*.json"))),
        "completedThisRun": completed,
        "errors": errors,
    }
    (TRAINING / "video-embedding-collection-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
