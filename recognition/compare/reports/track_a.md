# Track A: Deaf signers, 7 shared classes, leave-one-signer-out

> **EXPLORATORY — NOT CLEARED FOR SLIDES.** See [audit.md](audit.md). The pretrained row is a reference with different training data and known outside-vocabulary labels; it is not a fair architecture or open-set comparison. These are not product accuracy results.

Created 2026-10-10T23:22:03+00:00. Test data: GISLR rerun set (Kaggle `sohier/461054610546105`, CC BY 4.0), 10 Deaf participants, 1,105 clips of the 7 signs our vocabulary shares with GISLR (YES, NO, THANK-YOU, WHERE, TIME, PLEASE, ROOM) plus 450 clips of 30 other GISLR signs used only as out-of-vocabulary negatives. Every trained system uses the same 10 folds: train on 9 participants, test on the 10th. The pretrained model is not retrained; a verified training manifest and identity mapping are still needed to certify its signer separation.

Each trained system learns 8 classes per fold: the 7 signs and NONE, where NONE = 15 other GISLR signs (bird, book, cat, cow, dance, drink, elephant, happy, horse, lion, pig, sad, scissors, tree, zipper) from the 9 training participants. Its answers are scored two ways on the same held-out clips: **R8**, the 8-way answer (what the product does: a sign or NONE), and **C7**, the probabilities renormalised over the 7 signs only, i.e. a forced choice (the pretrained model is scored on its 7 shared-sign logits the same way). The open-set test in both modes uses the held-out participant's clips of 15 DIFFERENT signs (airplane, apple, cloud, cry, dog, fish, flower, frog, girl, hat, jump, kiss, mom, rain, shirt): held out for the locally trained systems. These signs were included in pretrained training.

**This is not our 22-class product test.** It covers 7 of our 21 signs, signed by Deaf native signers on phones, and the trained systems learned those 7 signs from GISLR data only (we have no team captures yet). Do not compare these numbers with published GISLR scores (250 classes) or with any other vocabulary.

## Mode C7: forced choice among the 7 signs (NONE removed)

| system | test set | #signers | #clips | top-1 [95% CI] | top-3 | macro-F1 [95% CI] | open-set false accept [95% CI] | coverage@0.6 | accuracy@0.6 | p50 latency | training data | data that leaves the device |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ours_gru` | GISLR rerun, 7 signs, 10 signer IDs; pretrained provenance unresolved | 10 | 1105 | 0.921 [0.870, 0.958] | 0.975 | 0.920 [0.867, 0.957] | 0.369 [0.286, 0.448] (n=225) | 0.930 | 0.950 | 2.2 ms | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `ours_baseline` | GISLR rerun, 7 signs, 10 signer IDs; pretrained provenance unresolved | 10 | 1105 | 0.878 [0.809, 0.929] | 0.964 | 0.875 [0.802, 0.928] | 0.498 [0.436, 0.562] (n=225) | 0.870 | 0.947 | 0.7 ms | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_ourfeat` | GISLR rerun, 7 signs, 10 signer IDs; pretrained provenance unresolved | 10 | 1105 | 0.919 [0.871, 0.955] | 0.974 | 0.918 [0.868, 0.955] | 0.382 [0.322, 0.446] (n=225) | 0.891 | 0.965 | 40.8 ms | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_retrained` | GISLR rerun, 7 signs, 10 signer IDs; pretrained provenance unresolved | 10 | 1105 | 0.928 [0.872, 0.963] | 0.983 | 0.927 [0.872, 0.963] | 0.240 [0.151, 0.332] (n=225) | 0.882 | 0.975 | 39.2 ms | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_pretrained` | GISLR rerun, 7 signs, 10 signer IDs; pretrained provenance unresolved | 10 | 1105 | 0.979 [0.957, 0.992] | 0.991 | 0.978 [0.954, 0.992] | 0.089 [0.058, 0.122] (n=225) | 0.964 | 0.996 | 6.1 ms | ~94k clips, 250 signs; signer provenance unresolved | nothing: landmarks only, processed locally |

