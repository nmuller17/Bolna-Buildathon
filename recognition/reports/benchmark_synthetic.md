# Recognition benchmark: synthetic

> **SYNTHETIC DATA.** These numbers only show that the training and evaluation code run and learn on made-up trajectories. They are not a measure of how well real ASL signs are recognised. The synthetic signs are much easier to tell apart than real ones (each has its own location), so do not choose between the GRU and the baseline from this report.

Created 2026-10-10T20:00:00+00:00. Mode: cross-validation. Data: <scratch>/synthetic_train_v2.
1320 takes, 4 signers (synthA, synthB, synthC, synthD).

Evaluation: each signer is held out in turn; the models are trained on the other signers (early stopping and temperature on one inner held-out signer, then refit on all training signers) and tested on the held-out signer. Predictions from all folds are pooled. Team members seen in training will usually score higher than this in the live demo; a new guest will score about this.

## Summary

| metric | gru | baseline |
|---|---|---|
| accuracy | 0.9985 | 0.9992 |
| top3_accuracy | 1.0 | 1.0 |
| macro_f1 | 0.9985 | 0.9992 |
| none_false_accept_rate | 0.0016 | 0.0 |
| none_false_alarm_rate | 0.0 | 0.0167 |
| coverage_at_threshold | 0.9879 | 0.9992 |
| accuracy_on_accepted | 1.0 | 1.0 |
| wrong_sign_spoken_rate | 0.0 | 0.0 |
| wrong_sign_spoken_rate_T1 | 0.0 | 0.0 |
| ece | 0.1083 | 0.0178 |

## Unknown signs (open-set, baseline)

Mean share of out-of-vocabulary takes spoken as a wrong sign: **0.5492**. Per sign (trained without it):

| sign left out | spoken as another sign |
|---|---|
| YES | 0.5167 |
| NO | 1.0 |
| RESERVATION | 0.7167 |
| NAME | 0.6333 |
| THANK-YOU | 0.1333 |
| WHERE | 0.4667 |
| ELEVATOR | 1.0 |
| FS-WIFI | 0.1833 |
| PASSWORD | 0.2667 |
| BREAKFAST | 0.7667 |
| TIME | 0.85 |
| TOWEL | 0.6 |
| MORE | 0.5667 |
| FS-CHECKOUT | 0.0 |
| LATE | 0.6833 |
| PLEASE | 0.6667 |
| PARKING | 0.75 |
| TAXI | 0.6 |
| HELP | 0.5167 |
| ROOM | 0.3667 |
| RESTAURANT | 0.25 |

## Per fold

| fold | test takes | gru acc | baseline acc | best epoch | gru temperature | baseline temperature |
|---|---|---|---|---|---|---|
| signer:synthA | 330 | 0.9939 | 1.0 | 35 | 1.0 | 1.0 |
| signer:synthB | 330 | 1.0 | 1.0 | 22 | 1.0 | 1.0 |
| signer:synthC | 330 | 1.0 | 1.0 | 22 | 1.0 | 1.049 |
| signer:synthD | 330 | 1.0 | 0.997 | 17 | 1.0 | 1.0 |

## Per-class recall

| sign | gru | baseline |
|---|---|---|
| YES | 1.0 | 1.0 |
| NO | 1.0 | 1.0 |
| RESERVATION | 1.0 | 1.0 |
| NAME | 1.0 | 1.0 |
| THANK-YOU | 1.0 | 1.0 |
| WHERE | 1.0 | 1.0 |
| ELEVATOR | 1.0 | 1.0 |
| FS-WIFI | 1.0 | 1.0 |
| PASSWORD | 1.0 | 1.0 |
| BREAKFAST | 0.9833 | 1.0 |
| TIME | 1.0 | 1.0 |
| TOWEL | 1.0 | 1.0 |
| MORE | 1.0 | 1.0 |
| FS-CHECKOUT | 1.0 | 1.0 |
| LATE | 1.0 | 1.0 |
| PLEASE | 0.9833 | 1.0 |
| PARKING | 1.0 | 1.0 |
| TAXI | 1.0 | 1.0 |
| HELP | 1.0 | 1.0 |
| ROOM | 1.0 | 1.0 |
| RESTAURANT | 1.0 | 1.0 |
| NONE | 1.0 | 0.9833 |

## Confusion matrix (gru, rows = true, columns = predicted)

| true | YES | NO | RESER | NAME | THANK | WHERE | ELEVA | FS-WI | PASSW | BREAK | TIME | TOWEL | MORE | FS-CH | LATE | PLEAS | PARKI | TAXI | HELP | ROOM | RESTA | NONE |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| YES | 60 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| NO | . | 60 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| RESERVATION | . | . | 60 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| NAME | . | . | . | 60 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| THANK-YOU | . | . | . | . | 60 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| WHERE | . | . | . | . | . | 60 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| ELEVATOR | . | . | . | . | . | . | 60 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| FS-WIFI | . | . | . | . | . | . | . | 60 | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| PASSWORD | . | . | . | . | . | . | . | . | 60 | . | . | . | . | . | . | . | . | . | . | . | . | . |
| BREAKFAST | . | . | . | . | . | . | . | . | . | 59 | . | . | . | . | . | . | . | . | . | . | . | 1 |
| TIME | . | . | . | . | . | . | . | . | . | . | 60 | . | . | . | . | . | . | . | . | . | . | . |
| TOWEL | . | . | . | . | . | . | . | . | . | . | . | 60 | . | . | . | . | . | . | . | . | . | . |
| MORE | . | . | . | . | . | . | . | . | . | . | . | . | 60 | . | . | . | . | . | . | . | . | . |
| FS-CHECKOUT | . | . | . | . | . | . | . | . | . | . | . | . | . | 60 | . | . | . | . | . | . | . | . |
| LATE | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 60 | . | . | . | . | . | . | . |
| PLEASE | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 59 | . | . | . | . | . | 1 |
| PARKING | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 60 | . | . | . | . | . |
| TAXI | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 60 | . | . | . | . |
| HELP | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 60 | . | . | . |
| ROOM | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 60 | . | . |
| RESTAURANT | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 60 | . |
| NONE | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 60 |

## Latency

One segment of 61 frames on CPU (2 torch threads). HTTP is measured in-process with FastAPI TestClient (includes JSON parsing, validation, features and model; excludes the real network).

| step | p50 ms | p95 ms |
|---|---|---|
| model forward | 1.63 | 1.76 |
| POST /predict | 11.97 | 66.18 |

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
