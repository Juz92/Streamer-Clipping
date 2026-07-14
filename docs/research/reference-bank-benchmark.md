# Reference-bank benchmark

## Question

Can the 21 strict high-view comedy references improve the known 6-winner / 10-hard-negative ranking benchmark without adding a new model or dependency?

## Results

| Method | AUC | Pairwise accuracy | Winners in top 5 | Pass |
|---|---:|---:|---:|---|
| TF-IDF nearest positive | 0.450 | 0.450 | 1 | No |
| TF-IDF logistic: public positives vs hard negatives | 0.233 | 0.233 | 0 | No |
| GPT-5.6 Luna with retrieved positive/negative references | 0.683 | 0.467 | 2 | No |

Pass required AUC ≥0.80, pairwise accuracy ≥0.75, and at least four winners in the top five.

## Decision

Do not integrate any method. Public high-view examples encode useful comedy patterns, but direct similarity still does not reproduce Justin's taste. Keep the bank for recall/rubric evidence and move to the pre-agreed 30-item blind corpus across three unseen VODs.

Artifacts: `scripts/benchmark-reference-bank.py` and `data/clips/training/channel-positive-examples/reference-bank-benchmark.json`.