Paired differences on the same clips (A minus B; signer-bootstrap 95% CI and p; exact McNemar p on top-1):

| A - B | top-1 diff [CI] p | McNemar p (A-only vs B-only right) | macro-F1 diff [CI] | false-accept diff [CI] (negative = A refuses more) |
|---|---|---|---|---|
| ours_gru - ours_baseline | +0.043 [+0.019, +0.072] p=<0.0005 | 3e-06 (76 vs 28) | +0.045 [+0.018, +0.076] | -0.129 [-0.195, -0.063] |
| ours_gru - islr1st_ourfeat | +0.002 [-0.012, +0.013] p=0.793 | 0.9 (31 vs 29) | +0.002 [-0.012, +0.013] | -0.013 [-0.084, +0.051] |
| ours_gru - islr1st_retrained | -0.006 [-0.039, +0.022] p=0.737 | 0.49 (34 vs 41) | -0.007 [-0.042, +0.021] | +0.129 [+0.064, +0.181] |
| ours_baseline - islr1st_ourfeat | -0.042 [-0.068, -0.021] p=<0.0005 | <1e-6 (18 vs 64) | -0.043 [-0.070, -0.021] | +0.116 [+0.035, +0.188] |
| ours_baseline - islr1st_retrained | -0.050 [-0.080, -0.025] p=<0.0005 | <1e-6 (29 vs 84) | -0.052 [-0.086, -0.026] | +0.258 [+0.172, +0.327] |

Per-signer top-1 (each signer was unseen by the trained systems):

| signer | ours_gru | ours_baseline | islr1st_ourfeat | islr1st_retrained | islr1st_pretrained | #clips |
|---|---|---|---|---|---|---|
| 2455 | 0.9621 | 0.9015 | 0.947 | 0.9545 | 0.9924 | 132 |
| 6927 | 0.6364 | 0.6818 | 0.7273 | 0.8636 | 0.9091 | 44 |
| 11672 | 0.881 | 0.7857 | 0.8889 | 0.873 | 0.9841 | 126 |
| 11696 | 0.9437 | 0.8732 | 0.9577 | 0.9296 | 0.9718 | 71 |
| 14938 | 0.9606 | 0.9449 | 0.9606 | 0.9685 | 0.9921 | 127 |
| 15662 | 0.9841 | 0.9603 | 0.9841 | 0.9841 | 1.0 | 126 |
| 23662 | 0.873 | 0.8333 | 0.873 | 0.9524 | 0.9921 | 126 |
| 32536 | 0.7955 | 0.6477 | 0.75 | 0.6932 | 0.8864 | 88 |
| 34304 | 0.9773 | 0.9848 | 0.9848 | 0.9773 | 1.0 | 132 |
| 48118 | 0.9774 | 0.9549 | 0.9549 | 0.9624 | 0.985 | 133 |

Per-class recall:

| sign | ours_gru | ours_baseline | islr1st_ourfeat | islr1st_retrained | islr1st_pretrained |
|---|---|---|---|---|---|
| NO | 0.903 | 0.8848 | 0.9212 | 0.9091 | 0.9636 |
| PLEASE | 0.9659 | 0.9261 | 0.9659 | 0.9716 | 0.983 |
| ROOM | 0.8936 | 0.8156 | 0.9078 | 0.8794 | 0.9787 |
| THANK-YOU | 0.9441 | 0.8741 | 0.9091 | 0.951 | 0.993 |
| TIME | 0.9058 | 0.8406 | 0.8841 | 0.9058 | 0.9638 |
| WHERE | 0.9118 | 0.8882 | 0.9235 | 0.9353 | 0.9824 |
| YES | 0.9186 | 0.8953 | 0.9128 | 0.9302 | 0.9884 |

