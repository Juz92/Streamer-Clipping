"""Validate the high-view Shorts reference bank."""
from __future__ import annotations

import json
import subprocess
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "data/clips/training/channel-positive-examples"


def main() -> None:
    bank = json.loads((ROOT / "reference-bank.json").read_text(encoding="utf-8"))
    humor = json.loads((ROOT / "comedy-positive-examples.json").read_text(encoding="utf-8"))
    rows = bank["examples"]

    assert len(rows) == 30 == len({row["id"] for row in rows})
    assert Counter(row["channel"] for row in rows) == {name: 5 for name in {
        "BurntPeanut_Daily", "TheBurntPeanutShorts", "GoatMilkPlays",
        "TheDailyBungulator", "TheBurntPeanut", "BurntPcanutClips",
    }}
    assert all(row["channel_rank"] in range(1, 6) for row in rows)
    assert all(row["transcript_segments"] and row["contact_sheets"] for row in rows)

    for row in rows:
        for key in ("video_path", "caption_path", "claude_watch_report"):
            assert (ROOT / row[key]).exists(), f"missing {key}: {row['id']}"
        subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(ROOT / row["video_path"])],
            check=True, capture_output=True, text=True, timeout=30,
        )

    strict = {row["id"] for row in rows if row["analysis"]["comedy_positive"] is True}
    assert strict == {row["id"] for row in humor["examples"]}
    assert bank["comedy_label_counts"] == {"true": 21, "mixed": 8, "false": 1}
    print("PASS: 30 performance positives; 21 strict comedy positives; all media/reports valid")


if __name__ == "__main__":
    main()
