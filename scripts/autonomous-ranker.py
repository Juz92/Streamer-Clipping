"""Enrich, learn, and shadow-rank Streamer-Clipping candidates."""
from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import math
import os
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import requests
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import precision_score
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
CLIPS = ROOT / "data/clips"
POOL = CLIPS / "candidate-pool.json"
EMBED_CACHE = CLIPS / "training/candidate-video-embeddings"
OFFICIAL_EMBEDS = CLIPS / "training/official-shorts/video-embeddings-gemini2"
MODEL = "gemini-embedding-2"
FEATURES = ["chat", "video", "transcript", "audio"]


def load_module(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(module)
    return module


CAPTIONS = load_module("outcome_ranker", "scripts/benchmark-outcome-ranker.py")
CHAT = load_module("chat_signals", "scripts/benchmark-twitch-chat-signals.py")
SIGNALS = load_module("autonomous_signals", "scripts/benchmark-autonomous-signals.py")


def env_key(name: str) -> str:
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise RuntimeError(f"{name} is not configured")


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temp, path)


def normalize(vector: np.ndarray) -> np.ndarray:
    return vector / max(float(np.linalg.norm(vector)), 1e-9)


def official_centres() -> tuple[np.ndarray, np.ndarray]:
    rows = [json.loads(path.read_text(encoding="utf-8")) for path in OFFICIAL_EMBEDS.glob("*.json")]
    high = [normalize(np.asarray(row["values"], dtype=np.float32)) for row in rows if row["label"] == "high"]
    low = [normalize(np.asarray(row["values"], dtype=np.float32)) for row in rows if row["label"] == "low"]
    if not high or not low:
        raise RuntimeError("Official Gemini embedding labels are incomplete")
    return normalize(np.mean(high, axis=0)), normalize(np.mean(low, axis=0))


def embed_video(path: Path, key: str) -> np.ndarray:
    body = {
        "model": f"models/{MODEL}",
        "content": {"parts": [{"inline_data": {"mime_type": "video/mp4", "data": base64.b64encode(path.read_bytes()).decode("ascii")}}]},
        "outputDimensionality": 768,
    }
    response = requests.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:embedContent",
        headers={"x-goog-api-key": key},
        json=body,
        timeout=300,
    )
    response.raise_for_status()
    return np.asarray(response.json()["embedding"]["values"], dtype=np.float32)


def embedding_cache_path(candidate: dict) -> Path:
    # ponytail: moment IDs are reused after --force; source bounds make cache identity stable.
    start = round(float(candidate["startSec"]) * 1000)
    end = round(float(candidate["endSec"]) * 1000)
    return EMBED_CACHE / f"{candidate['jobId']}__{candidate['momentId']}__{start}-{end}.json"


