# Track B: our 22 classes, same video clips for every system (smoke)

> **PLUMBING SMOKE TEST.** Generated clips with no real signing. These numbers mean nothing about accuracy. Track B status: **awaiting real held-out recordings**; no Track B result exists.

6 clips in total; every system is scored on the 5 clips that ALL systems answered. No-answer rate per system (on all clips): `manual_demo` 0.1667, `ours_gru` 0.0

| system | test set | #signers | #clips | signer-held-out | top-1 [95% CI] | macro-F1 [95% CI] | open-set false accept [95% CI] | coverage@0.6 | accuracy@0.6 | wrong sign spoken | p50 latency | training data | data that leaves the device |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `manual_demo` | team clips (smoke) | 1 | 4 | per recording protocol | 0.500 [0.500, 0.500] | 0.556 [0.556, 0.556] | 0.000 [0.000, 0.000] (n=1) | - | - | 0.250 | - | competitor product (unknown) | whatever that product sends; check its terms |
| `ours_gru` | team clips (smoke) | 1 | 4 | per recording protocol | 0.250 [0.250, 0.250] | 0.167 [0.167, 0.167] | 0.000 [0.000, 0.000] (n=1) | 0.000 | - | 0.000 | 0.2 ms | the checkpoint in the Track B manifest | nothing: landmarks only, processed locally |

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
