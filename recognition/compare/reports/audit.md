# Benchmark audit — not cleared for slides

This audit checks saved evidence and corrects acceptance metrics. It does not validate real guest accuracy or authorize a model replacement.

Checked at 2026-10-11T00:00:43+00:00.

Index: 1555 clips; 1105 in-vocabulary and 450 outside-vocabulary clips.
Index errors: 0. Source-label mismatches: 0. Missing source files: 0.

## Saved legacy run completeness (data/compare/track_a)

| System | C7 | R8 |
|---|---|---|
| ours_gru | 1330/1330 (complete) | 1330/1330 (complete) |
| ours_baseline | 1330/1330 (complete) | 1330/1330 (complete) |
| islr1st_ourfeat | 1330/1330 (complete) | 1330/1330 (complete) |
| islr1st_retrained | 1330/1330 (complete) | 1330/1330 (complete) |
| islr1st_pretrained | 1330/1330 (complete) | 1330/1330 (complete) |

## Pretrained reference, exploratory re-reading of the saved outputs

GISLR rerun set, 7 shared signs, in-vocabulary clips only; signer-held-out by participant ID only (identity unverified). Not pre-registered; the sum rule is the one PROTOCOL.md fixes for future reports. 95% CI over signers.

| signers | reading | #signers | #clips | top-1 [95% CI] |
|---|---|---|---|---|
| all 10 | C7 forced choice | 10 | 1105 | 0.979 [0.957, 0.992] |
| all 10 | R8, sum rule (pre-specified) | 10 | 1105 | 0.823 [0.725, 0.890] |
| all 10 | R8, max-other (post hoc) | 10 | 1105 | 0.900 [0.845, 0.938] |
| private 6 | C7 forced choice | 6 | 737 | 0.980 [0.948, 0.996] |
| private 6 | R8, sum rule (pre-specified) | 6 | 737 | 0.866 [0.765, 0.934] |
| private 6 | R8, max-other (post hoc) | 6 | 737 | 0.925 [0.869, 0.965] |

Protocol run folder `data/compare/track_a_v1`: 0 of 41 manifests present.

## Findings that prevent release

- Pretrained reference provenance: SEPARATE by participant ID (none of its 21 training IDs is one of the 10 test IDs); that IDs are different people is UNVERIFIED; 4 test signers (public leaderboard) influenced the winner's model selection. It may only appear as a separately labelled reference, never as a matched comparison.
- Pretrained OOV rejection is not a matched unseen-vocabulary test: all 30 outside signs belong to its original 250-label training vocabulary. PROTOCOL.md excludes it from every OOV comparison.
- The pretrained max-other rejection rule was selected after comparing results. PROTOCOL.md pre-specifies the sum rule; max-other is exploratory only.
- Legacy islr1st_retrained used a fixed 60 epochs informed by a global pilot whose validation signer (48118) is an outer test fold. PROTOCOL.md replaces it with nested per-fold early stopping; the legacy run must not be reported.
- Track A omits the live segmenter and framing gate and covers only seven hotel-vocabulary signs, not the 22-class product.
- Track B has no real held-out hotel-sign recordings. The extractor now uses the capture-parity path, but no result exists until recordings are made.
- The legacy runs did not store per-job manifests; the protocol report refuses them. A protocol re-run is required before any figure is used.

## Metric corrections

- Coverage and accuracy on accepted answers now exclude NONE, including confident refusals. The earlier report counted them as spoken answers.
- Saved confidence values are no longer rounded before applying the 0.6 threshold. Historical predictions remain rounded; check boundary cases before using them.
- Paired comparisons reject duplicate clip IDs and inconsistent signer, label, or OOV metadata.
- A nondefault rejection threshold now applies consistently to open-set confidence intervals and per-sign rates.
- The pretrained R8 max-other vector is a score vector, not a normalized probability distribution; its ECE is suppressed.

## Decision

Keep the existing product model architecture. Do not adopt the winner architecture on the basis of the legacy comparison. Re-run Track A under PROTOCOL.md (manifests, nested tuning), and record and freeze a new held-out signer test for Track B before making product accuracy claims.

## Sources

- Kaggle rerun-set metadata (sohier/461054610546105, CC0, created by Kaggle staff 2023-02-17); its Usage column gives the public (6927, 11696, 14938, 23662) and private (2455, 11672, 15662, 32536, 34304, 48118) leaderboard signers.
- Local evidence: data/compare/track_a/index.json, preds/, models/, pilot_partial.log; data/gislr_raw/labels.parqet. Artifact hashes and check results are in audit.json.
- [Published model provenance](https://huggingface.co/sign/kaggle-asl-signs-1st-place).
- [Original winning implementation](https://github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution).
- [Dataset-creator paper](https://papers.nips.cc/paper_files/paper/2023/file/00dada608b8db212ea7d9d92b24c68de-Paper-Datasets_and_Benchmarks.pdf). The later PopSign release has a different population and split; it does not itself prove the identity mapping for this rerun set.