def candidate_embedding(candidate: dict, manifest: dict, key: str) -> np.ndarray:
    cache = embedding_cache_path(candidate)
    if cache.exists():
        return np.asarray(json.loads(cache.read_text(encoding="utf-8"))["values"], dtype=np.float32)
    with tempfile.TemporaryDirectory(prefix="candidate-embed-") as directory:
        proxy = Path(directory) / "clip.mp4"
        duration = max(1.0, float(candidate["endSec"]) - float(candidate["startSec"]))
        subprocess.run(
            ["ffmpeg", "-nostdin", "-loglevel", "error", "-ss", str(candidate["startSec"]), "-i", manifest["videoPath"],
             "-t", str(duration), "-vf", "scale=-2:360,fps=8", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-y", str(proxy)],
            check=True,
            timeout=180,
        )
        values = embed_video(proxy, key)
    atomic_json(cache, {"model": MODEL, "jobId": candidate["jobId"], "momentId": candidate["momentId"], "values": values.tolist()})
    return values


def audio_timeline(path: Path) -> tuple[np.ndarray, np.ndarray]:
    times, levels, timestamp = [], [], None
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        match = re.search(r"pts_time:([0-9.]+)", line)
        if match:
            timestamp = float(match.group(1))
        elif timestamp is not None and "RMS_level=" in line:
            raw = line.rsplit("=", 1)[-1].strip()
            times.append(timestamp)
            levels.append(-100.0 if raw == "-inf" else float(raw))
    return np.asarray(times), np.asarray(levels)


def audio_score(times: np.ndarray, levels: np.ndarray, start: float, end: float) -> float:
    values = levels[(times >= start) & (times <= end)]
    if len(values) < 2:
        return 0.0
    return float(np.percentile(values, 95) - np.percentile(values, 5) + np.mean(np.abs(np.diff(values))))


def run_json(command: list[str], timeout: int = 180) -> dict:
    result = subprocess.run(command, capture_output=True, text=True, check=True, timeout=timeout)
    return json.loads(result.stdout)


def youtube_metadata(stream_id: str) -> dict:
    path = CLIPS / f"{stream_id}-youtube-metadata.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    data = run_json(["python", "-m", "yt_dlp", "-J", "--skip-download", f"https://youtube.com/watch?v={stream_id}"])
    atomic_json(path, {name: data.get(name) for name in ("id", "title", "duration", "view_count", "comment_count", "timestamp", "release_timestamp")})
    return data


def resolve_twitch_vod(youtube: dict) -> dict:
    tolerance = float(os.environ.get("TWITCH_VOD_CLOCK_TOLERANCE_SEC", "120"))
    cached = [json.loads(path.read_text(encoding="utf-8")) for path in CLIPS.glob("twitch-vod-*.json")]
    match = min(cached, key=lambda row: abs(float(row.get("timestamp", 0)) - float(youtube["release_timestamp"])), default=None)
    if match and abs(float(match["timestamp"]) - float(youtube["release_timestamp"])) <= tolerance:
        return match

    # ponytail: latest 20 archives covers a new VOD; raise instead of guessing if it falls outside that window.
    archives = run_json([
        "python", "-m", "yt_dlp", "--flat-playlist", "--dump-single-json", "--playlist-items", "1:20",
        "https://www.twitch.tv/theburntpeanut/videos?filter=archives&sort=time",
    ])
    for entry in archives.get("entries", []):
        twitch_id = str(entry.get("id", "")).lstrip("v")
        if not twitch_id:
            continue
        path = CLIPS / f"twitch-vod-{twitch_id}.json"
        metadata = json.loads(path.read_text(encoding="utf-8")) if path.exists() else run_json([
            "python", "-m", "yt_dlp", "-J", "--skip-download", f"https://www.twitch.tv/videos/{twitch_id}",
        ])
        if not path.exists():
            atomic_json(path, metadata)
        twitch_time = metadata.get("timestamp")
        if twitch_time is not None and abs(float(twitch_time) - float(youtube["release_timestamp"])) <= tolerance:
            return metadata
        if twitch_time is not None and float(twitch_time) < float(youtube["release_timestamp"]) - 86_400:
            break
    raise RuntimeError(f"No Twitch archive starts within {tolerance:g}s of YouTube {youtube['id']}")


def ensure_chat(twitch_id: str) -> Path:
    path = CLIPS / f"training/twitch-chat/full/{twitch_id}.json"
    if path.exists():
        return path
    if os.environ.get("TWITCH_DOWNLOADER_CLI"):
        executable = Path(os.environ["TWITCH_DOWNLOADER_CLI"])
    else:
        # ponytail: stable install first; Temp is only a backwards-compatible fallback.
        executable = Path.home() / "AppData/Local/TwitchDownloaderCLI-1.56.4/TwitchDownloaderCLI.exe"
        if not executable.exists():
            executable = Path(tempfile.gettempdir()) / "TwitchDownloaderCLI-1.56.4/TwitchDownloaderCLI.exe"
    if not executable.exists():
        raise RuntimeError(f"TwitchDownloaderCLI not found: {executable}; set TWITCH_DOWNLOADER_CLI")
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([
        str(executable), "chatdownload", "-u", twitch_id, "-o", str(path), "--collision", "Overwrite",
        "--threads", "4", "--banner", "false", "--log-level", "Error",
    ], check=True, timeout=1200)
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload.get("comments"), list):
        path.unlink(missing_ok=True)
        raise RuntimeError(f"Invalid Twitch chat output for {twitch_id}")
    return path


