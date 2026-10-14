# Transfer learning vs the team baseline: leave-one-signer-out, face-free

Created 2026-10-11T11:50:18+00:00. Test signers: cosme, maya, nath, roni (one fold each, 264 takes = 22 classes x 12). Talha is in every training set and is never a validation or test signer. Every system sees the same folds, the same takes, the same inner validation signer (chosen by recognition.train.split, seed 0) for early stopping and temperature (T >= 1), the same refit on all training signers, and the same 0.6 gate. All inputs are face-free (face = None, pose 1-10 replaced by the pose nose), as the live recognizer receives them.

## Systems

| id | system |
|---|---|
| A | baseline (teammates', logistic regression) |
| B | SignGRU (ours) |
| C | FF-ISLR transfer (pretrained + face-free stage 1 + fine-tune) |
| C0 | FF-ISLR transfer without stage 1 (ablation) |
| D | FF-ISLR from scratch (no pretraining) |

## Pooled over the 4 test signers (1,056 takes)

| metric | A | B | C | C0 | D |
|---|---|---|---|---|---|
| accuracy | 0.9167 | 0.9176 | 0.9602 | 0.964 | 0.9366 |
| top-3 | 0.9754 | 0.9782 | 0.9924 | 0.9896 | 0.9744 |
| macro-F1 | 0.9148 | 0.9163 | 0.9581 | 0.9624 | 0.9328 |
| wrong sign spoken @0.6 | 0.036 | 0.0246 | 0.0104 | 0.0076 | 0.0114 |
| wrong sign spoken @0.6, T=1 | 0.0379 | 0.0246 | 0.0104 | 0.0076 | 0.0114 |
| coverage @0.6 | 0.9299 | 0.8864 | 0.9242 | 0.9129 | 0.8352 |
| accuracy on accepted | 0.9511 | 0.9712 | 0.9887 | 0.9917 | 0.9864 |
| NONE false-accept (sign -> NONE) | 0.0188 | 0.0109 | 0.002 | 0.0 | 0.001 |
| NONE false-alarm (NONE -> sign, argmax) | 0.5417 | 0.3542 | 0.4167 | 0.3542 | 0.5417 |
| NONE spoken as a sign @0.6 | 0.3542 | 0.1458 | 0.0625 | 0.0625 | 0.1875 |
| ECE | 0.0285 | 0.102 | 0.0831 | 0.0936 | 0.1409 |
| unknown sign spoken @0.6 (team, 3 groups of 7 left out) | 0.4951 | 0.3452 | 0.1915 | - | - |
| unknown sign spoken @0.6 (team, repo's one-sign-out) | 0.4445 | - | - | - | - |
| GISLR out-of-vocabulary clips spoken as a sign @0.6 (450 clips, 30 signs) | 0.1489 | 0.1806 | 0.1217 | 0.1017 | 0.0333 |
| latency per segment p50 / p95 ms (CPU, 2 threads) | 1.27 / 1.42 | 2.87 / 3.12 | 47.14 / 55.9 | 42.1 / 50.69 | 42.46 / 79.89 |
| parameters | 21,736 | 599,574 | 1,749,172 | 1,749,172 | 1,749,172 |
| checkpoint size | 0.10 MB | 2.41 MB | 7.06 MB | 7.06 MB | 7.06 MB |

Latency: one 56-frame segment, normalisation + features + forward, 200 runs, machine load average [8.07373046875, 14.7568359375, 19.072265625] (shared machine; compare systems with each other, not with an idle laptop).

## C vs A

| metric | mean C - A | 95% CI (t, 4 folds) | 95% CI (bootstrap: folds, then takes) | sign-flip p (folds) | McNemar p (pooled takes) | folds where C is better | per fold |
|---|---|---|---|---|---|---|---|
| wrong sign spoken @0.6 (lower is better) | -0.0256 | [-0.0798, 0.0287] | [-0.0568, 0.0057] | 0.5 | 4.19e-05 | 2/4 | cosme +0.0076, maya -0.0530, nath -0.0568, roni +0.0000 |
| accuracy (higher is better) | 0.0436 | [-0.057, 0.1441] | [-0.0133, 0.0985] | 0.375 | 2.2e-06 | 3/4 | cosme -0.0341, maya +0.1023, nath +0.0871, roni +0.0189 |

## C vs B

| metric | mean C - B | 95% CI (t, 4 folds) | 95% CI (bootstrap: folds, then takes) | sign-flip p (folds) | McNemar p (pooled takes) | folds where C is better | per fold |
|---|---|---|---|---|---|---|---|
| wrong sign spoken @0.6 (lower is better) | -0.0142 | [-0.065, 0.0366] | [-0.0464, 0.0095] | 0.75 | 0.0135 | 2/4 | cosme +0.0114, maya +0.0000, nath -0.0606, roni -0.0076 |
| accuracy (higher is better) | 0.0426 | [-0.0462, 0.1314] | [-0.0123, 0.0871] | 0.25 | 3.3e-06 | 3/4 | cosme -0.0379, maya +0.0568, nath +0.0909, roni +0.0606 |

## C vs D

| metric | mean C - D | 95% CI (t, 4 folds) | 95% CI (bootstrap: folds, then takes) | sign-flip p (folds) | McNemar p (pooled takes) | folds where C is better | per fold |
|---|---|---|---|---|---|---|---|
| wrong sign spoken @0.6 (lower is better) | -0.0009 | [-0.0267, 0.0248] | [-0.017, 0.0152] | 1.0 | 1.0 | 2/4 | cosme +0.0189, maya -0.0076, nath -0.0189, roni +0.0038 |
| accuracy (higher is better) | 0.0237 | [-0.0518, 0.0992] | [-0.0218, 0.0634] | 0.375 | 0.00307 | 3/4 | cosme -0.0417, maya +0.0606, nath +0.0568, roni +0.0189 |

## C vs C0

| metric | mean C - C0 | 95% CI (t, 4 folds) | 95% CI (bootstrap: folds, then takes) | sign-flip p (folds) | McNemar p (pooled takes) | folds where C is better | per fold |
|---|---|---|---|---|---|---|---|
| wrong sign spoken @0.6 (lower is better) | 0.0028 | [-0.0062, 0.0119] | [0.0, 0.0095] | 1.0 | 0.25 | 0/4 | cosme +0.0114, maya +0.0000, nath +0.0000, roni +0.0000 |
| accuracy (higher is better) | -0.0038 | [-0.0123, 0.0047] | [-0.0114, 0.0038] | 0.5 | 0.344 | 0/4 | cosme -0.0114, maya +0.0000, nath +0.0000, roni -0.0038 |

## B vs A

| metric | mean B - A | 95% CI (t, 4 folds) | 95% CI (bootstrap: folds, then takes) | sign-flip p (folds) | McNemar p (pooled takes) | folds where B is better | per fold |
|---|---|---|---|---|---|---|---|
| wrong sign spoken @0.6 (lower is better) | -0.0114 | [-0.0562, 0.0335] | [-0.0398, 0.0123] | 0.875 | 0.111 | 2/4 | cosme -0.0038, maya -0.0530, nath +0.0038, roni +0.0076 |
| accuracy (higher is better) | 0.0009 | [-0.0559, 0.0578] | [-0.0322, 0.036] | 1.0 | 1.0 | 2/4 | cosme +0.0038, maya +0.0455, nath -0.0038, roni -0.0417 |

## D vs A

| metric | mean D - A | 95% CI (t, 4 folds) | 95% CI (bootstrap: folds, then takes) | sign-flip p (folds) | McNemar p (pooled takes) | folds where D is better | per fold |
|---|---|---|---|---|---|---|---|
| wrong sign spoken @0.6 (lower is better) | -0.0246 | [-0.0567, 0.0075] | [-0.0455, -0.0057] | 0.125 | 2.56e-06 | 4/4 | cosme -0.0114, maya -0.0455, nath -0.0379, roni -0.0038 |
| accuracy (higher is better) | 0.0199 | [-0.011, 0.0508] | [-0.0, 0.0417] | 0.25 | 0.00864 | 3/4 | cosme +0.0076, maya +0.0417, nath +0.0303, roni +0.0000 |

## C0 vs A

| metric | mean C0 - A | 95% CI (t, 4 folds) | 95% CI (bootstrap: folds, then takes) | sign-flip p (folds) | McNemar p (pooled takes) | folds where C0 is better | per fold |
|---|---|---|---|---|---|---|---|
| wrong sign spoken @0.6 (lower is better) | -0.0284 | [-0.0773, 0.0204] | [-0.0568, -0.0009] | 0.25 | 1.38e-06 | 3/4 | cosme -0.0038, maya -0.0530, nath -0.0568, roni +0.0000 |
| accuracy (higher is better) | 0.0473 | [-0.045, 0.1397] | [-0.0057, 0.0985] | 0.375 | 2.26e-07 | 3/4 | cosme -0.0227, maya +0.1023, nath +0.0871, roni +0.0227 |

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
| C | cosme | signer:roni | 20 | 1.0 | 0.9394 | 1.0 | 0.9273 | 0.0189 | 0.9356 | 0.1289 |
| C | maya | signer:roni | 18 | 1.0 | 0.9735 | 0.9962 | 0.9731 | 0.0076 | 0.8939 | 0.12 |
| C | nath | signer:roni | 17 | 1.0 | 0.9508 | 0.9773 | 0.9416 | 0.0 | 0.8902 | 0.0956 |
| C | roni | signer:nath | 35 | 1.0 | 0.9773 | 0.9962 | 0.977 | 0.0152 | 0.9773 | 0.1422 |
| C0 | cosme | signer:roni | 20 | 1.0 | 0.9508 | 1.0 | 0.9386 | 0.0076 | 0.9242 | 0.1133 |
| C0 | maya | signer:roni | 18 | 1.0 | 0.9735 | 0.9924 | 0.973 | 0.0076 | 0.9015 | 0.1111 |
| C0 | nath | signer:roni | 17 | 1.0 | 0.9508 | 0.9697 | 0.942 | 0.0 | 0.8485 | 0.0711 |
| C0 | roni | signer:nath | 59 | 1.0 | 0.9811 | 0.9962 | 0.9806 | 0.0152 | 0.9773 | 0.1111 |
| D | cosme | signer:roni | 51 | 1.0 | 0.9811 | 0.9848 | 0.9789 | 0.0 | 0.9735 | 0.0489 |
| D | maya | signer:roni | 23 | 1.0 | 0.9129 | 0.9621 | 0.9038 | 0.0152 | 0.822 | 0.0267 |
| D | nath | signer:roni | 42 | 1.0 | 0.8939 | 0.9583 | 0.883 | 0.0189 | 0.6212 | 0.0422 |
| D | roni | signer:nath | 20 | 1.0 | 0.9583 | 0.9924 | 0.9533 | 0.0114 | 0.9242 | 0.0156 |

## Per-class recall (pooled)

| sign | A | B | C | C0 | D |
|---|---|---|---|---|---|
| YES | 0.9792 | 1.0 | 1.0 | 1.0 | 1.0 |
| NO | 0.9792 | 0.75 | 1.0 | 1.0 | 1.0 |
| RESERVATION | 0.9583 | 0.9792 | 1.0 | 0.9792 | 0.9792 |
| NAME | 1.0 | 0.875 | 0.9792 | 1.0 | 1.0 |
| THANK-YOU | 0.9792 | 0.9792 | 0.9792 | 0.9792 | 0.8958 |
| WHERE | 0.9583 | 0.8958 | 0.9792 | 0.9792 | 0.9583 |
| ELEVATOR | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 |
| FS-WIFI | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 |
| PASSWORD | 1.0 | 0.8958 | 1.0 | 1.0 | 1.0 |
| BREAKFAST | 0.9375 | 0.9583 | 1.0 | 1.0 | 1.0 |
| TIME | 0.7917 | 0.7708 | 0.7708 | 0.7708 | 0.7917 |
| TOWEL | 1.0 | 0.9792 | 1.0 | 1.0 | 1.0 |
| MORE | 0.9583 | 1.0 | 1.0 | 1.0 | 1.0 |
| LEAVE | 0.9167 | 1.0 | 1.0 | 1.0 | 1.0 |
| LATE | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 |
| PLEASE | 0.9792 | 0.9792 | 1.0 | 1.0 | 0.9792 |
| PARKING | 0.875 | 0.9375 | 0.9792 | 0.9583 | 0.875 |
| TAXI | 0.9583 | 1.0 | 1.0 | 1.0 | 1.0 |
| HELP | 0.7083 | 0.8125 | 0.9375 | 0.9583 | 0.8542 |
| ROOM | 0.7708 | 0.7708 | 0.9583 | 0.9792 | 0.8125 |
| RESTAURANT | 0.9583 | 0.9583 | 0.9583 | 0.9583 | 1.0 |
| NONE | 0.4583 | 0.6458 | 0.5833 | 0.6458 | 0.4583 |

## Top confusions (true -> predicted, count over 4 folds)

| system | confusions |
|---|---|
| A | TIME->RESERVATION (10); NONE->BREAKFAST (10); HELP->NONE (7); ROOM->THANK-YOU (5); ROOM->HELP (4); PARKING->HELP (4) |
| B | NO->WHERE (12); TIME->RESERVATION (8); NAME->PLEASE (6); ROOM->PLEASE (4); ROOM->NONE (4); NONE->PLEASE (4) |
| C | TIME->RESERVATION (11); NONE->PLEASE (3); NONE->LATE (3); NONE->BREAKFAST (3); ROOM->NONE (2); RESTAURANT->PARKING (2) |
| C0 | TIME->RESERVATION (10); NONE->PLEASE (3); RESTAURANT->PARKING (2); PARKING->HELP (2); NONE->PARKING (2); NONE->MORE (2) |
| D | TIME->RESERVATION (9); PARKING->HELP (6); NONE->LEAVE (6); NONE->PLEASE (5); THANK-YOU->PLEASE (4); ROOM->LEAVE (4) |

## Stage 1 (face-free adaptation of the pretrained weights, GISLR only)

4995 GISLR rerun clips (CC0) of 220 signs, held-out participant 6927 (379 clips). 250-way accuracy on that participant: teacher with face 0.7045, face-free before adaptation 0.6148, after 0.6069 (best epoch 4). The 30 GISLR OOV test signs were excluded from stage 1.

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
- **CIs**: with only 4 test signers the t-interval (3 degrees of freedom) is the honest between-signer interval; the bootstrap resamples signers and then takes; the sign-flip test over 4 folds cannot go below p = 0.125. The McNemar p treats the 1,056 takes as independent, which they are not (takes are clustered in 4 signers), so it overstates certainty; read the fold-level intervals first.
