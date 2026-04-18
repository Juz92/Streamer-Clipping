"""
diarize.py — speaker diarization via pyannote.audio.

Emits JSON turn segments: [{"start": <sec>, "end": <sec>, "speaker": "SPEAKER_00"}].

Usage:
  python diarize.py <audio-or-video-path> <output-json>

Requires:
  pip install pyannote.audio
  HF_TOKEN env var with access to pyannote/speaker-diarization-3.1
  (accept terms at https://huggingface.co/pyannote/speaker-diarization-3.1)
"""

import os
import sys
import json


def main():
    if len(sys.argv) < 3:
        print("Usage: diarize.py <audio-or-video> <output.json>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    out_path = sys.argv[2]

    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        print("ERROR: HF_TOKEN env var not set", file=sys.stderr)
        sys.exit(2)

    try:
        from pyannote.audio import Pipeline
    except ImportError:
        print("ERROR: pyannote.audio not installed (pip install pyannote.audio)", file=sys.stderr)
        sys.exit(3)

    try:
        pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token,
        )
    except Exception as e:
        print(f"ERROR: failed to load pipeline: {e}", file=sys.stderr)
        sys.exit(4)

    try:
        diarization = pipeline(audio_path)
    except Exception as e:
        print(f"ERROR: inference failed: {e}", file=sys.stderr)
        sys.exit(5)

    turns = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        turns.append(
            {
                "start": round(turn.start, 3),
                "end": round(turn.end, 3),
                "speaker": speaker,
            }
        )

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(turns, f, indent=2)
    print(f"Wrote {len(turns)} turns to {out_path}")


if __name__ == "__main__":
    main()
