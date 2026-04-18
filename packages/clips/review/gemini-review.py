"""
gemini-review.py — watches rendered 9:16 Shorts with Google Gemini and
emits a JSON verdict per clip (PASS / NEEDS_TRIM / NEEDS_RECUT / SKIP)
plus trim suggestions for the content-end.

Generalized from the job-006 one-off. Takes the job dir as the first CLI
arg; optional second arg is a comma-separated list of clip numbers.

Usage:
  python gemini-review.py <job-dir>
  python gemini-review.py <job-dir> 1,2,5
  python gemini-review.py <job-dir> --all          # every .mp4 in shorts/

Env:
  GEMINI_API_KEY   required
  GEMINI_MODEL     optional, default gemini-2.5-flash

Output:
  <job-dir>/gemini-reviews.json
"""

import os
import sys
import time
import glob
import json
from google import genai
from google.genai import types

API_KEY = os.environ.get("GEMINI_API_KEY", "")
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

REVIEW_PROMPT = """You are a YouTube Shorts quality reviewer. Watch and LISTEN to this rendered 9:16 Short carefully.

**Clip context:** {description}
**Hook text:** {hook}

Review these aspects and respond ONLY with this JSON (no markdown fences, no extra text):

```json
{{
  "audio_timing": {{
    "starts_clean": <true/false>,
    "ends_clean": <true/false>,
    "mid_sentence_cut": <true/false>,
    "trim_start_seconds": <0 if clean, or number of seconds to trim from the start>,
    "trim_end_seconds": <0 if clean; positive to trim from end, negative to extend by that many seconds>,
    "ending_description": "<what's happening in the last 3 seconds of audio>"
  }},
  "flash_segment": {{
    "effective": <true/false>,
    "matches_peak": <true/false>,
    "suggestion": "<'good' or what to change>"
  }},
  "hook_text": {{
    "visible": <true/false>,
    "readable": <true/false>,
    "matches_content": <true/false>
  }},
  "content_quality": {{
    "score": <1-10>,
    "pacing": "<too fast / good / too slow / needs trimming>",
    "best_moment_timestamp": "<MM:SS>",
    "weakest_section": "<description or 'none'>"
  }},
  "caption_readiness": {{
    "speech_clear": <true/false>,
    "overlapping_speakers": <true/false>,
    "caption_notes": "<brief>"
  }},
  "overall_verdict": "<PASS / NEEDS_TRIM / NEEDS_RECUT / SKIP>",
  "action_items": ["<specific action>"],
  "notes": "<optional, max 2 sentences>"
}}
```

RULES:
- The #1 issue on gaming clips is mid-sentence cuts. If the last word is incomplete or the clip trails off, mark NEEDS_TRIM and set trim_end_seconds to a negative number (extend by that many seconds).
- If the ending is fine but the clip is too long with dead air, use a positive trim_end_seconds.
- If content isn't funny enough, mark SKIP. If the whole clip is broken, NEEDS_RECUT.
- PASS = ready to upload with no changes."""


def wait_for_file(client, file):
    while True:
        f = client.files.get(name=file.name)
        if f.state.name == "ACTIVE":
            return f
        if f.state.name == "FAILED":
            raise Exception(f"File processing failed: {f.name}")
        time.sleep(5)


def review_clip(client, clip_path, description, hook):
    print(f"    Uploading {os.path.basename(clip_path)}...")
    uploaded = client.files.upload(file=clip_path)
    uploaded = wait_for_file(client, uploaded)
    prompt = REVIEW_PROMPT.format(description=description, hook=hook)

    try:
        response = client.models.generate_content(
            model=MODEL,
            contents=[
                types.Content(
                    role="user",
                    parts=[
                        types.Part.from_uri(file_uri=uploaded.uri, mime_type=uploaded.mime_type),
                        types.Part.from_text(text=prompt),
                    ],
                )
            ],
            config=types.GenerateContentConfig(
                system_instruction="You are a precise video quality reviewer. Respond ONLY with valid JSON, no markdown fences, no extra text.",
                temperature=0.1,
            ),
        )
        try:
            client.files.delete(name=uploaded.name)
        except Exception:
            pass

        text = response.text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1]
            if text.endswith("```"):
                text = text[:-3]
            elif "```" in text:
                text = text[: text.rfind("```")]
        return json.loads(text.strip())
    except json.JSONDecodeError as e:
        return {"error": f"JSON parse error: {e}", "raw": response.text[:500]}
    except Exception as e:
        return {"error": str(e)}


