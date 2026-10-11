# Recognition benchmark: team4

Created 2026-10-11T01:47:50+00:00. Mode: cross-validation. Data: data/train.
1056 takes, 4 signers (cosme, maya, nath, roni).

Evaluation: each signer is held out in turn; the models are trained on the other signers (early stopping and temperature on one inner held-out signer, then refit on all training signers) and tested on the held-out signer. Predictions from all folds are pooled. Team members seen in training will usually score higher than this in the live demo; a new guest will score about this.

## Summary

| metric | gru | baseline |
|---|---|---|
| accuracy | 0.8712 | 0.9015 |
| top3_accuracy | 0.9631 | 0.9773 |
| macro_f1 | 0.8708 | 0.8994 |
| none_false_accept_rate | 0.0298 | 0.0169 |
| none_false_alarm_rate | 0.4167 | 0.5417 |
| coverage_at_threshold | 0.8286 | 0.9167 |
| accuracy_on_accepted | 0.952 | 0.937 |
| wrong_sign_spoken_rate | 0.0322 | 0.0483 |
| wrong_sign_spoken_rate_T1 | 0.0322 | 0.0483 |
| ece | 0.1014 | 0.0199 |

## Unknown signs (open-set, baseline)

Mean share of out-of-vocabulary takes spoken as a wrong sign: **0.4454**. Per sign (trained without it):

| sign left out | spoken as another sign |
|---|---|
| YES | 0.5625 |
| NO | 0.75 |
| RESERVATION | 0.8958 |
| NAME | 0.3958 |
| THANK-YOU | 0.1875 |
| WHERE | 0.2917 |
| ELEVATOR | 0.3958 |
| FS-WIFI | 0.0417 |
| PASSWORD | 0.1875 |
| BREAKFAST | 0.0417 |
| TIME | 0.8542 |
| TOWEL | 0.5625 |
| MORE | 0.4375 |
| LEAVE | 0.0625 |
| LATE | 0.5208 |
| PLEASE | 0.0417 |
| PARKING | 0.6667 |
| TAXI | 0.625 |
| HELP | 0.7708 |
| ROOM | 0.875 |
| RESTAURANT | 0.1875 |

## Per fold

| fold | test takes | gru acc | baseline acc | best epoch | gru temperature | baseline temperature |
|---|---|---|---|---|---|---|
| signer:cosme | 264 | 0.9394 | 0.9545 | 10 | 1.0 | 1.012 |
| signer:maya | 264 | 0.8258 | 0.8106 | 12 | 1.0 | 1.0 |
| signer:nath | 264 | 0.8485 | 0.8902 | 17 | 1.0 | 1.0 |
| signer:roni | 264 | 0.8712 | 0.9508 | 10 | 1.0 | 1.189 |

## Per-class recall

| sign | gru | baseline |
|---|---|---|
| YES | 0.9375 | 1.0 |
| NO | 0.9583 | 0.9167 |
| RESERVATION | 0.7708 | 0.875 |
| NAME | 0.8125 | 1.0 |
| THANK-YOU | 0.9792 | 0.9792 |
| WHERE | 0.7083 | 0.9583 |
| ELEVATOR | 1.0 | 0.9792 |
| FS-WIFI | 0.8958 | 1.0 |
| PASSWORD | 0.9583 | 1.0 |
| BREAKFAST | 0.9792 | 0.9375 |
| TIME | 0.7708 | 0.9167 |
| TOWEL | 0.9375 | 0.875 |
| MORE | 0.75 | 0.7708 |
| LEAVE | 0.9792 | 0.9583 |
| LATE | 1.0 | 0.9583 |
| PLEASE | 0.9167 | 0.9375 |
| PARKING | 0.9167 | 0.8333 |
| TAXI | 1.0 | 0.9792 |
| HELP | 0.6042 | 0.7708 |
| ROOM | 0.7917 | 0.7708 |
| RESTAURANT | 0.9167 | 0.9583 |
| NONE | 0.5833 | 0.4583 |

## Confusion matrix (gru, rows = true, columns = predicted)

