#!/usr/bin/env bash
set -euo pipefail
cd 'C:/Users/Justi/OneDrive/Documents/Projects/Streamer-Clipping'
# Persist 72h+ owned-upload outcomes, then retrain/re-evaluate the ranker.
npx tsx packages/clips/src/analytics.ts --all --since 14 --feedback --json >/dev/null
python scripts/autonomous-ranker.py rank >/dev/null