def stream_chat(stream_id: str) -> tuple[list[dict], float]:
    youtube = youtube_metadata(stream_id)
    twitch = resolve_twitch_vod(youtube)
    offset = float(youtube["release_timestamp"]) - float(twitch["timestamp"])
    twitch_id = str(twitch["id"]).lstrip("v")
    payload = json.loads(ensure_chat(twitch_id).read_text(encoding="utf-8"))
    return payload.get("comments", []), offset


def robust_z(values: list[float]) -> list[float]:
    array = np.asarray(values, dtype=float)
    median = float(np.median(array))
    scale = float(np.median(np.abs(array - median))) or float(np.std(array)) or 1.0
    return ((array - median) / scale).tolist()


def enrich(embed_limit: int) -> dict:
    pool = json.loads(POOL.read_text(encoding="utf-8"))
    positive, negative = official_centres()
    key = env_key("GEMINI_API_KEY")
    embedded = 0
    jobs = {candidate["jobId"] for candidate in pool["candidates"]}
    for job_id in jobs:
        job = CLIPS / job_id
        manifest = json.loads((job / "manifest.json").read_text(encoding="utf-8"))
        vtt = Path(manifest["subtitlePath"])
        audio_times, audio_levels = audio_timeline(Path(manifest["audioLevelsPath"]))
        comments, offset = stream_chat(manifest["streamId"])
        for candidate in [row for row in pool["candidates"] if row["jobId"] == job_id]:
            start, end = float(candidate["startSec"]), float(candidate["endSec"])
            text = CAPTIONS.interval_vtt(vtt, start, end)
            transcript = SIGNALS.transcript_features(text, end - start)
            chat = CHAT.extract({"twitchStart": start + offset, "twitchEnd": end + offset}, comments)
            features = candidate.setdefault("autonomousFeatures", {})
            features["transcript"] = float(candidate.get("viralScore", 0)) / 100 + transcript["wordsPerSec"] + 0.1 * transcript["questionCount"]
            features["audio"] = audio_score(audio_times, audio_levels, start, end)
            features["chat"] = float(np.mean([math.log1p(max(0.0, chat[name])) for name in ("chatRateLift", "laughRateLift", "emoteRateLift", "peak5sLift")]))
            cache = embedding_cache_path(candidate)
            was_cached = cache.exists()
            if was_cached or not embed_limit or embedded < embed_limit:
                vector = normalize(candidate_embedding(candidate, manifest, key))
                features["video"] = float(vector @ positive - vector @ negative)
                embedded += int(not was_cached)
            features["version"] = 1
    atomic_json(POOL, pool)
    return {"candidates": len(pool["candidates"]), "newEmbeddings": embedded}


def performance_value(candidate: dict) -> float | None:
    row = candidate.get("youtubePerformance")
    if not row or not row.get("mature72h"):
        return None
    return float(row.get("averageViewPercentage", 0)) / 100 + math.log1p(float(row.get("views", 0))) / 10 + math.log1p(float(row.get("shares", 0))) / 10