| true | YES | NO | RESER | NAME | THANK | WHERE | ELEVA | FS-WI | PASSW | BREAK | TIME | TOWEL | MORE | LEAVE | LATE | PLEAS | PARKI | TAXI | HELP | ROOM | RESTA | NONE |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| YES | 45 | 3 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| NO | . | 46 | . | . | . | 2 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| RESERVATION | . | . | 37 | . | . | . | . | . | . | . | 9 | . | . | 2 | . | . | . | . | . | . | . | . |
| NAME | . | . | . | 39 | . | . | . | . | . | . | . | . | 9 | . | . | . | . | . | . | . | . | . |
| THANK-YOU | . | . | . | . | 47 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 1 |
| WHERE | 5 | 6 | 2 | . | . | 34 | . | . | . | . | . | . | . | . | 1 | . | . | . | . | . | . | . |
| ELEVATOR | . | . | . | . | . | . | 48 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| FS-WIFI | . | 5 | . | . | . | . | . | 43 | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| PASSWORD | . | . | . | . | . | . | . | . | 46 | . | . | . | . | . | . | . | . | . | . | 1 | . | 1 |
| BREAKFAST | . | . | . | . | . | . | . | . | . | 47 | . | . | . | . | . | . | . | . | . | 1 | . | . |
| TIME | . | . | 7 | . | . | . | . | . | . | . | 37 | . | . | . | 4 | . | . | . | . | . | . | . |
| TOWEL | . | . | . | . | . | . | . | . | . | . | . | 45 | . | . | . | . | . | . | . | . | . | 3 |
| MORE | . | . | . | . | . | . | . | . | . | . | . | . | 36 | . | . | . | . | . | . | . | . | 12 |
| LEAVE | . | . | . | . | . | . | . | . | . | . | . | . | . | 47 | . | . | . | . | . | . | . | 1 |
| LATE | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 48 | . | . | . | . | . | . | . |
| PLEASE | . | . | . | 2 | 2 | . | . | . | . | . | . | . | . | . | . | 44 | . | . | . | . | . | . |
| PARKING | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 44 | . | 4 | . | . | . |
| TAXI | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 48 | . | . | . | . |
| HELP | . | . | . | . | 1 | 1 | . | . | . | 3 | . | . | . | . | . | . | 10 | . | 29 | 2 | . | 2 |
| ROOM | . | . | . | 1 | . | . | . | . | . | . | . | . | 1 | . | . | . | 1 | . | . | 38 | . | 7 |
| RESTAURANT | . | . | . | . | 1 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 44 | 3 |
| NONE | 1 | . | . | 1 | . | . | 3 | . | 1 | 2 | . | . | 1 | 2 | 1 | 4 | . | 1 | . | 1 | 2 | 28 |

## Latency

One segment of 53 frames on CPU (2 torch threads). HTTP is measured in-process with FastAPI TestClient (includes JSON parsing, validation, features and model; excludes the real network).

| step | p50 ms | p95 ms |
|---|---|---|
| model forward | 1.82 | 3.33 |
| POST /predict | 19.05 | 27.83 |

## What each number means

- **accuracy**: share of test takes whose top prediction is the true sign. 1.0 is perfect; guessing gives 1/22 = 0.045.
- **top-3 accuracy**: share of test takes where the true sign is among the three labels /predict returns.
- **macro-F1**: for each sign, F1 combines precision (when the model says this sign, how often is it right) and recall (how many takes of this sign it finds); the 22 values are averaged with equal weight, so a model that ignores a hard sign is penalised. Higher is better.
- **per-class recall**: for each sign, the share of its takes recognised correctly. Look here for the signs that need more or cleaner captures.
- **confusion matrix**: counts of (true sign = row, predicted sign = column). Off-diagonal cells show which signs get mixed up.
- **NONE false-accept rate**: among takes of real signs, the share predicted as NONE. In the demo this triggers "Could you repeat?". Annoying but safe; lower is better.
- **NONE false-alarm rate**: among NONE takes (idle hands, scratching), the share predicted as a sign. Lower is better.
- **coverage at 0.6**: share of takes whose top confidence is at least 0.6, i.e. P4 would accept the answer instead of asking to repeat.
- **accuracy on accepted**: among those accepted takes, the share that are correct. Should be well above plain accuracy if confidence is meaningful.
- **wrong sign spoken rate**: share of all takes where P4's rule (conf >= 0.6 and not NONE) accepts a WRONG sign, so the system would say something the guest did not sign. This is the most damaging demo failure; lower is better.
- **wrong sign spoken at T=1**: the same rate with the temperature left at 1, to show what the fitted temperature changes. Because the temperature may only soften (T >= 1), the main rate is never higher than this one.
- **unknown sign spoken rate** (open-set, baseline only): for each sign, the model is trained WITHOUT that sign and then shown the held-out signer doing it; this is the share it would still speak as some other sign. It estimates what happens when a guest signs something outside the 21 words. Lower is better; it is usually high, because a closed-set classifier has no idea what it has not seen.
- **ECE (expected calibration error)**: takes are grouped by confidence (0-0.1, ..., 0.9-1); in each group the gap between average confidence and actual accuracy is measured and averaged (weighted by group size). 0 means "conf 0.8 is right 80% of the time"; above about 0.1 the 0.6 threshold is not trustworthy.