Open-set false accept per out-of-vocabulary sign:

| outside sign | ours_gru | ours_baseline | islr1st_ourfeat | islr1st_retrained | islr1st_pretrained |
|---|---|---|---|---|---|
| airplane | 0.4667 | 0.6 | 0.4667 | 0.2667 | 0.0 |
| apple | 0.4667 | 0.6 | 0.4667 | 0.6667 | 0.2667 |
| cloud | 0.2 | 0.2667 | 0.2 | 0.1333 | 0.0667 |
| cry | 0.1333 | 0.7333 | 0.0667 | 0.1333 | 0.0667 |
| dog | 0.3333 | 0.7333 | 0.3333 | 0.1333 | 0.0667 |
| fish | 0.6667 | 0.6667 | 0.6667 | 0.4667 | 0.6667 |
| flower | 0.1333 | 0.3333 | 0.2 | 0.0 | 0.0 |
| frog | 0.6 | 0.6 | 0.6667 | 0.3333 | 0.0 |
| girl | 0.4667 | 0.6 | 0.4 | 0.2667 | 0.0667 |
| hat | 0.0667 | 0.4667 | 0.0667 | 0.2 | 0.0 |
| jump | 0.6667 | 0.5333 | 0.4 | 0.4667 | 0.0 |
| kiss | 0.4667 | 0.0 | 0.3333 | 0.0 | 0.0667 |
| mom | 0.2667 | 0.3333 | 0.6667 | 0.2667 | 0.0667 |
| rain | 0.2667 | 0.3333 | 0.2667 | 0.0 | 0.0 |
| shirt | 0.3333 | 0.6667 | 0.5333 | 0.2667 | 0.0 |

22-output check: our models have the real 22-way head; top-1 when the argmax runs over all 22 outputs instead of only this mode's labels: {'ours_gru': 0.8932, 'ours_baseline': 0.829, 'islr1st_ourfeat': 0.8814}. The 14 classes without GISLR data never appear in training, so this only shows they do not steal answers; it is not a 22-class test.

## Mode R8: 7 signs or NONE (rejection diagnostic)

| system | test set | #signers | #clips | top-1 [95% CI] | top-3 | macro-F1 [95% CI] | open-set false accept [95% CI] | coverage@0.6 | accuracy@0.6 | p50 latency | training data | data that leaves the device |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ours_gru` | GISLR rerun, 7 signs, 10 signer IDs; pretrained provenance unresolved | 10 | 1105 | 0.893 [0.827, 0.945] | 0.964 | 0.913 [0.856, 0.955] | 0.160 [0.113, 0.211] (n=225) | 0.878 | 0.964 | 2.2 ms | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `ours_baseline` | GISLR rerun, 7 signs, 10 signer IDs; pretrained provenance unresolved | 10 | 1105 | 0.829 [0.731, 0.908] | 0.947 | 0.864 [0.781, 0.924] | 0.116 [0.073, 0.166] (n=225) | 0.781 | 0.965 | 0.7 ms | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_ourfeat` | GISLR rerun, 7 signs, 10 signer IDs; pretrained provenance unresolved | 10 | 1105 | 0.881 [0.816, 0.936] | 0.965 | 0.907 [0.851, 0.949] | 0.133 [0.094, 0.178] (n=225) | 0.836 | 0.972 | 40.8 ms | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_retrained` | GISLR rerun, 7 signs, 10 signer IDs; pretrained provenance unresolved | 10 | 1105 | 0.904 [0.845, 0.944] | 0.974 | 0.920 [0.866, 0.956] | 0.120 [0.064, 0.176] (n=225) | 0.834 | 0.983 | 39.2 ms | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_pretrained` | GISLR rerun, 7 signs, 10 signer IDs; pretrained provenance unresolved | 10 | 1105 | 0.900 [0.845, 0.938] | 0.987 | 0.947 [0.916, 0.967] | 0.000 [0.000, 0.000] (n=225) | 0.786 | 1.000 | 6.1 ms | ~94k clips, 250 signs; signer provenance unresolved | nothing: landmarks only, processed locally |