def rank() -> dict:
    pool = json.loads(POOL.read_text(encoding="utf-8"))
    complete = [row for row in pool["candidates"] if all(name in row.get("autonomousFeatures", {}) for name in FEATURES)]
    labelled = [(row, performance_value(row)) for row in complete]
    labelled = [(row, value) for row, value in labelled if value is not None]
    model, scaler, gate = None, None, {"status": "WAITING_FOR_LABELS", "matureLabels": len(labelled), "required": 10}
    if len(labelled) >= 10 and len({row["streamId"] for row, _ in labelled}) >= 2:
        values = np.asarray([value for _, value in labelled])
        labels = (values >= np.median(values)).astype(int)
        x = np.asarray([[row["autonomousFeatures"][name] for name in FEATURES] for row, _ in labelled])
        holdouts = []
        for stream_id in sorted({row["streamId"] for row, _ in labelled}):
            test = np.asarray([row["streamId"] == stream_id for row, _ in labelled])
            if test.sum() < 2 or (~test).sum() < 4 or len(set(labels[~test])) < 2:
                continue
            fold_scaler = StandardScaler().fit(x[~test])
            fold = LogisticRegression(C=0.25, class_weight="balanced", max_iter=2000).fit(fold_scaler.transform(x[~test]), labels[~test])
            scores = fold.predict_proba(fold_scaler.transform(x[test]))[:, 1]
            k = min(5, len(scores))
            selected = np.argsort(scores)[-k:]
            holdouts.append({"streamId": stream_id, "precisionAt5": float(labels[test][selected].mean()), "n": int(test.sum())})
        precision = min((row["precisionAt5"] for row in holdouts), default=0.0)
        gate = {"status": "PASS" if holdouts and precision >= 0.6 else "FAIL", "matureLabels": len(labelled), "precisionAt5": precision, "holdouts": holdouts}
        scaler = StandardScaler().fit(x)
        model = LogisticRegression(C=0.25, class_weight="balanced", max_iter=2000).fit(scaler.transform(x), labels)

    output = []
    for job_id in sorted({row["jobId"] for row in complete}):
        rows = [row for row in complete if row["jobId"] == job_id]
        matrix = np.asarray([[row["autonomousFeatures"][name] for name in FEATURES] for row in rows])
        if model is not None:
            scores = model.predict_proba(scaler.transform(matrix))[:, 1]
            mode = "learned"
        else:
            scores = np.mean(np.asarray([robust_z(matrix[:, index].tolist()) for index in range(matrix.shape[1])]), axis=0)
            mode = "shadow-equal-weight"
        ranked = sorted(
            [{"momentId": row["momentId"], "sourceStartSec": row["startSec"], "sourceEndSec": row["endSec"], "hook": row["hook"], "score": float(score)} for row, score in zip(rows, scores)],
            key=lambda row: row["score"], reverse=True,
        )
        promoted = False
        if gate["status"] == "PASS":
            moments_path = CLIPS / job_id / "notebooklm-moments.json"
            moments = json.loads(moments_path.read_text(encoding="utf-8"))
            by_id = {row.get("id"): row for row in moments}
            selected = [by_id[row["momentId"]] for row in ranked[:3] if row["momentId"] in by_id]
            if selected:
                atomic_json(moments_path, selected)
                promoted = True
        output.append({"jobId": job_id, "streamId": rows[0]["streamId"], "mode": mode, "promotedTop3": promoted, "top5": ranked[:5]})
    report = {"version": 1, "features": FEATURES, "gate": gate, "vods": output}
    atomic_json(CLIPS / "autonomous-ranker-report.json", report)
    return report


def self_check() -> None:
    assert robust_z([1, 2, 3]) == [-1.0, 0.0, 1.0]
    assert performance_value({"youtubePerformance": {"mature72h": False}}) is None
    first = {"jobId": "job", "momentId": "nlm-001", "startSec": 1, "endSec": 2}
    second = {**first, "startSec": 3}
    assert embedding_cache_path(first) != embedding_cache_path(second)
    youtube = youtube_metadata("wKJwi-MMLJQ")
    twitch = resolve_twitch_vod(youtube)
    assert str(twitch["id"]).lstrip("v") == "2811618871"
    assert ensure_chat("2811618871").stat().st_size > 0
    print("PASS autonomous-ranker self-check")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["enrich", "rank", "run", "self-check"])
    parser.add_argument("--embed-limit", type=int, default=0, help="0 means all uncached candidates")
    args = parser.parse_args()
    if args.command == "self-check":
        self_check()
        return
    if args.command in {"enrich", "run"}:
        print(json.dumps(enrich(args.embed_limit), indent=2))
    if args.command in {"rank", "run"}:
        print(json.dumps(rank(), indent=2))


if __name__ == "__main__":
    main()
