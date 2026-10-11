# Recognition benchmark: team5

Created 2026-10-11T02:27:01+00:00. Mode: cross-validation. Data: data/train.
1320 takes, 5 signers (cosme, maya, nath, roni, talha).

Evaluation: each signer is held out in turn; the models are trained on the other signers (early stopping and temperature on one inner held-out signer, then refit on all training signers) and tested on the held-out signer. Predictions from all folds are pooled. Team members seen in training will usually score higher than this in the live demo; a new guest will score about this.

## Summary

| metric | gru | baseline |
|---|---|---|
| accuracy | 0.8795 | 0.8985 |
| top3_accuracy | 0.9697 | 0.9712 |
| macro_f1 | 0.8763 | 0.8976 |
| none_false_accept_rate | 0.0063 | 0.027 |
| none_false_alarm_rate | 0.5833 | 0.55 |
| coverage_at_threshold | 0.8182 | 0.8947 |
| accuracy_on_accepted | 0.9398 | 0.9382 |
| wrong_sign_spoken_rate | 0.0477 | 0.0402 |
| wrong_sign_spoken_rate_T1 | 0.0477 | 0.0477 |
| ece | 0.0983 | 0.0591 |

## Per fold

| fold | test takes | gru acc | baseline acc | best epoch | gru temperature | baseline temperature |
|---|---|---|---|---|---|---|
| signer:cosme | 264 | 0.9659 | 0.9735 | 10 | 1.0 | 1.604 |
| signer:maya | 264 | 0.8674 | 0.8712 | 5 | 1.0 | 1.597 |
| signer:nath | 264 | 0.8636 | 0.8636 | 9 | 1.0 | 1.43 |
| signer:roni | 264 | 0.9015 | 0.9583 | 18 | 1.0 | 1.45 |
| signer:talha | 264 | 0.7992 | 0.8258 | 11 | 1.0 | 1.0 |

## Per-class recall

| sign | gru | baseline |
|---|---|---|
| YES | 0.9833 | 0.9667 |
| NO | 0.8 | 0.9833 |
| RESERVATION | 0.7667 | 0.7667 |
| NAME | 0.9833 | 1.0 |
| THANK-YOU | 0.95 | 0.95 |
| WHERE | 0.7333 | 0.95 |
| ELEVATOR | 0.9667 | 1.0 |
| FS-WIFI | 1.0 | 1.0 |
| PASSWORD | 0.9833 | 1.0 |
| BREAKFAST | 0.9667 | 0.9167 |
| TIME | 0.6 | 0.7833 |
| TOWEL | 1.0 | 1.0 |
| MORE | 1.0 | 0.9667 |
| LEAVE | 0.8167 | 0.7833 |
| LATE | 0.8833 | 0.9833 |
| PLEASE | 0.9833 | 0.95 |
| PARKING | 0.8667 | 0.8667 |
| TAXI | 0.9833 | 0.9667 |
| HELP | 0.8833 | 0.7667 |
| ROOM | 0.8167 | 0.75 |
| RESTAURANT | 0.9667 | 0.9667 |
| NONE | 0.4167 | 0.45 |

## Confusion matrix (gru, rows = true, columns = predicted)

| true | YES | NO | RESER | NAME | THANK | WHERE | ELEVA | FS-WI | PASSW | BREAK | TIME | TOWEL | MORE | LEAVE | LATE | PLEAS | PARKI | TAXI | HELP | ROOM | RESTA | NONE |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| YES | 59 | 1 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| NO | . | 48 | . | . | . | 12 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| RESERVATION | . | . | 46 | . | . | . | . | . | . | . | 14 | . | . | . | . | . | . | . | . | . | . | . |
| NAME | . | . | . | 59 | . | . | . | . | . | . | . | . | . | . | . | 1 | . | . | . | . | . | . |
| THANK-YOU | . | . | . | . | 57 | . | . | . | . | . | . | . | . | . | . | 2 | . | . | . | . | 1 | . |
| WHERE | . | 13 | 1 | . | . | 44 | . | . | . | . | . | . | . | 1 | 1 | . | . | . | . | . | . | . |
| ELEVATOR | . | . | . | . | . | . | 58 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 2 |
| FS-WIFI | . | . | . | . | . | . | . | 60 | . | . | . | . | . | . | . | . | . | . | . | . | . | . |
| PASSWORD | . | . | . | . | . | . | . | . | 59 | . | . | . | . | . | . | . | . | . | . | . | . | 1 |
| BREAKFAST | . | . | . | . | . | . | . | . | . | 58 | . | . | . | . | . | . | 1 | . | 1 | . | . | . |
| TIME | . | . | 19 | . | . | . | . | . | . | . | 36 | . | . | . | 4 | . | . | . | . | . | . | 1 |
| TOWEL | . | . | . | . | . | . | . | . | . | . | . | 60 | . | . | . | . | . | . | . | . | . | . |
| MORE | . | . | . | . | . | . | . | . | . | . | . | . | 60 | . | . | . | . | . | . | . | . | . |
| LEAVE | . | . | 9 | . | . | . | . | . | . | . | . | . | . | 49 | . | . | . | . | . | . | . | 2 |
| LATE | . | . | 4 | . | . | . | . | . | . | 1 | 2 | . | . | . | 53 | . | . | . | . | . | . | . |
| PLEASE | . | . | . | 1 | . | . | . | . | . | . | . | . | . | . | . | 59 | . | . | . | . | . | . |
| PARKING | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 1 | 3 | 52 | . | 4 | . | . | . |
| TAXI | . | . | 1 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 59 | . | . | . | . |
| HELP | . | . | . | . | 1 | . | . | . | . | . | . | . | . | . | . | . | 2 | . | 53 | 3 | . | 1 |
| ROOM | . | . | . | 3 | . | 1 | . | . | 1 | . | . | . | 4 | . | . | . | 2 | . | . | 49 | . | . |
| RESTAURANT | . | . | . | . | . | 1 | . | . | . | . | . | . | . | . | . | . | . | . | . | . | 58 | 1 |
| NONE | 3 | . | . | . | . | . | 3 | . | 1 | 6 | 1 | 1 | . | 3 | 2 | 5 | . | 4 | . | 4 | 2 | 25 |

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
