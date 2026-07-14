"""Validate the source-aligned Stream Clipper gold corpus."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


BEAT_KEYS = (
    "setupStart",
    "premiseClear",
    "actionOrEscalationStart",
    "payoffStart",
    "payoffEnd",
    "reactionEnd",
)
TASTE_SCORES = {"lol": 1.0, "smiled": 0.5, "nothing": 0.0, "context-missing": 0.0}


def _number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_corpus(corpus: dict) -> None:
    if corpus.get("version") != 1 or not isinstance(corpus.get("records"), list):
        raise ValueError("corpus must have version 1 and a records list")
    seen: set[str] = set()
    records = corpus["records"]
    for index, record in enumerate(records):
        prefix = f"records[{index}]"
        candidate_id = record.get("candidateId")
        if not isinstance(candidate_id, str) or not candidate_id or candidate_id in seen:
            raise ValueError(f"{prefix} candidateId must be unique")
        seen.add(candidate_id)

        source = record.get("source")
        if not isinstance(source, dict) or not isinstance(source.get("streamId"), str):
            raise ValueError(f"{prefix} source must identify a stream")
        start, end = source.get("startSec"), source.get("endSec")
        if not _number(start) or not _number(end) or start < 0 or end <= start:
            raise ValueError(f"{prefix} has an invalid source window")

        provenance = record.get("provenance")
        if not isinstance(provenance, list) or not provenance:
            raise ValueError(f"{prefix} needs recall provenance")
        for evidence in provenance:
            if not isinstance(evidence, dict) or not isinstance(evidence.get("route"), str) or not isinstance(evidence.get("evidence"), str):
                raise ValueError(f"{prefix} has invalid recall provenance")

        allowed = {
            "kind": {None, "single-arc", "compilation"},
            "lane": {None, "conversation", "gameplay", "mixed"},
            "contextLevel": {None, "self-contained", "minor-context", "context-heavy"},
            "primaryEvidence": {None, "transcript", "audio", "visual", "chat", "multimodal"},
            "repetition": {None, "distinctive", "tactical-filler", "unknown"},
        }
        for field, values in allowed.items():
            if field not in record or record[field] not in values:
                raise ValueError(f"{prefix}.{field} is invalid")
        if "payoffType" not in record or (record["payoffType"] is not None and not isinstance(record["payoffType"], str)):
            raise ValueError(f"{prefix}.payoffType is invalid")
        if record.get("visualProofRequired") not in {None, True, False}:
            raise ValueError(f"{prefix}.visualProofRequired is invalid")

        beats = record.get("beats")
        if beats is not None:
            if not isinstance(beats, dict) or set(beats) != set(BEAT_KEYS) or not all(_number(beats[key]) for key in BEAT_KEYS):
                raise ValueError(f"{prefix}.beats is invalid")
            values = [beats[key] for key in BEAT_KEYS]
            if values != sorted(values) or values[0] < 0:
                raise ValueError(f"{prefix}.beats must be chronological")

        label = record.get("label")
        if not isinstance(label, dict) or label.get("decision") not in {"unreviewed", "keep", "reserve", "reject"}:
            raise ValueError(f"{prefix}.label is invalid")
        taste, taste_score = label.get("taste"), label.get("tasteScore")
        if taste is None:
            if taste_score is not None:
                raise ValueError(f"{prefix}.label tasteScore needs taste")
        elif taste not in TASTE_SCORES or taste_score != TASTE_SCORES[taste]:
            raise ValueError(f"{prefix}.label tasteScore does not match taste")
        if label.get("arcPass") not in {None, True, False}:
            raise ValueError(f"{prefix}.label arcPass is invalid")
        reason = label.get("rejectionReason")
        if reason is not None and not isinstance(reason, str):
            raise ValueError(f"{prefix}.label rejectionReason is invalid")
        if label["decision"] == "reject" and not reason:
            raise ValueError(f"{prefix}.label rejected records need a reason")

        boundary = record.get("correctedBoundary")
        if boundary is not None:
            if not isinstance(boundary, dict) or not _number(boundary.get("startSec")) or not _number(boundary.get("endSec")) or boundary["startSec"] < 0 or boundary["endSec"] <= boundary["startSec"]:
                raise ValueError(f"{prefix}.correctedBoundary is invalid")
        negative_of = record.get("negativeOfCandidateId")
        if negative_of is not None and not isinstance(negative_of, str):
            raise ValueError(f"{prefix}.negativeOfCandidateId is invalid")

    for index, record in enumerate(records):
        negative_of = record["negativeOfCandidateId"]
        if negative_of is not None and negative_of not in seen:
            raise ValueError(f"records[{index}] references an unknown negativeOfCandidateId")


def self_test() -> None:
    valid = {
        "version": 1,
        "records": [
            {
                "candidateId": "vod-01",
                "source": {"streamId": "vod", "startSec": 10, "endSec": 20},
                "provenance": [{"route": "current-recall", "evidence": "signal"}],
                "kind": "single-arc",
                "lane": "conversation",
                "payoffType": "reversal",
                "contextLevel": "self-contained",
                "visualProofRequired": False,
                "primaryEvidence": "audio",
                "repetition": "distinctive",
                "beats": {
                    "setupStart": 10,
                    "premiseClear": 12,
                    "actionOrEscalationStart": 14,
                    "payoffStart": 16,
                    "payoffEnd": 18,
                    "reactionEnd": 20,
                },
                "label": {
                    "decision": "keep",
                    "taste": "lol",
                    "tasteScore": 1.0,
                    "arcPass": True,
                    "rejectionReason": None,
                },
                "correctedBoundary": {"startSec": 10, "endSec": 20},
                "negativeOfCandidateId": None,
            }
        ],
    }
    validate_corpus(valid)
    reordered = json.loads(json.dumps(valid))
    reordered["records"][0]["beats"] = dict(reversed(list(reordered["records"][0]["beats"].items())))
    validate_corpus(reordered)
    broken = json.loads(json.dumps(valid))
    broken["records"][0]["source"]["endSec"] = 9
    try:
        validate_corpus(broken)
    except ValueError as error:
        assert "source window" in str(error)
    else:
        raise AssertionError("invalid source window was accepted")
    print("PASS gold corpus validator self-test")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", nargs="?", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if not args.path:
        parser.error("path is required unless --self-test is used")
    corpus = json.loads(args.path.read_text(encoding="utf-8"))
    validate_corpus(corpus)
    print(f"PASS gold corpus: {len(corpus['records'])} records")


if __name__ == "__main__":
    main()
