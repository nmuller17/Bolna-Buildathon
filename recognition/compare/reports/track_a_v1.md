# Track A (protocol): Deaf signers, 7 shared signs, leave-one-signer-out

> **NOT A PRODUCT ACCURACY RESULT.** Track A covers 7 of our 21 signs on public GISLR clips, without the live segmenter or framing gate. Scope of every number below: our training recipe retrained per fold on 9 GISLR participants; not the shipped model, not the live pipeline, not the 22-sign hotel vocabulary. All four compared systems passed the manifest checks.

Created 2026-10-11T13:28:15+00:00. Protocol sha256 `ac59252ac6aa9dc6e83a3bc89bd0eb52afc1d2a1f8a1f628e533583e81a6413f` (recognition/compare/PROTOCOL.md; written after the legacy exploratory results on the same clips were seen, see AMENDMENTS.md item 10). Run folder `data/compare/track_a_v1`. Clip index fingerprint `8626d72cf79d...`.

Test data: GISLR rerun set (Kaggle `sohier/461054610546105`, the competition's hidden test set; CC0 per Kaggle metadata), 10 Deaf participant IDs, 1105 clips of the 7 shared signs (YES, NO, THANK-YOU, WHERE, TIME, PLEASE, ROOM) plus the held-out person's clips of 15 outside signs (airplane, apple, cloud, cry, dog, fish, flower, frog, girl, hat, jump, kiss, mom, rain, shirt) for the open-set test. Every compared system is trained on the same 9 participants per fold (7 signs + NONE from 15 other signs: bird, book, cat, cow, dance, drink, elephant, happy, horse, lion, pig, sad, scissors, tree, zipper) and tested on the 10th; epochs and temperature are chosen on an inner training signer only.

## Primary endpoint (registered in PROTOCOL.md before the v1 run; NOT a blind pre-registration)

> Labels that go with every quote of this result: **endpoint and margin chosen after exploratory results on the same test set were seen (AMENDMENTS.md item 10)**; **margin not yet confirmed by Talha (AMENDMENTS.md items 1 and 14)**; scope: our training recipe retrained per fold on 9 GISLR participants; not the shipped model, not the live pipeline, not the 22-sign hotel vocabulary. `islr1st_retrained` = GISLR 1st-place network and recipe, PyTorch port, at most 60 epochs, 1 seed, no AWP, CPU, about 1,200 training clips per fold; not the winner's full 300-epoch recipe.

`ours_gru` minus `islr1st_retrained`, C7 top-1, GISLR rerun 7 signs, 10 signers, 1105 clips, signer-held-out: difference **+0.006** [95% CI -0.029, +0.048] (pooled signer bootstrap, as registered), signer-bootstrap p = 0.774 (exact McNemar p = 0.51, 45 vs 38 clips only one system got right). Verdict by the registered rule (margin -0.05): **ours_gru not worse by more than 0.05 (CI lower bound above -0.05); no detectable difference**.

Interval sensitivity (AMENDMENTS.md item 12; 10 signers is few, so the interval method matters):

| analysis | difference | 95% CI | verdict category by the same rule |
|---|---|---|---|
| pooled signer bootstrap (registered) | +0.006 | [-0.029, +0.048] | ours_gru not worse by more than 0.05 |
| unweighted per-signer mean, t (df 9) | +0.001 | [-0.066, +0.067] | inconclusive |
| cluster-robust t, pooled (df 9) | +0.006 | [-0.040, +0.053] | ours_gru not worse by more than 0.05 |
| exact sign-flip test on per-signer sums | +0.006 | p = 0.7812 | - |

Overall reading: **not worse by more than 5 points under the pre-registered pooled bootstrap only; inconclusive under per-signer weighting**.

Per-signer differences (A minus B): 11672 +0.016, 11696 +0.028, 14938 +0.000, 15662 +0.008, 23662 -0.079, 2455 +0.000, 32536 +0.193, 34304 +0.015, 48118 +0.007, 6927 -0.182.

The product axis next to it (AMENDMENTS.md item 13; R8 = 7 signs or NONE, product rule: speak the top-1 sign only when its confidence is >= 0.6 and it is not NONE; signer-bootstrap 95% CIs):

| system | wrong sign spoken, in-vocabulary clips [95% CI] | outside-vocabulary sign spoken as one of ours (open-set false accept) [95% CI] |
|---|---|---|
| `ours_gru` | 0.032 [0.015, 0.060] (10 signers, 1105 clips) | 0.160 [0.113, 0.211] (10 signers, 225 clips) |
| `islr1st_retrained` | 0.015 [0.004, 0.029] (10 signers, 1105 clips) | 0.107 [0.054, 0.161] (10 signers, 225 clips) |
| `ours_gru` minus `islr1st_retrained` (paired) | +0.017 [+0.003, +0.040] | +0.053 [+0.004, +0.096] |

Lower is better in both columns. Never quote the C7 primary without this table.

## Epoch-cap sensitivity (AMENDMENTS.md item 11): every network re-run with a 200-epoch cap

Same folds, inner split, nested rule and training code; only the cap (and with it the cosine schedule) changes. Descriptive only; no verdict of its own.

Status: `ours_gru` 10/10 folds; `islr1st_retrained` 10/10 folds; `islr1st_ourfeat` 10/10 folds

| system | #signers | #clips | C7 top-1 [95% CI] | R8 wrong sign spoken [95% CI] | R8 open-set false accept [95% CI] |
|---|---|---|---|---|---|
| `ours_gru` (cap 200) | 10 | 1105 | 0.921 [0.871, 0.957] | 0.033 [0.017, 0.061] | 0.151 [0.098, 0.204] |
| `islr1st_retrained` (cap 200) | 10 | 1105 | 0.908 [0.835, 0.956] | 0.010 [0.002, 0.021] | 0.116 [0.058, 0.170] |
| `islr1st_ourfeat` (cap 200) | 10 | 1105 | 0.912 [0.860, 0.950] | 0.029 [0.013, 0.051] | 0.156 [0.101, 0.217] |

| C7 top-1 contrast | #signers | #clips | diff [bootstrap 95% CI] | per-signer t 95% CI | cluster-robust t 95% CI | sign-flip p | category by the primary rule |
|---|---|---|---|---|---|---|---|
| ours_gru (60) minus islr1st_retrained (200) | 10 | 1105 | +0.014 [-0.022, +0.055] | [-0.059, +0.074] | [-0.032, +0.059] | 0.5625 | ours_gru not worse by more than 0.05 |
| ours_gru (200) minus islr1st_retrained (200) | 10 | 1105 | +0.014 [-0.023, +0.055] | [-0.060, +0.074] | [-0.033, +0.060] | 0.5586 | ours_gru not worse by more than 0.05 |
| ours_gru (200) minus islr1st_ourfeat (200) | 10 | 1105 | +0.009 [-0.002, +0.019] | [-0.006, +0.023] | [-0.004, +0.022] | 0.1719 | ours_gru not worse by more than 0.05 |

**Primary verdict category unchanged when `islr1st_retrained` is trained with the 200-epoch cap.**

## Mode C7: forced choice among the 7 signs (NONE removed)

| system | test set | #signers | #clips | signer-held-out | top-1 [95% CI] | macro-F1 [95% CI] | open-set false accept [95% CI] | coverage@0.6 | accuracy@0.6 | wrong sign spoken | p50 latency | training data | data that leaves the device |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ours_gru` | GISLR rerun, 7 shared signs (C7) | 10 | 1105 | yes: leave-one-signer-out | 0.921 [0.870, 0.958] | 0.920 [0.867, 0.957] | 0.369 [0.286, 0.448] (n=225) | 0.930 | 0.950 | 0.046 [0.024, 0.082] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `ours_baseline` | GISLR rerun, 7 shared signs (C7) | 10 | 1105 | yes: leave-one-signer-out | 0.878 [0.809, 0.929] | 0.875 [0.802, 0.928] | 0.502 [0.444, 0.565] (n=225) | 0.870 | 0.947 | 0.046 [0.020, 0.087] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_ourfeat` | GISLR rerun, 7 shared signs (C7) | 10 | 1105 | yes: leave-one-signer-out | 0.919 [0.871, 0.955] | 0.918 [0.868, 0.955] | 0.382 [0.322, 0.446] (n=225) | 0.891 | 0.965 | 0.032 [0.015, 0.056] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_retrained` | GISLR rerun, 7 shared signs (C7) | 10 | 1105 | yes: leave-one-signer-out | 0.915 [0.843, 0.958] | 0.914 [0.841, 0.958] | 0.258 [0.165, 0.351] (n=225) | 0.862 | 0.977 | 0.020 [0.004, 0.041] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |

Paired differences on the same clips (A minus B; signer-bootstrap 95% CI and p; exact McNemar p on top-1):

| A - B | #signers | #clips | top-1 diff [CI] p | McNemar p (A-only vs B-only right) | macro-F1 diff [CI] | false-accept diff [CI] (negative = A refuses more) |
|---|---|---|---|---|---|---|
| ours_gru - ours_baseline | 10 | 1105 | +0.043 [+0.019, +0.072] p=<0.0005 | 3e-06 (76 vs 28) | +0.045 [+0.018, +0.076] | -0.133 [-0.198, -0.072] (n=225) |
| ours_gru - islr1st_ourfeat | 10 | 1105 | +0.002 [-0.012, +0.013] p=0.793 | 0.9 (31 vs 29) | +0.002 [-0.012, +0.013] | -0.013 [-0.084, +0.051] (n=225) |
| ours_gru - islr1st_retrained | 10 | 1105 | +0.006 [-0.029, +0.048] p=0.774 | 0.51 (45 vs 38) | +0.006 [-0.031, +0.048] | +0.111 [+0.063, +0.162] (n=225) |
| ours_baseline - islr1st_ourfeat | 10 | 1105 | -0.042 [-0.068, -0.021] p=<0.0005 | <1e-6 (18 vs 64) | -0.043 [-0.070, -0.021] | +0.120 [+0.040, +0.193] (n=225) |
| ours_baseline - islr1st_retrained | 10 | 1105 | -0.037 [-0.070, -0.008] p=0.010 | 0.00014 (36 vs 77) | -0.039 [-0.074, -0.009] | +0.244 [+0.184, +0.308] (n=225) |

Per-signer top-1 (every signer was absent from the compared systems' training):

| signer | ours_gru | ours_baseline | islr1st_ourfeat | islr1st_retrained | #clips |
|---|---|---|---|---|---|
| 2455 | 0.9621 | 0.9015 | 0.947 | 0.9621 | 132 |
| 6927 | 0.6364 | 0.6818 | 0.7273 | 0.8182 | 44 |
| 11672 | 0.881 | 0.7857 | 0.8889 | 0.8651 | 126 |
| 11696 | 0.9437 | 0.8732 | 0.9577 | 0.9155 | 71 |
| 14938 | 0.9606 | 0.9449 | 0.9606 | 0.9606 | 127 |
| 15662 | 0.9841 | 0.9603 | 0.9841 | 0.9762 | 126 |
| 23662 | 0.873 | 0.8333 | 0.873 | 0.9524 | 126 |
| 32536 | 0.7955 | 0.6477 | 0.75 | 0.6023 | 88 |
| 34304 | 0.9773 | 0.9848 | 0.9848 | 0.9621 | 132 |
| 48118 | 0.9774 | 0.9549 | 0.9549 | 0.9699 | 133 |

Per-class recall:

| sign | ours_gru | ours_baseline | islr1st_ourfeat | islr1st_retrained |
|---|---|---|---|---|
| NO | 0.903 | 0.8848 | 0.9212 | 0.897 |
| PLEASE | 0.9659 | 0.9261 | 0.9659 | 0.9659 |
| ROOM | 0.8936 | 0.8156 | 0.9078 | 0.8723 |
| THANK-YOU | 0.9441 | 0.8741 | 0.9091 | 0.9301 |
| TIME | 0.9058 | 0.8406 | 0.8841 | 0.8841 |
| WHERE | 0.9118 | 0.8882 | 0.9235 | 0.9059 |
| YES | 0.9186 | 0.8953 | 0.9128 | 0.936 |

Confusion matrix, `ours_gru` (C7, 10 signers, 1105 clips):

| true \ answer | YES | NO | THANK-YOU | WHERE | TIME | PLEASE | ROOM |
|---|---|---|---|---|---|---|---|
| YES | 158 | 0 | 0 | 2 | 9 | 1 | 2 |
| NO | 1 | 149 | 0 | 6 | 6 | 1 | 2 |
| THANK-YOU | 0 | 1 | 135 | 0 | 0 | 1 | 6 |
| WHERE | 4 | 6 | 0 | 155 | 4 | 0 | 1 |
| TIME | 4 | 0 | 2 | 5 | 125 | 1 | 1 |
| PLEASE | 1 | 0 | 0 | 0 | 1 | 170 | 4 |
| ROOM | 2 | 3 | 4 | 2 | 0 | 4 | 126 |

Confusion matrix, `ours_baseline` (C7, 10 signers, 1105 clips):

| true \ answer | YES | NO | THANK-YOU | WHERE | TIME | PLEASE | ROOM |
|---|---|---|---|---|---|---|---|
| YES | 154 | 3 | 1 | 5 | 6 | 0 | 3 |
| NO | 7 | 146 | 1 | 6 | 3 | 1 | 1 |
| THANK-YOU | 0 | 1 | 125 | 1 | 8 | 7 | 1 |
| WHERE | 4 | 8 | 0 | 151 | 6 | 0 | 1 |
| TIME | 8 | 1 | 6 | 5 | 116 | 0 | 2 |
| PLEASE | 1 | 0 | 3 | 1 | 0 | 163 | 8 |
| ROOM | 3 | 3 | 9 | 4 | 2 | 5 | 115 |

Confusion matrix, `islr1st_ourfeat` (C7, 10 signers, 1105 clips):

| true \ answer | YES | NO | THANK-YOU | WHERE | TIME | PLEASE | ROOM |
|---|---|---|---|---|---|---|---|
| YES | 157 | 1 | 2 | 3 | 8 | 0 | 1 |
| NO | 3 | 152 | 0 | 5 | 2 | 0 | 3 |
| THANK-YOU | 1 | 0 | 130 | 1 | 4 | 5 | 2 |
| WHERE | 1 | 7 | 0 | 157 | 3 | 1 | 1 |
| TIME | 8 | 1 | 2 | 3 | 122 | 0 | 2 |
| PLEASE | 1 | 0 | 0 | 2 | 0 | 170 | 3 |
| ROOM | 2 | 0 | 5 | 3 | 0 | 3 | 128 |

Confusion matrix, `islr1st_retrained` (C7, 10 signers, 1105 clips):

| true \ answer | YES | NO | THANK-YOU | WHERE | TIME | PLEASE | ROOM |
|---|---|---|---|---|---|---|---|
| YES | 161 | 2 | 0 | 2 | 5 | 0 | 2 |
| NO | 7 | 148 | 1 | 3 | 3 | 2 | 1 |
| THANK-YOU | 2 | 0 | 133 | 0 | 3 | 3 | 2 |
| WHERE | 3 | 4 | 1 | 154 | 7 | 0 | 1 |
| TIME | 6 | 2 | 1 | 5 | 122 | 1 | 1 |
| PLEASE | 1 | 1 | 1 | 1 | 0 | 170 | 2 |
| ROOM | 4 | 0 | 4 | 3 | 0 | 7 | 123 |

Open-set false accept per outside sign:

| outside sign | ours_gru | ours_baseline | islr1st_ourfeat | islr1st_retrained |
|---|---|---|---|---|
| airplane | 0.4667 | 0.6 | 0.4667 | 0.2667 |
| apple | 0.4667 | 0.6667 | 0.4667 | 0.5333 |
| cloud | 0.2 | 0.2667 | 0.2 | 0.1333 |
| cry | 0.1333 | 0.7333 | 0.0667 | 0.2 |
| dog | 0.3333 | 0.7333 | 0.3333 | 0.2 |
| fish | 0.6667 | 0.6667 | 0.6667 | 0.5333 |
| flower | 0.1333 | 0.3333 | 0.2 | 0.0 |
| frog | 0.6 | 0.6 | 0.6667 | 0.2667 |
| girl | 0.4667 | 0.6 | 0.4 | 0.2667 |
| hat | 0.0667 | 0.4667 | 0.0667 | 0.2 |
| jump | 0.6667 | 0.5333 | 0.4 | 0.4 |
| kiss | 0.4667 | 0.0 | 0.3333 | 0.2 |
| mom | 0.2667 | 0.3333 | 0.6667 | 0.3333 |
| rain | 0.2667 | 0.3333 | 0.2667 | 0.0667 |
| shirt | 0.3333 | 0.6667 | 0.5333 | 0.2667 |

Sensitivity (registered in PROTOCOL.md): only the 6 private-leaderboard signers (2455, 11672, 15662, 32536, 34304, 48118), whose clips could not influence the published winner's model selection:

| system | test set | #signers | #clips | signer-held-out | top-1 [95% CI] | macro-F1 [95% CI] | open-set false accept [95% CI] | coverage@0.6 | accuracy@0.6 | wrong sign spoken | p50 latency | training data | data that leaves the device |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ours_gru` | GISLR rerun, 7 shared signs, private 6 (C7) | 6 | 737 | yes: leave-one-signer-out | 0.938 [0.882, 0.977] | 0.937 [0.881, 0.977] | - | 0.935 | 0.961 | 0.037 [0.017, 0.067] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `ours_baseline` | GISLR rerun, 7 shared signs, private 6 (C7) | 6 | 737 | yes: leave-one-signer-out | 0.886 [0.788, 0.958] | 0.885 [0.790, 0.957] | - | 0.895 | 0.949 | 0.046 [0.013, 0.099] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_ourfeat` | GISLR rerun, 7 shared signs, private 6 (C7) | 6 | 737 | yes: leave-one-signer-out | 0.928 [0.863, 0.972] | 0.928 [0.864, 0.972] | - | 0.902 | 0.968 | 0.029 [0.009, 0.059] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_retrained` | GISLR rerun, 7 shared signs, private 6 (C7) | 6 | 737 | yes: leave-one-signer-out | 0.906 [0.799, 0.968] | 0.906 [0.800, 0.968] | - | 0.860 | 0.972 | 0.024 [0.001, 0.052] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |

## Mode R8: 7 signs or NONE (the product setting)

| system | test set | #signers | #clips | signer-held-out | top-1 [95% CI] | macro-F1 [95% CI] | open-set false accept [95% CI] | coverage@0.6 | accuracy@0.6 | wrong sign spoken | p50 latency | training data | data that leaves the device |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ours_gru` | GISLR rerun, 7 shared signs (R8) | 10 | 1105 | yes: leave-one-signer-out | 0.893 [0.827, 0.945] | 0.913 [0.856, 0.955] | 0.160 [0.113, 0.211] (n=225) | 0.878 | 0.964 | 0.032 [0.015, 0.060] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `ours_baseline` | GISLR rerun, 7 shared signs (R8) | 10 | 1105 | yes: leave-one-signer-out | 0.829 [0.731, 0.908] | 0.864 [0.781, 0.924] | 0.116 [0.073, 0.166] (n=225) | 0.781 | 0.965 | 0.027 [0.013, 0.050] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_ourfeat` | GISLR rerun, 7 shared signs (R8) | 10 | 1105 | yes: leave-one-signer-out | 0.881 [0.816, 0.936] | 0.907 [0.851, 0.949] | 0.133 [0.094, 0.178] (n=225) | 0.836 | 0.972 | 0.024 [0.012, 0.039] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_retrained` | GISLR rerun, 7 shared signs (R8) | 10 | 1105 | yes: leave-one-signer-out | 0.899 [0.823, 0.945] | 0.912 [0.842, 0.954] | 0.107 [0.054, 0.161] (n=225) | 0.816 | 0.982 | 0.015 [0.004, 0.029] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |

Paired differences on the same clips (A minus B; signer-bootstrap 95% CI and p; exact McNemar p on top-1):

| A - B | #signers | #clips | top-1 diff [CI] p | McNemar p (A-only vs B-only right) | macro-F1 diff [CI] | false-accept diff [CI] (negative = A refuses more) |
|---|---|---|---|---|---|---|
| ours_gru - ours_baseline | 10 | 1105 | +0.064 [+0.028, +0.105] p=<0.0005 | <1e-6 (99 vs 28) | +0.048 [+0.020, +0.082] | +0.044 [-0.004, +0.091] (n=225) |
| ours_gru - islr1st_ourfeat | 10 | 1105 | +0.012 [-0.007, +0.030] p=0.255 | 0.18 (46 vs 33) | +0.005 [-0.013, +0.018] | +0.027 [-0.005, +0.059] (n=225) |
| ours_gru - islr1st_retrained | 10 | 1105 | -0.005 [-0.041, +0.030] p=0.784 | 0.63 (50 vs 56) | +0.001 [-0.033, +0.034] | +0.053 [+0.004, +0.096] (n=225) |
| ours_baseline - islr1st_ourfeat | 10 | 1105 | -0.052 [-0.091, -0.022] p=<0.0005 | <1e-6 (31 vs 89) | -0.043 [-0.075, -0.021] | -0.018 [-0.053, +0.016] (n=225) |
| ours_baseline - islr1st_retrained | 10 | 1105 | -0.070 [-0.127, -0.023] p=<0.0005 | <1e-6 (37 vs 114) | -0.048 [-0.095, -0.012] | +0.009 [-0.028, +0.051] (n=225) |

Per-signer top-1 (every signer was absent from the compared systems' training):

| signer | ours_gru | ours_baseline | islr1st_ourfeat | islr1st_retrained | #clips |
|---|---|---|---|---|---|
| 2455 | 0.9545 | 0.8864 | 0.9394 | 0.947 | 132 |
| 6927 | 0.6364 | 0.6818 | 0.7273 | 0.7955 | 44 |
| 11672 | 0.8175 | 0.6429 | 0.746 | 0.8651 | 126 |
| 11696 | 0.9437 | 0.831 | 0.9437 | 0.9014 | 71 |
| 14938 | 0.9449 | 0.9291 | 0.9213 | 0.9449 | 127 |
| 15662 | 0.9762 | 0.9524 | 0.9762 | 0.9683 | 126 |
| 23662 | 0.8016 | 0.7063 | 0.7698 | 0.8968 | 126 |
| 32536 | 0.7045 | 0.5455 | 0.7386 | 0.5682 | 88 |
| 34304 | 0.9773 | 0.9773 | 0.9697 | 0.9545 | 132 |
| 48118 | 0.9624 | 0.9398 | 0.9549 | 0.9699 | 133 |

Per-class recall:

| sign | ours_gru | ours_baseline | islr1st_ourfeat | islr1st_retrained |
|---|---|---|---|---|
| NO | 0.8848 | 0.8364 | 0.8606 | 0.8848 |
| PLEASE | 0.9659 | 0.875 | 0.9489 | 0.9659 |
| ROOM | 0.8723 | 0.7589 | 0.8794 | 0.8511 |
| THANK-YOU | 0.8811 | 0.7902 | 0.8462 | 0.9021 |
| TIME | 0.8478 | 0.7754 | 0.8116 | 0.8406 |
| WHERE | 0.9118 | 0.8647 | 0.9059 | 0.8941 |
| YES | 0.8721 | 0.8721 | 0.8953 | 0.9302 |

Confusion matrix, `ours_gru` (R8, 10 signers, 1105 clips):

| true \ answer | YES | NO | THANK-YOU | WHERE | TIME | PLEASE | ROOM | NONE |
|---|---|---|---|---|---|---|---|---|
| YES | 150 | 0 | 0 | 2 | 8 | 0 | 2 | 10 |
| NO | 0 | 146 | 0 | 6 | 5 | 0 | 1 | 7 |
| THANK-YOU | 0 | 1 | 126 | 0 | 0 | 1 | 3 | 12 |
| WHERE | 1 | 6 | 0 | 155 | 3 | 0 | 1 | 4 |
| TIME | 3 | 0 | 2 | 5 | 117 | 0 | 1 | 10 |
| PLEASE | 1 | 0 | 0 | 0 | 0 | 170 | 3 | 2 |
| ROOM | 2 | 2 | 2 | 2 | 0 | 3 | 123 | 7 |

Confusion matrix, `ours_baseline` (R8, 10 signers, 1105 clips):

| true \ answer | YES | NO | THANK-YOU | WHERE | TIME | PLEASE | ROOM | NONE |
|---|---|---|---|---|---|---|---|---|
| YES | 150 | 1 | 1 | 4 | 5 | 0 | 2 | 9 |
| NO | 5 | 138 | 0 | 5 | 2 | 0 | 1 | 14 |
| THANK-YOU | 0 | 0 | 113 | 0 | 2 | 6 | 1 | 21 |
| WHERE | 2 | 7 | 0 | 147 | 4 | 0 | 1 | 9 |
| TIME | 6 | 0 | 3 | 5 | 107 | 0 | 2 | 15 |
| PLEASE | 1 | 0 | 1 | 1 | 0 | 154 | 6 | 13 |
| ROOM | 2 | 1 | 7 | 1 | 0 | 5 | 107 | 18 |

Confusion matrix, `islr1st_ourfeat` (R8, 10 signers, 1105 clips):

| true \ answer | YES | NO | THANK-YOU | WHERE | TIME | PLEASE | ROOM | NONE |
|---|---|---|---|---|---|---|---|---|
| YES | 154 | 1 | 1 | 3 | 6 | 0 | 0 | 7 |
| NO | 2 | 142 | 0 | 5 | 2 | 0 | 0 | 14 |
| THANK-YOU | 1 | 0 | 121 | 1 | 4 | 4 | 1 | 11 |
| WHERE | 0 | 7 | 0 | 154 | 2 | 0 | 1 | 6 |
| TIME | 5 | 0 | 2 | 3 | 112 | 0 | 0 | 16 |
| PLEASE | 1 | 0 | 0 | 0 | 0 | 167 | 2 | 6 |
| ROOM | 1 | 0 | 4 | 2 | 0 | 2 | 124 | 8 |

Confusion matrix, `islr1st_retrained` (R8, 10 signers, 1105 clips):

| true \ answer | YES | NO | THANK-YOU | WHERE | TIME | PLEASE | ROOM | NONE |
|---|---|---|---|---|---|---|---|---|
| YES | 160 | 2 | 0 | 2 | 3 | 0 | 2 | 3 |
| NO | 7 | 146 | 0 | 3 | 2 | 0 | 1 | 6 |
| THANK-YOU | 1 | 0 | 129 | 0 | 1 | 0 | 2 | 10 |
| WHERE | 2 | 3 | 0 | 152 | 7 | 0 | 1 | 5 |
| TIME | 6 | 2 | 1 | 5 | 116 | 1 | 1 | 6 |
| PLEASE | 1 | 1 | 1 | 1 | 0 | 170 | 1 | 1 |
| ROOM | 3 | 0 | 4 | 2 | 0 | 6 | 120 | 6 |

Open-set false accept per outside sign:

| outside sign | ours_gru | ours_baseline | islr1st_ourfeat | islr1st_retrained |
|---|---|---|---|---|
| airplane | 0.1333 | 0.0 | 0.0667 | 0.0 |
| apple | 0.1333 | 0.1333 | 0.0667 | 0.4667 |
| cloud | 0.0667 | 0.0 | 0.0667 | 0.0667 |
| cry | 0.0667 | 0.0667 | 0.0667 | 0.0 |
| dog | 0.1333 | 0.2 | 0.1333 | 0.0667 |
| fish | 0.5333 | 0.4667 | 0.4667 | 0.3333 |
| flower | 0.0 | 0.0 | 0.0 | 0.0 |
| frog | 0.2 | 0.0667 | 0.2 | 0.0 |
| girl | 0.3333 | 0.2 | 0.2667 | 0.1333 |
| hat | 0.0 | 0.0 | 0.0 | 0.0 |
| jump | 0.6 | 0.4 | 0.3333 | 0.3333 |
| kiss | 0.0667 | 0.0 | 0.1333 | 0.0 |
| mom | 0.0667 | 0.0667 | 0.1333 | 0.0667 |
| rain | 0.0 | 0.0 | 0.0 | 0.0 |
| shirt | 0.0667 | 0.1333 | 0.0667 | 0.1333 |

Sensitivity (registered in PROTOCOL.md): only the 6 private-leaderboard signers (2455, 11672, 15662, 32536, 34304, 48118), whose clips could not influence the published winner's model selection:

| system | test set | #signers | #clips | signer-held-out | top-1 [95% CI] | macro-F1 [95% CI] | open-set false accept [95% CI] | coverage@0.6 | accuracy@0.6 | wrong sign spoken | p50 latency | training data | data that leaves the device |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ours_gru` | GISLR rerun, 7 shared signs, private 6 (R8) | 6 | 737 | yes: leave-one-signer-out | 0.910 [0.829, 0.970] | 0.927 [0.863, 0.973] | - | 0.882 | 0.972 | 0.024 [0.011, 0.043] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `ours_baseline` | GISLR rerun, 7 shared signs, private 6 (R8) | 6 | 737 | yes: leave-one-signer-out | 0.841 [0.713, 0.948] | 0.878 [0.778, 0.954] | - | 0.807 | 0.966 | 0.027 [0.009, 0.055] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_ourfeat` | GISLR rerun, 7 shared signs, private 6 (R8) | 6 | 737 | yes: leave-one-signer-out | 0.897 [0.821, 0.963] | 0.920 [0.857, 0.970] | - | 0.848 | 0.978 | 0.019 [0.006, 0.035] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |
| `islr1st_retrained` | GISLR rerun, 7 shared signs, private 6 (R8) | 6 | 737 | yes: leave-one-signer-out | 0.897 [0.781, 0.962] | 0.907 [0.805, 0.966] | - | 0.822 | 0.980 | 0.016 [0.001, 0.036] | - | same folds: 9 GISLR signers | nothing: landmarks only, processed locally |

## Reference only: published GISLR 1st-place weights (`islr1st_pretrained`)

**Not a fair comparison and not in any paired test or open-set column.** It is a much larger model (3-seed ensemble) trained on about 94k clips of 250 signs from 21 other participant IDs. None of its training IDs is a test ID, but that IDs are different people is unverified; 4 of the 10 test signers (public leaderboard) influenced the winner's model selection; and all 30 outside signs are in its training vocabulary, so it has no valid open-set number.

| mode | how its answer is read | test set | #signers | #clips | top-1 [95% CI] | macro-F1 [95% CI] |
|---|---|---|---|---|---|---|
| C7 | softmax over its 7 shared-sign logits | all 10 signers | 10 | 1105 | 0.979 [0.957, 0.992] | 0.978 [0.954, 0.992] |
| C7 | softmax over its 7 shared-sign logits | private 6 | 6 | 737 | 0.980 [0.948, 0.996] | 0.980 [0.948, 0.996] |
| R8 | sum rule (NONE = all 243 other signs); rule fixed after alternatives were examined; not cleared | all 10 signers | 10 | 1105 | 0.823 [0.725, 0.890] | 0.900 [0.840, 0.941] |
| R8 | sum rule (NONE = all 243 other signs); rule fixed after alternatives were examined; not cleared | private 6 | 6 | 737 | 0.866 [0.765, 0.934] | 0.926 [0.860, 0.965] |
| R8_max_other | max-other rule (NONE = its best other sign); chosen after seeing results; not cleared | all 10 signers | 10 | 1105 | 0.900 [0.845, 0.938] | 0.947 [0.916, 0.967] |
| R8_max_other | max-other rule (NONE = its best other sign); chosen after seeing results; not cleared | private 6 | 6 | 737 | 0.925 [0.869, 0.965] | 0.960 [0.927, 0.982] |

## Caveats

- All systems read the same GISLR MediaPipe landmarks (phones, unknown fps and aspect ratio); both hands are detected together in about 1% of frames, which affects every system.
- 10 signers, two of whom (11696, 6927) have no ROOM, THANK-YOU or TIME clips; read the CIs and paired tests.
- Three participants (11672, 2455, 34304) sign with the hand MediaPipe labels left; no test-time mirroring.
- The 30 outside signs came from a hand-written list (no documented selection rule); mom and girl, signed at the chin like THANK-YOU, fell in the test half of the seed-0 split.
- `islr1st_retrained` is a PyTorch port (checked: 95% top-1 agreement with the published TFLite on 400 clips), 1 seed, no AWP, CPU, at most 60 epochs on about 1,200 clips.
- Rylo has no measurable sign-to-text (see README), so it has no row.

## What each number means

- **test set / #signers / #clips / signer-held-out**: which clips were scored, how many different people signed them, how many clips, and whether the people were absent from the system's training data.
- **top-1**: share of test clips whose single best answer is the true sign. In the 7-class mode (C7), guessing gives 1/7 = 0.14; in the 8-class mode (R8) a sign clip answered NONE counts as wrong.
- **[95% CI]**: the range the number would likely fall in for another group of signers like these. It is computed by re-drawing the signers (not the clips) with replacement 2,000 times, because clips from one person are not independent and the question is how the system does for a new person. With 10 signers (6 in the sensitivity table) these ranges are wide.
- **macro-F1**: for each sign, F1 combines precision (when the system says this sign, how often it is right) and recall (how many clips of this sign it finds); the per-sign values are averaged with equal weight, so ignoring a hard sign is penalised. 1 is perfect.
- **open-set false accept**: clips of 15 signs OUTSIDE the vocabulary (signed by the same held-out person, never seen by the compared systems) that the product rule would speak as one of our signs (top-1 confidence >= 0.6 and top-1 is not NONE). Lower is better. n = number of such clips. The pretrained reference has no value here because all these signs are in its training vocabulary.
- **coverage@0.6**: share of in-vocabulary clips the product rule would speak (top-1 confidence >= 0.6 and not NONE) instead of asking the guest to repeat.
- **accuracy@0.6**: among those spoken clips, the share that are right.
- **wrong sign spoken**: share of in-vocabulary clips where the product rule speaks a WRONG sign. Lower is better.
- **paired difference**: system A minus system B on exactly the same clips. The CI and p come from re-drawing signers; the exact McNemar p treats clips as independent and is therefore optimistic.
- **confusion matrix**: rows are the true sign, columns the top-1 answer; counts of clips.
