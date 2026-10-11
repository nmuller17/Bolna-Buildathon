# Transfer learning vs the team baseline: leave-one-signer-out, face-free

Created 2026-10-11T06:58:46+00:00. Test signers: cosme, maya, nath, roni (one fold each, 264 takes = 22 classes x 12). Talha is in every training set and is never a validation or test signer. Every system sees the same folds, the same takes, the same inner validation signer (chosen by recognition.train.split, seed 0) for early stopping and temperature (T >= 1), the same refit on all training signers, and the same 0.6 gate. All inputs are face-free (face = None, pose 1-10 replaced by the pose nose), as the live recognizer receives them.

**Not finished / not reported:** C, C0, D.

## Systems

| id | system |
|---|---|
| A | baseline (teammates', logistic regression) |
| B | SignGRU (ours) |

## Pooled over the 4 test signers (1,056 takes)

| metric | A | B |
|---|---|---|
| accuracy | 0.9167 | 0.9176 |
| top-3 | 0.9754 | 0.9782 |
| macro-F1 | 0.9148 | 0.9163 |
| wrong sign spoken @0.6 | 0.036 | 0.0246 |
| wrong sign spoken @0.6, T=1 | 0.0379 | 0.0246 |
| coverage @0.6 | 0.9299 | 0.8864 |
| accuracy on accepted | 0.9511 | 0.9712 |
| NONE false-accept (sign -> NONE) | 0.0188 | 0.0109 |
| NONE false-alarm (NONE -> sign, argmax) | 0.5417 | 0.3542 |
| NONE spoken as a sign @0.6 | 0.3542 | 0.1458 |
| ECE | 0.0285 | 0.102 |
| unknown sign spoken @0.6 (team, 3 groups of 7 left out) | 0.4951 | - |
| unknown sign spoken @0.6 (team, repo's one-sign-out) | 0.4445 | - |
| GISLR out-of-vocabulary clips spoken as a sign @0.6 (450 clips, 30 signs) | 0.1489 | 0.1806 |
| latency per segment p50 / p95 ms (CPU, 2 threads) | - | - |
| parameters | - | - |
| checkpoint size | - | - |

## B vs A

| metric | mean B - A | 95% CI (t, 4 folds) | 95% CI (bootstrap: folds, then takes) | sign-flip p (folds) | McNemar p (pooled takes) | folds where B is better | per fold |
|---|---|---|---|---|---|---|---|
| wrong sign spoken @0.6 (lower is better) | -0.0114 | [-0.0562, 0.0335] | [-0.0398, 0.0123] | 0.875 | 0.1114 | 2/4 | cosme -0.0038, maya -0.0530, nath +0.0038, roni +0.0076 |
| accuracy (higher is better) | 0.0009 | [-0.0559, 0.0578] | [-0.0322, 0.036] | 1.0 | 1.0 | 2/4 | cosme +0.0038, maya +0.0455, nath -0.0038, roni -0.0417 |

## Per fold

| system | test signer | inner val | epochs | T | accuracy | top-3 | macro-F1 | wrong spoken | coverage | GISLR OOV spoken |
|---|---|---|---|---|---|---|---|---|---|---|
| A | cosme | signer:roni | None | 1.0002 | 0.9735 | 0.9811 | 0.9703 | 0.0114 | 0.9621 | 0.1689 |
| A | maya | signer:roni | None | 1.0 | 0.8712 | 0.9432 | 0.8527 | 0.0606 | 0.9129 | 0.2378 |
| A | nath | signer:roni | None | 1.0 | 0.8636 | 0.9811 | 0.8501 | 0.0568 | 0.928 | 0.1333 |
| A | roni | signer:nath | None | 1.3255 | 0.9583 | 0.9962 | 0.9551 | 0.0152 | 0.9167 | 0.0556 |
| B | cosme | signer:roni | 22 | 1.0 | 0.9773 | 0.9848 | 0.9741 | 0.0076 | 0.9811 | 0.2044 |
| B | maya | signer:roni | 13 | 1.0 | 0.9167 | 0.9697 | 0.9012 | 0.0076 | 0.8523 | 0.1644 |
| B | nath | signer:roni | 27 | 1.0 | 0.8598 | 0.9697 | 0.8395 | 0.0606 | 0.8295 | 0.1778 |
| B | roni | signer:nath | 18 | 1.0 | 0.9167 | 0.9886 | 0.9119 | 0.0227 | 0.8826 | 0.1756 |

## Per-class recall (pooled)

| sign | A | B |
|---|---|---|
| YES | 0.9792 | 1.0 |
| NO | 0.9792 | 0.75 |
| RESERVATION | 0.9583 | 0.9792 |
| NAME | 1.0 | 0.875 |
| THANK-YOU | 0.9792 | 0.9792 |
| WHERE | 0.9583 | 0.8958 |
| ELEVATOR | 1.0 | 1.0 |
| FS-WIFI | 1.0 | 1.0 |
| PASSWORD | 1.0 | 0.8958 |
| BREAKFAST | 0.9375 | 0.9583 |
| TIME | 0.7917 | 0.7708 |
| TOWEL | 1.0 | 0.9792 |
| MORE | 0.9583 | 1.0 |
| LEAVE | 0.9167 | 1.0 |
| LATE | 1.0 | 1.0 |
| PLEASE | 0.9792 | 0.9792 |
| PARKING | 0.875 | 0.9375 |
| TAXI | 0.9583 | 1.0 |
| HELP | 0.7083 | 0.8125 |
| ROOM | 0.7708 | 0.7708 |
| RESTAURANT | 0.9583 | 0.9583 |
| NONE | 0.4583 | 0.6458 |

## Top confusions (true -> predicted, count over 4 folds)

| system | confusions |
|---|---|
| A | TIME->RESERVATION (10); NONE->BREAKFAST (10); HELP->NONE (7); ROOM->THANK-YOU (5); ROOM->HELP (4); PARKING->HELP (4) |
| B | NO->WHERE (12); TIME->RESERVATION (8); NAME->PLEASE (6); ROOM->PLEASE (4); ROOM->NONE (4); NONE->PLEASE (4) |

## Unknown-sign groups (team open-set test)

Each fold trains three extra models, each without one group of 7 signs, for the epoch count chosen in that fold, and scores the held-out signer's takes of the missing signs at the fold's temperature. Every sign is unknown exactly once per fold. The repo's benchmark leaves out one sign at a time (21 models per fold); that exact version is also reported where it was run.

| group | signs |
|---|---|
| 0 | RESERVATION, THANK-YOU, ELEVATOR, TIME, MORE, PARKING, HELP |
| 1 | YES, NAME, PASSWORD, TOWEL, LEAVE, TAXI, ROOM |
| 2 | NO, WHERE, FS-WIFI, BREAKFAST, LATE, PLEASE, RESTAURANT |

## Definitions

- **wrong sign spoken @0.6**: share of takes where the top label has confidence >= 0.6, is not NONE, and is wrong; the product would say a sign the guest did not make.
- **coverage @0.6**: share of takes accepted (top confidence >= 0.6), whatever the label.
- **NONE false-accept**: real signs predicted as NONE (argmax). **NONE false-alarm**: NONE takes predicted as a sign (argmax). **NONE spoken @0.6**: NONE takes that pass the gate as a sign.
- **unknown sign spoken**: takes of a sign the model was not trained on that pass the gate as some sign (mean over signs).
- **GISLR OOV spoken**: 450 GISLR rerun clips (10 Deaf signers, phone video) of 30 signs outside our vocabulary that pass the gate as a sign. Different domain from the team webcam data; the pretrained 1st-place network saw these 30 signs (from other people) during its original training, so this column favours C/C0.
- **CIs**: with only 4 test signers the t-interval (3 degrees of freedom) is the honest between-signer interval; the bootstrap resamples signers and then takes; the sign-flip test over 4 folds cannot go below p = 0.125.
