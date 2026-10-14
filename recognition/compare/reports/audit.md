# Benchmark audit — clearance decision (only the cleared sentences below may be used)

This audit checks saved evidence and corrects acceptance metrics. It does not validate real guest accuracy or authorize a model replacement.

Checked at 2026-10-11T13:32:02+00:00.

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

GISLR rerun set, 7 shared signs, in-vocabulary clips only; signer-held-out by participant ID only (identity unverified). Not pre-registered. Neither R8 rule is cleared: both were fixed after alternatives were examined (AMENDMENTS.md item 15). 95% CI over signers.

| signers | reading | #signers | #clips | top-1 [95% CI] |
|---|---|---|---|---|
| all 10 | C7 forced choice | 10 | 1105 | 0.979 [0.957, 0.992] |
| all 10 | R8, sum rule (fixed after alternatives were examined; not cleared) | 10 | 1105 | 0.823 [0.725, 0.890] |
| all 10 | R8, max-other (chosen after seeing results; not cleared) | 10 | 1105 | 0.900 [0.845, 0.938] |
| private 6 | C7 forced choice | 6 | 737 | 0.980 [0.948, 0.996] |
| private 6 | R8, sum rule (fixed after alternatives were examined; not cleared) | 6 | 737 | 0.866 [0.765, 0.934] |
| private 6 | R8, max-other (chosen after seeing results; not cleared) | 6 | 737 | 0.925 [0.869, 0.965] |

Protocol run folder `data/compare/track_a_v1`: 41 of 41 manifests present.

## Findings that prevent release

- Pretrained reference provenance: SEPARATE by participant ID (none of its 21 training IDs is one of the 10 test IDs); that IDs are different people is UNVERIFIED; 4 test signers (public leaderboard) influenced the winner's model selection. It may only appear as a separately labelled reference, never as a matched comparison.
- Pretrained OOV rejection is not a matched unseen-vocabulary test: all 30 outside signs belong to its original 250-label training vocabulary. PROTOCOL.md excludes it from every OOV comparison.
- Both pretrained R8 rejection rules were fixed after alternatives had been examined (max-other after comparing results; the sum rule afterwards, with p_none_sum already stored). No pretrained R8 figure is cleared (AMENDMENTS.md item 15).
- Legacy islr1st_retrained used a fixed 60 epochs informed by a global pilot whose validation signer (48118) is an outer test fold. PROTOCOL.md replaces it with nested per-fold early stopping; the legacy run must not be reported.
- Track A omits the live segmenter and framing gate and covers only seven hotel-vocabulary signs, not the 22-class product.
- Track B has no real held-out hotel-sign recordings. Our rows now replay recognition.stream (segmenter, extent, framing gate, clean) on the capture-parity landmarks, checked against SignStream.push/flush on the same MediaPipe results (synthetic results; no real video exists), and pre-cleaned files are refused; no Track B result exists until recordings are made.
- PROTOCOL.md (endpoint and -0.05 margin) was written after the legacy exploratory results on the same clips were seen, so Track A v1 is not a blind pre-registration (AMENDMENTS.md item 10). Talha has not confirmed the margin.
- The protocol caps every network at 60 epochs; the winner trained for 300. The 200-epoch-cap sensitivity analysis (AMENDMENTS.md item 11) is done and printed next to the primary; the winner's fixed 300-epoch setting without early stopping, its AWP and its seeds remain untested.
- With 10 signers the confidence-interval method can decide the non-inferiority verdict; per-signer t and cluster-robust t intervals and an exact sign-flip test are printed next to the registered bootstrap (AMENDMENTS.md item 12).
- The legacy runs did not store per-job manifests; the protocol report refuses them. The protocol re-run (data/compare/track_a_v1, 41 manifests) replaces them; only its figures, as worded in the cleared sentences, may be used.

## Metric corrections

- Coverage and accuracy on accepted answers now exclude NONE, including confident refusals. The earlier report counted them as spoken answers.
- Saved confidence values are no longer rounded before applying the 0.6 threshold. Historical predictions remain rounded; check boundary cases before using them.
- Paired comparisons reject duplicate clip IDs and inconsistent signer, label, or OOV metadata.
- A nondefault rejection threshold now applies consistently to open-set confidence intervals and per-sign rates.
- The pretrained R8 max-other vector is a score vector, not a normalized probability distribution; its ECE is suppressed.

## Independent-audit findings (2026-10-11) and what was done