Paired differences on the same clips (A minus B; signer-bootstrap 95% CI and p; exact McNemar p on top-1):

| A - B | top-1 diff [CI] p | McNemar p (A-only vs B-only right) | macro-F1 diff [CI] | false-accept diff [CI] (negative = A refuses more) |
|---|---|---|---|---|
| ours_gru - ours_baseline | +0.064 [+0.028, +0.105] p=<0.0005 | <1e-6 (99 vs 28) | +0.048 [+0.020, +0.082] | +0.044 [-0.004, +0.091] |
| ours_gru - islr1st_ourfeat | +0.012 [-0.007, +0.030] p=0.255 | 0.18 (46 vs 33) | +0.005 [-0.013, +0.018] | +0.027 [-0.005, +0.059] |
| ours_gru - islr1st_retrained | -0.011 [-0.039, +0.012] p=0.417 | 0.28 (45 vs 57) | -0.007 [-0.037, +0.013] | +0.040 [-0.011, +0.088] |
| ours_baseline - islr1st_ourfeat | -0.052 [-0.091, -0.022] p=<0.0005 | <1e-6 (31 vs 89) | -0.043 [-0.075, -0.021] | -0.018 [-0.053, +0.016] |
| ours_baseline - islr1st_retrained | -0.075 [-0.130, -0.032] p=<0.0005 | <1e-6 (35 vs 118) | -0.055 [-0.099, -0.025] | -0.004 [-0.042, +0.037] |

Per-signer top-1 (each signer was unseen by the trained systems):

| signer | ours_gru | ours_baseline | islr1st_ourfeat | islr1st_retrained | islr1st_pretrained | #clips |
|---|---|---|---|---|---|---|
| 2455 | 0.9545 | 0.8864 | 0.9394 | 0.9394 | 0.8939 | 132 |
| 6927 | 0.6364 | 0.6818 | 0.7273 | 0.8409 | 0.6591 | 44 |
| 11672 | 0.8175 | 0.6429 | 0.746 | 0.8651 | 0.9127 | 126 |
| 11696 | 0.9437 | 0.831 | 0.9437 | 0.9014 | 0.7324 | 71 |
| 14938 | 0.9449 | 0.9291 | 0.9213 | 0.9449 | 0.9134 | 127 |
| 15662 | 0.9762 | 0.9524 | 0.9762 | 0.9841 | 0.9921 | 126 |
| 23662 | 0.8016 | 0.7063 | 0.7698 | 0.8651 | 0.9206 | 126 |
| 32536 | 0.7045 | 0.5455 | 0.7386 | 0.6591 | 0.7841 | 88 |
| 34304 | 0.9773 | 0.9773 | 0.9697 | 0.9621 | 0.9621 | 132 |
| 48118 | 0.9624 | 0.9398 | 0.9549 | 0.9549 | 0.9624 | 133 |

Per-class recall:

| sign | ours_gru | ours_baseline | islr1st_ourfeat | islr1st_retrained | islr1st_pretrained |
|---|---|---|---|---|---|
| NO | 0.8848 | 0.8364 | 0.8606 | 0.897 | 0.897 |
| PLEASE | 0.9659 | 0.875 | 0.9489 | 0.9659 | 0.9659 |
| ROOM | 0.8723 | 0.7589 | 0.8794 | 0.8511 | 0.8865 |
| THANK-YOU | 0.8811 | 0.7902 | 0.8462 | 0.9091 | 0.986 |
| TIME | 0.8478 | 0.7754 | 0.8116 | 0.8478 | 0.8986 |
| WHERE | 0.9118 | 0.8647 | 0.9059 | 0.9294 | 0.9294 |
| YES | 0.8721 | 0.8721 | 0.8953 | 0.907 | 0.75 |