def load_metadata(job_dir):
    """Parse upload-metadata.md for descriptions and hooks. Returns {num: {description, hook}}."""
    md_path = os.path.join(job_dir, "upload-metadata.md")
    clips = {}
    current_num = None
    current = {}
    if not os.path.exists(md_path):
        return clips
    with open(md_path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip()
            if line.startswith("## ") and " -- " in line:
                if current_num and current:
                    clips[current_num] = current
                parts = line[3:].split(" -- ", 1)
                current_num = parts[0].strip()
                current = {"description": parts[1].strip() if len(parts) > 1 else "", "hook": ""}
            elif line.startswith("**Hook Text Line 1:**"):
                current["hook_line1"] = line.split(":", 1)[1].strip()
            elif line.startswith("**Hook Text Line 2:**"):
                current["hook_line2"] = line.split(":", 1)[1].strip()
                current["hook"] = f"{current.get('hook_line1', '')} {current['hook_line2']}"
    if current_num and current:
        clips[current_num] = current
    return clips


def main():
    if not API_KEY:
        print("ERROR: set GEMINI_API_KEY", file=sys.stderr)
        sys.exit(1)
    if len(sys.argv) < 2:
        print("Usage: gemini-review.py <job-dir> [clip-nums|--all]", file=sys.stderr)
        sys.exit(1)

    job_dir = sys.argv[1]
    if not os.path.isdir(job_dir):
        print(f"ERROR: job dir not found: {job_dir}", file=sys.stderr)
        sys.exit(1)

    shorts_dir = os.path.join(job_dir, "shorts")
    if not os.path.isdir(shorts_dir):
        print(f"ERROR: shorts dir not found: {shorts_dir}", file=sys.stderr)
        sys.exit(1)

    # Determine which clips to review
    filter_arg = sys.argv[2] if len(sys.argv) > 2 else "--all"
    if filter_arg == "--all":
        shorts = sorted(glob.glob(os.path.join(shorts_dir, "*.mp4")))
    else:
        nums = [n.strip().zfill(2) for n in filter_arg.split(",")]
        shorts = []
        for n in nums:
            shorts.extend(sorted(glob.glob(os.path.join(shorts_dir, f"{n}-*.mp4"))))

    if not shorts:
        print("No shorts found to review", file=sys.stderr)
        sys.exit(1)

    client = genai.Client(api_key=API_KEY)
    metadata = load_metadata(job_dir)

    print(f"Reviewing {len(shorts)} Shorts with Gemini ({MODEL})")
    all_reviews = []
    for i, short_path in enumerate(shorts):
        basename = os.path.splitext(os.path.basename(short_path))[0]
        num = basename.split("-")[0]
        meta = metadata.get(num, {})
        desc = meta.get("description", basename)
        hook = meta.get("hook", "")

        print(f"[{i+1}/{len(shorts)}] {basename}")
        review = review_clip(client, short_path, desc, hook)
        review["clip"] = basename
        review["num"] = num
        all_reviews.append(review)

        if "error" not in review:
            v = review.get("overall_verdict", "?")
            score = review.get("content_quality", {}).get("score", "?")
            trim_end = review.get("audio_timing", {}).get("trim_end_seconds", 0)
            print(f"    Verdict: {v} | Score: {score}/10 | trim_end: {trim_end}s")
        else:
            print(f"    ERROR: {review['error']}")

        if i < len(shorts) - 1:
            time.sleep(5)  # gentle rate limit

    out_path = os.path.join(job_dir, "gemini-reviews.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(all_reviews, f, indent=2)
    print(f"\nWrote {out_path}")

    # Summary counts
    counts = {"PASS": 0, "NEEDS_TRIM": 0, "NEEDS_RECUT": 0, "SKIP": 0, "ERROR": 0}
    for r in all_reviews:
        if "error" in r:
            counts["ERROR"] += 1
        else:
            counts[r.get("overall_verdict", "ERROR")] = counts.get(r.get("overall_verdict", "ERROR"), 0) + 1
    print(
        f"PASS={counts['PASS']} NEEDS_TRIM={counts['NEEDS_TRIM']} "
        f"NEEDS_RECUT={counts['NEEDS_RECUT']} SKIP={counts['SKIP']} ERROR={counts['ERROR']}"
    )


if __name__ == "__main__":
    main()