| # | finding | outcome | how |
|---|---|---|---|
| 1 | PROTOCOL.md written after the legacy results were seen | accepted | Re-verified: v1 ours_gru and islr1st_ourfeat equal the legacy predictions (top-1 and confidences), ours_baseline the same top-1. AMENDMENTS.md item 10 discloses it; every primary quote carries the label. |
| 2 | Only the competitor's training rule changed (60-epoch cap vs 300) | accepted | Re-verified (fold 11672 inner loss still falling near best epoch 42; islr1st_ourfeat 14938 best epoch 54 of 60). AMENDMENTS.md item 11: every network re-run with a 200-epoch cap (recognition/compare/epoch_cap.py), reported next to the primary; qualifier attached to islr1st_retrained. Result: all 30 cap-200 jobs finished; under the nested rule early stopping, not the cap, ended training (islr1st_retrained ran 30-66 epochs, best 18-54); the primary difference moved from +0.6 to +1.4 points and its verdict category did not change. A fixed 300-epoch run without early stopping (the winner's own setting) remains untested. |
| 3 | With 10 signers the CI method decides the verdict | accepted | Re-verified exactly on the legacy data (bootstrap -0.039, cluster-robust t -0.043, per-signer t -0.078, sign-flip p 0.914). AMENDMENTS.md item 12: all three printed next to the registered bootstrap, with the prescribed wording when they disagree. |
| 4 | Product-relevant outside-vocabulary error is only secondary | accepted | AMENDMENTS.md item 13: the primary is always printed with R8 wrong-sign-spoken and open-set false accept (signer CIs, paired differences); wrong-sign-spoken now has a CI in every table. |
| 5 | Protocol and margin launched without Talha's sign-off | partly accepted | Still unconfirmed and labelled on every primary quote (AMENDMENTS.md item 14). Not applied: holding back the read until he confirms. He is asleep and asked for the run to finish overnight, the margin is frozen in the hashed file and amendments, and any later change is labelled post hoc. The non-inferiority VERDICT stays uncleared until he confirms. |
| 6 | Pretrained sum rule labelled pre-specified | accepted | Re-verified (sum 0.823 vs max-other 0.900 on the legacy raw file). AMENDMENTS.md item 15: label withdrawn, both rules printed side by side, no pretrained R8 figure cleared. |
| 7 | Track B parity test is plumbing on synthetic landmarks | accepted (partly limited) | prepare() now replays the real recognition.stream.SignStream; new tests check it frame for frame against SignStream.push/flush (one sign, resting hands, two signs, framing rejection); pre-cleaned files refused outside smoke. Limit: the results are still synthetic; no real video recording exists. |
| 8 | Track A ours_gru is a recipe, not the product | accepted | Scope label on every Track A claim and in the report header; data/gislr/MANIFEST.json identity and licence notes corrected. |

## Clearance decision

Only the sentences below may be used, verbatim, each with its bracketed scope label. Everything else is not cleared.

### Cleared sentences

1. [Integrity only; no accuracy claim] On the GISLR rerun Track A set (10 participant IDs, 1,105 in-vocabulary clips, 225 outside-vocabulary test clips), an independent re-check of all 41 protocol manifests (40 trained jobs and the pretrained reference) found that every compared system trained on the identical clip list per fold, never saw the held-out signer or any of the 15 test-only outside signs, used the same inner split, and used one set of training code; PROTOCOL.md sha256 ac59252a...6413f was unchanged.
2. [Exploratory, legacy-equivalent; our training recipe retrained per fold on 9 GISLR participants; NOT the shipped model, NOT the live pipeline, NOT our 22-sign hotel vocabulary] On 7 signs shared with GISLR, our GRU recipe trained on 9 GISLR participants and tested on the 10th reached 92.1% forced-choice top-1 (95% CI over signers 87.0-95.8%; 10 participant IDs, 1,105 clips, signer-held-out).
3. [Same scope] On those clips our GRU recipe was 4.3 percentage points more accurate than our logistic-regression baseline (paired on identical clips, 95% CI over signers +1.9 to +7.2; 10 signers, 1,105 clips, signer-held-out).
4. [Same scope, must be quoted together with the two sentences above] When the product rule speaks a sign only at confidence >=0.6, our GRU recipe spoke a wrong in-vocabulary sign on 3.2% of clips (95% CI 1.5-6.0%; 10 signers, 1,105 clips), and spoke one of our signs for 16.0% of clips of 15 unseen outside signs (95% CI 11.3-21.1%; 10 signers, 225 clips).
5. [Reference only, not a matched comparison] The published GISLR 1st-place ensemble, a much larger model trained on about 94k clips of 250 signs from 21 other participant IDs (that the IDs are different people is unverified; 4 of the 10 test signers influenced its selection), reached 97.9% forced-choice top-1 on the same 7 signs (95% CI 95.7-99.2%; 10 signers, 1,105 clips), and 98.0% on the 6 private-leaderboard signers only (95% CI 94.8-99.6%; 737 clips).
6. [Primary endpoint, DESCRIPTIVE ONLY (no verdict); endpoint and margin chosen after exploratory results on the same test set were seen; margin not yet confirmed by Talha; our training recipe retrained per fold on 9 GISLR participants; NOT the shipped model, NOT the live pipeline, NOT our 22-sign hotel vocabulary; competitor = PyTorch port of the GISLR 1st-place network and recipe, at most 60 epochs, 1 seed, no AWP, CPU, about 1,200 training clips per fold; quote the whole paragraph or none of it] On the 7 shared signs, our GRU recipe's forced-choice top-1 minus the retrained winner recipe's was +0.6 percentage points (95% CI over signers -2.9 to +4.8 by the registered pooled signer bootstrap; -6.6 to +6.7 for the unweighted per-signer mean; exact sign-flip p = 0.7812; 10 signers, 1,105 clips, signer-held-out). With the competitor recipe allowed up to 200 epochs (sensitivity analysis, same rule) the difference was +1.4 points (bootstrap 95% CI -2.2 to +5.5), and +1.4 points (-2.3 to +5.5) when both were allowed 200 epochs. In the product setting (speak only at confidence >=0.6, never NONE), ours spoke a wrong sign on 3.2% (1.5-6.0%) and the retrained winner recipe on 1.5% (0.4-2.9%) of 1,105 in-vocabulary clips, and they spoke one of our signs for 16.0% (11.3-21.1%) and 10.7% (5.4-16.1%) of 225 outside-vocabulary clips (10 signers).
7. [Secondary, descriptive; endpoint chosen after exploratory results on the same test set were seen; our training recipe retrained per fold on 9 GISLR participants; NOT the shipped model, NOT the live pipeline, NOT our 22-sign hotel vocabulary; quote the whole paragraph or none of it] Keeping our features and training code and changing only the network to the 1st-place architecture changed forced-choice top-1 by -0.2 percentage points (95% CI over signers -1.3 to +1.2; 10 signers, 1,105 clips, signer-held-out). With both allowed up to 200 epochs the change was -0.9 points (-1.9 to +0.2). Under the product rule it spoke a wrong sign on 2.4% (1.2-3.9%) of in-vocabulary clips and one of our signs for 13.3% (9.4-17.8%) of 225 outside-vocabulary clips, against 3.2% and 16.0% for our GRU recipe.