Open-set false accept per out-of-vocabulary sign:

| outside sign | ours_gru | ours_baseline | islr1st_ourfeat | islr1st_retrained | islr1st_pretrained |
|---|---|---|---|---|---|
| airplane | 0.1333 | 0.0 | 0.0667 | 0.0 | 0.0 |
| apple | 0.1333 | 0.1333 | 0.0667 | 0.5333 | 0.0 |
| cloud | 0.0667 | 0.0 | 0.0667 | 0.0 | 0.0 |
| cry | 0.0667 | 0.0667 | 0.0667 | 0.0 | 0.0 |
| dog | 0.1333 | 0.2 | 0.1333 | 0.0 | 0.0 |
| fish | 0.5333 | 0.4667 | 0.4667 | 0.3333 | 0.0 |
| flower | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| frog | 0.2 | 0.0667 | 0.2 | 0.0667 | 0.0 |
| girl | 0.3333 | 0.2 | 0.2667 | 0.1333 | 0.0 |
| hat | 0.0 | 0.0 | 0.0 | 0.0667 | 0.0 |
| jump | 0.6 | 0.4 | 0.3333 | 0.4 | 0.0 |
| kiss | 0.0667 | 0.0 | 0.1333 | 0.0 | 0.0 |
| mom | 0.0667 | 0.0667 | 0.1333 | 0.0667 | 0.0 |
| rain | 0.0 | 0.0 | 0.0 | 0.0 | 0.0 |
| shirt | 0.0667 | 0.1333 | 0.0667 | 0.2 | 0.0 |

22-output check: our models have the real 22-way head; top-1 when the argmax runs over all 22 outputs instead of only this mode's labels: {'ours_gru': 0.8932, 'ours_baseline': 0.829, 'islr1st_ourfeat': 0.8814}. The 14 classes without GISLR data never appear in training, so this only shows they do not steal answers; it is not a 22-class test.

## Systems

- `ours_gru`: the product classifier (recognition/model.py SignGRU, recognition/train.py) trained exactly as `recognition.benchmark` does per fold: one training signer held out for early stopping (max 60 epochs) and the temperature, then a refit on all 9 training signers. Our 141-number features (hands, arm pose, nose; no face mesh).
- `ours_baseline`: the product's fallback model (logistic regression on per-take statistics), same procedure.
- `islr1st_ourfeat`: the 1st-place network (Conv1D + Transformer, dim 192, 1.7M parameters) dropped into our training code instead of SignGRU: same features, augmentation, optimiser, early stopping and temperature. Only the network differs, so this isolates the architecture.
- `islr1st_retrained`: the 1st-place recipe ported to PyTorch (recognition/compare/islr1st.py): its 130 landmarks (lips, eyes, nose, both hands) normalised per clip, its augmentation, AdamW 5e-4 with cosine decay, label smoothing, late dropout, trained for a fixed number of epochs on the same 9 signers. Differences from the original: 1 seed (they ensembled 4), no AWP, CPU, far fewer steps; see the module docstring. It uses face points, which our product deliberately does not.
- `islr1st_pretrained`: the published 1st-place model (Hugging Face `sign/kaggle-asl-signs-1st-place`, MIT, sha256 f55a2bb1...), not retrained. In C7 its 7 shared-sign logits are softmaxed; in R8 its 250-way answer outside the 7 counts as NONE and the confidence is its own probability for the answer. It was trained on about 94k clips of 250 signs from 21 reported training signer IDs (identity provenance unresolved), including the 30 out-of-vocabulary signs used here, so its open-set numbers in R8 are not a test of unseen signs.

## Caveats

- Same landmarks for everyone: all systems read the same GISLR MediaPipe landmarks, so landmark quality (e.g. both hands are detected together in about 1% of frames, even for two-handed TIME and ROOM) affects all of them. GISLR fps (30 assumed) and the video aspect ratio are unknown; x and y are scaled by the phone image width and height separately.
- Training data differs by design between the retrained systems (about 830-1,000 clips of 7 signs per fold, plus NONE in R8) and the pretrained model (about 94k clips, 250 signs). The pretrained row is a 'best public model' reference, not an architecture comparison; `islr1st_ourfeat` and `islr1st_retrained` are.
- 10 signers, two of whom (11696, 6927) have no ROOM, THANK-YOU or TIME clips; per-signer accuracy varies a lot, so read the CIs and the paired tests, not only the point estimates.
- Three participants (11672, 2455, 34304) sign with the hand MediaPipe labels left. No system got test-time mirroring; all were trained with random left-right flips.
- 8 clips have gaps in their frame numbers; the converter closes the gaps (slightly faster motion).
- The NONE split (15 signs to train NONE, 15 others to test) was drawn once with seed 0; mom and girl (signed at the chin like THANK-YOU) landed in the test half.
- The pilot held out fold 2455 but used signer 48118 for validation; 48118 is later an outer test fold. The global epoch choice is exploratory, not a fully nested untouched-test design. The retrained model trains for 60 epochs (CPU budget; the original used 300 epochs on 94k clips on a TPU). A partial pilot (8 training signers, a 9th for validation, the fold's test signer unused) reached validation accuracy 0.85 after 10 and 0.91 after 20 epochs before it was stopped. Our systems keep the product defaults (at most 60 epochs, early stopping on an inner signer).
- The PyTorch port was checked against the authors' published Keras weights (seed 42): on 400 clips its top-1 matches the published TFLite model on 95% of clips (250-way accuracy 0.870 vs 0.895; the TFLite may ensemble several seeds).
- Rylo: there is no Rylo sign-to-text to measure (its public sign-to-spoken screen plays a fixed script), so it has no row. See recognition/compare/README.md.

## What each number means

- **top-1**: share of test clips whose single best answer is the true sign. In the 7-class mode, guessing gives 1/7 = 0.14; in the 8-class mode a sign clip answered NONE counts as wrong.
- **[95% CI]**: the range the number would likely fall in for another group of signers like these. It is computed by re-drawing the signers (not the clips) with replacement 2,000 times, because clips from one person are not independent and the question is how the system does for a new person. With 10 signers these ranges are wide; two systems whose ranges overlap may not really differ, so see the paired tests.
- **top-3**: share of clips where the true sign is among the three answers returned. With only 7 classes this is easy (3/7 = 0.43 by chance) and says little.
- **macro-F1**: for each sign, F1 combines precision (when the system says this sign, how often it is right) and recall (how many clips of this sign it finds); the per-sign values are averaged with equal weight, so ignoring a hard sign is penalised. 1 is perfect.
- **open-set false accept**: clips of signs OUTSIDE the vocabulary (other real ASL signs by the same held-out person) that the demo rule would speak as one of our signs (top confidence >= 0.6 and not NONE). This measures "refuses to guess". Lower is better. n = number of such clips.
- **coverage@0.6**: share of in-vocabulary clips where the top confidence is at least 0.6, so the demo would speak instead of asking the guest to repeat.
- **accuracy@0.6**: among those spoken clips, the share that are right. It should be clearly above top-1 if the confidence means something.
- **ECE**: calibration error. Clips are grouped by confidence (0-0.1, ..., 0.9-1) and the gap between average confidence and actual accuracy is averaged. 0 = "confidence 0.8 is right 80% of the time".
- **p50 latency**: median CPU time for one clip (feature extraction + model), one clip at a time, 2 threads, this Mac. Excludes MediaPipe landmark extraction, which every landmark-based system needs equally.
- **paired difference**: system A minus system B on exactly the same clips. CI and p come from re-drawing signers; the exact McNemar p treats clips as independent and is therefore optimistic.