### Not cleared

- The non-inferiority VERDICT of the primary (registered rule: "ours_gru not worse by more than 0.05 (CI lower bound above -0.05); no detectable difference"; reading across interval methods: "not worse by more than 5 points under the pre-registered pooled bootstrap only; inconclusive under per-signer weighting"): not cleared until Talha confirms the -0.05 margin; even then it carries the labels above.
- "Our model is as accurate as / matches / beats the Kaggle winner", in any form. The pretrained winner is not a matched comparison; the retrained one is a constrained port.
- Any pretrained R8 / 8-way number (sum rule or max-other): both rules were fixed after alternatives were examined.
- Any pretrained open-set / outside-vocabulary / false-accept number: all 30 outside signs are in its 250-sign training vocabulary.
- Any statement that GISLR test signers are "distinct people" from the winner's training signers (verified by participant ID only).
- Any statement about product, live-pipeline or hotel-vocabulary (22-class) accuracy from Track A.
- Any Track B accuracy, false-accept or wrong-sign number: there are no real held-out recordings.
- Latency numbers measured on the shared, loaded machine.
- C7 (forced-choice) accuracy quoted without the R8 wrong-sign-spoken and false-accept rates next to it.
- Any "pre-registered" label on Track A v1 results without the disclosure that the legacy results were visible when PROTOCOL.md was written.
- Partial-fold numbers of any system or of the epoch-cap sensitivity run.

## Decision

Release status: only the cleared sentences above may be used; no product, live-pipeline or 22-sign accuracy claim is cleared, and no claim of matching or beating the Kaggle winner. Architecture: keep the GRU for now. Track A gives no evidence that the 1st-place architecture improves forced-choice accuracy (architecture-only change -0.2 points, 95% CI -1.3 to +1.2, 60-epoch cap; -0.9 points, -1.9 to +0.2, at a 200-epoch cap; 10 signers, 1,105 clips), so adopting it is not supported by this evidence. Recipe: the retrained winner recipe (its own preprocessing with face points, augmentation and optimiser) spoke fewer wrong signs and fewer outside-vocabulary signs under the product rule (see the primary paragraph; secondary, descriptive, no multiplicity correction). Whether to adopt parts of that recipe is Talha's decision; any such change should be specified before testing and checked on Track B, because Track A does not test the shipped model or the live path. Non-inferiority verdict: not cleared until Talha confirms the -0.05 margin, and even then it holds under the registered pooled bootstrap only (inconclusive under per-signer weighting). Product accuracy claims need Track B: a frozen, hashed model and real held-out recordings.

## Sources

- Kaggle rerun-set metadata (sohier/461054610546105, CC0, created by Kaggle staff 2023-02-17); its Usage column gives the public (6927, 11696, 14938, 23662) and private (2455, 11672, 15662, 32536, 34304, 48118) leaderboard signers.
- Local evidence: data/compare/track_a/index.json, preds/, models/, pilot_partial.log; data/gislr_raw/labels.parqet. Artifact hashes and check results are in audit.json.
- [Published model provenance](https://huggingface.co/sign/kaggle-asl-signs-1st-place).
- [Original winning implementation](https://github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution).
- [Dataset-creator paper](https://papers.nips.cc/paper_files/paper/2023/file/00dada608b8db212ea7d9d92b24c68de-Paper-Datasets_and_Benchmarks.pdf). The later PopSign release has a different population and split; it does not itself prove the identity mapping for this rerun set.
