# recognition/compare: benchmarking our sign classifier against other models

**Audit status: NOT CLEARED FOR SLIDES OR MODEL ADOPTION.** The comparison rules are pre-registered in `PROTOCOL.md` (its sha256 is recorded in the hand-off progress notes). The earlier runs in `data/compare/track_a/` are exploratory: they have no manifests and the protocol report refuses them. Read `reports/audit.md` (regenerate with `python -m recognition.compare.audit`). The pretrained model is a separately labelled reference only. Track B is awaiting real held-out recordings.

This folder answers one question: on the same clips, how accurate is our recognizer compared with other models, and how often does it confidently say a wrong word? It has two tracks, because there is not yet one test set that every system can run on.

- **Track A** uses public data from Deaf signers. It covers only the 7 signs our vocabulary shares with the Kaggle GISLR dataset, with signer-held-out folds for every compared system. It can run today, under `PROTOCOL.md`.
- **Track B** covers our full 22 classes, on video clips the team records. Every system gets exactly the same clips, and our models go through the same capture-parity path as the live pipeline. The code has passed a synthetic smoke test, but there is no real result until someone records the held-out test clips (protocol below).

Results go to `recognition/compare/reports/`. Those files hold aggregate numbers only. Per-clip predictions, landmarks, model files and video stay in the gitignored `data/compare/`.

## Why there is no Rylo row

Rylo (which acquired sign.mt) has no working sign-to-text feature that we could measure. Its public "signed to spoken" screen plays a fixed script that ends in "What is your name?", whatever video it is given. We checked this in the open-source `sign/translate` code and in Rylo's live bundle on 2026-10-10. Its terms of use also forbid scraping (1.5(e)) and using the service to build a competing one (1.5(f)), and they say that what you upload may be used for training.

The honest claim is therefore: "Rylo has no working sign-to-text; ours reaches X on held-out signers." It is not "ours is more accurate than Rylo". If Rylo ships recognition later, Track B has a manual-entry importer for it. Get legal sign-off first.

## Track A: Deaf signers, 7 classes, leave-one-signer-out

**Data.** The test clips come from the GISLR rerun set (Kaggle `sohier/461054610546105`; CC0 according to Kaggle's dataset metadata), which is the competition's hidden test set and has 10 Deaf participants (Kaggle's public leaderboard used 4 of them: 6927, 11696, 14938, 23662; the private leaderboard the other 6). Our 7 shared signs give 1,105 clips. Another 450 clips of 30 other signs are used only as out-of-vocabulary negatives. Preparing the data (see the data-prep notes in `data/gislr/MANIFEST.json`) produces `data/gislr/`, `data/gislr_oov/` and `data/gislr_raw/`. Note that `tools/gislr_to_frames.py --download` has a bug with files larger than about 1 MiB, which Kaggle serves as zip archives. The data used here was fetched with a fixed downloader.

**Folds.** For each of the 10 participants, every system trains on the other 9 and is tested on that one, so all systems use the same folds and the same clips.

**One model per system and fold, scored two ways.** Each trained system learns 8 classes: the 7 signs plus NONE. NONE is 15 other GISLR signs, taken from the 9 training participants. Its answers on the held-out participant are then scored in two ways.

- **R8 (sign or NONE).** This is the product setting: the model may answer one of the 7 signs or NONE.
- **C7 (forced choice).** The probabilities are renormalised over the 7 signs only, so the model must name one of them. The pretrained model is scored the same way, using its 7 shared-sign logits.

The open-set test in both modes uses the held-out person's clips of 15 other signs. None of the compared (retrained) systems saw these signs or this person in training. The pretrained reference did see all 30 outside signs in training, so it is excluded from every open-set comparison. They include mom and girl, which are signed at the chin like THANK-YOU. The 15/15 split of the 30 outside signs was drawn once, with seed 0.

**Systems compared:**

| id | what it is | why it is in the table |
|---|---|---|
| `ours_gru` | Our SignGRU, trained exactly as `recognition.benchmark` trains it (an inner held-out signer for early stopping and the temperature, then a refit on all 9 training signers) | The product model |
| `ours_baseline` | Our logistic-regression fallback, trained the same way | Shows whether the deep model earns its place |
| `islr1st_ourfeat` | The GISLR 1st-place network dropped into our training code, with our features | Only the architecture changes |
| `islr1st_retrained` | The 1st-place network with its own preprocessing (130 points including lips and eyes), its augmentation and its optimiser, retrained on the same folds | The fair "their full recipe, our data" comparison |
| `islr1st_pretrained` | The published 1st-place weights (Hugging Face `sign/kaggle-asl-signs-1st-place`, MIT; byte-identical to the winner's Kaggle inference output, a 3-seed ensemble), not retrained. Trained on 94,477 clips of 250 signs from 21 participant IDs, none of which is one of our 10 test IDs (that the IDs are different people is unverified). The winner selected models partly on the public leaderboard, i.e. on 4 of our test signers. | Reference only: a much larger model trained on more signers. Never in a paired test or an open-set column; its R8 readings (sum rule and max-other) were both fixed after alternatives were examined and are not cleared (AMENDMENTS.md item 15). |

The PyTorch port in `islr1st.py` was checked against the authors' published Keras weights (seed 42). On 400 clips, its top-1 answer matches the published TFLite model on 95% of them, and its 250-way accuracy is 0.870 against 0.895 for the TFLite. The TFLite file may be an ensemble of several seeds, which would explain the gap. Run `python -m recognition.compare.check_islr1st_port` to repeat the check.

**Commands** (run from the repo root, with the project `.venv`; the pretrained model runs in the separate bench venv):

```bash
# one-time: bench venv for TFLite / MediaPipe (keeps tensorflow-lite and mediapipe out of the product venv)
~/.local/bin/uv venv --python 3.12 ~/.venvs/signbridge-bench
~/.local/bin/uv pip install --python ~/.venvs/signbridge-bench/bin/python ai-edge-litert numpy pandas pyarrow mediapipe opencv-python-headless anthropic h5py
# one-time: the published 1st-place model (sha256 f55a2bb1ebe6d1e912a98e31c6ef3f995c9ae261f408fe115f2008099d3f0bb7 is checked before use)
mkdir -p data/compare/ext/islr1st_hf && cd data/compare/ext/islr1st_hf && \
  curl -LO https://huggingface.co/sign/kaggle-asl-signs-1st-place/resolve/main/model.tflite && \
  curl -LO https://huggingface.co/sign/kaggle-asl-signs-1st-place/resolve/main/sign_to_prediction_index_map.json && cd -

python -m recognition.compare.track_a_gislr index                 # clip list; refuses an index that differs from PROTOCOL.md
python -m recognition.compare.track_a_gislr run --workers 5       # 40 protocol jobs + pretrained reference, with manifests; resumable
python -m recognition.compare.track_a_gislr latency               # separately, only on an idle machine (refuses if load > 2)
python -m recognition.compare.report --track a                    # -> reports/track_a_v1.md/.json; refuses results without a manifest
```

Outputs go to `data/compare/track_a_v1/` (`--out` changes it). A single job can be run with `python -m recognition.compare.track_a_gislr job --system ours_gru --fold 2455`; `--smoke` trains for 2 epochs and marks its manifest as a smoke test, which the report refuses. All seeds are fixed at 0. Each job writes `preds/<system>_<fold>.manifest.json` (signers, clip-list hashes, label counts, chosen epochs and temperature, code hashes, git commit, library versions, machine load, output hashes).

**Tuning (registered in PROTOCOL.md, nested; PROTOCOL.md was written after the legacy results on the same clips were seen, AMENDMENTS.md item 10).** Every network (ours_gru, islr1st_ourfeat, islr1st_retrained) uses the same rule inside each outer fold: one of the 9 training signers (chosen by `recognition.train.split`, seed 0) is held out, training runs for at most 60 epochs and keeps the epoch with the lowest validation loss (stop after 12 epochs without improvement), the temperature is fitted on that signer, and the model is refitted on all 9 training signers for the chosen number of epochs. The outer test signer is never used. The earlier global epoch pilot is no longer used by anything (its validation signer 48118 was an outer test fold).

**Epoch-cap sensitivity (AMENDMENTS.md item 11).** The winner trained for 300 epochs, so the 60-epoch cap can only shorten its recipe. `python -m recognition.compare.epoch_cap run` re-runs ours_gru, islr1st_retrained and islr1st_ourfeat with a 200-epoch cap and nothing else changed (same code, folds, inner split and rule), into `data/compare/track_a_v1_epochcap200/`. Run it from the same checkout as the protocol run (it refuses different training code); it never runs more than 6 Track A jobs machine-wide. The report prints it next to the primary, with per-signer t, cluster-robust t and an exact sign-flip test beside the registered bootstrap (item 12) and the R8 wrong-sign-spoken and false-accept rates of both systems (item 13). `reports/audit.md` holds the only cleared sentences.

## Track B: our 22 classes, the same video clips for every system

**Inputs.** Put clips at `data/track_b/clips/<LABEL>/<signer>_<n>.mp4`, where `<LABEL>` is one of the 22 classifier labels (NONE included). Clips of real signs that are not in our vocabulary go in `_OOV/<signer>_<sign>_<n>.mp4`; for those, NONE is the correct answer and they count towards the open-set false-accept rate. A pre-cleaned `<name>.json` next to an mp4 is accepted only by the smoke test: it carries no framing information and bypasses the live path, so real runs refuse it (AMENDMENTS.md item 16).

**Systems:**

- **Our models.** Each clip goes through the same capture-parity path as the live pipeline (`recognition/stream.py`) for one sign: HolisticLandmarker in VIDEO mode, `FrameAdapter(mode="capture", image_size=(w, h))` (that is `capture/landmarks.py` `to_frame` with the aspect correction, then `normalize`, face data minimised), the head-to-waist framing gate over the hand-visible frames, `capture.clean.clean` on the capture times, then `Recognizer.predict` (model hash pin, input validation, NONE without enough hands or pose). Since 2026-10-11 the clip is replayed through the real `recognition.stream.SignStream` (segmenter, segment extent, framing gate with its COME_CLOSER memory, `capture.clean.clean`), so the recognizer gets exactly what live would give it; tests check the replay frame for frame against `SignStream.push`/`flush` on the same MediaPipe results (one sign, resting hands, two signs, framing rejection). A clip the live path would not speak (no hands, no sign event, framing rejected) counts as NONE with confidence 0; a clip the stream splits into several signs is marked `split:N` and scored on its longest segment. `--how take` (the whole clip as one capture.py take) and `--no-gate` are sensitivity analyses only.
- **Claude vision (optional).** This is a closed-set baseline. Claude sees 16 evenly spaced frames (and 8 as a sensitivity check), cropped to the upper body and resized to a 640 px long edge, and must answer with one of the 22 labels through structured output. It runs only if `ANTHROPIC_API_KEY` is set and `--i-have-consent` is passed. Expect roughly $0.01 to $0.02 per clip with `claude-sonnet-5` (half that via the Batch API). Its stated confidence is not calibrated, so the report scores its label only.
- **Competitor (manual entry).** `template` copies the clips under random tokens next to a blinded CSV (no label, signer or file name in it) and writes the token-to-clip key to a separate folder; the person who plays each clip into the other product and copies its output text must not open the key. The importer then maps the free text to our labels. If one vocabulary word is found, that word is the answer; if several are found, all are kept in order of mention (the first is the answer, and on an outside-vocabulary clip it is a false accept); if none is found, the answer is NONE. An empty cell means "no answer". A filled `mapped_label` column overrides the automatic mapping, and reviewing that column by hand is recommended.

Every system is scored on every clip; a clip without an answer counts as wrong (AMENDMENTS.md item 18), and each system's no-answer rate is reported next to it.

```bash
python -m recognition.compare.track_b_video extract --clips data/track_b/clips --frames 16 8
python -m recognition.compare.track_b_video ours --clips data/track_b/clips --checkpoint recognition/models/model.pt --name ours_gru
python -m recognition.compare.track_b_video claude --clips data/track_b/clips --model claude-sonnet-5 --frames 16 --i-have-consent
python -m recognition.compare.track_b_video template --clips data/track_b/clips --system rylo --sheet data/track_b/blind/rylo.csv
python -m recognition.compare.track_b_video manual --csv data/track_b/blind/rylo.csv --clips data/track_b/clips --system rylo --key data/compare/track_b/blind_keys/rylo_key.json
python -m recognition.compare.report --track b --tag team
python -m recognition.compare.track_b_video smoke     # plumbing test on generated clips; numbers mean nothing
```

### Recording protocol for the Track B test set

1. **Signers not used in training.** Use a volunteer from another team, or better, a Deaf signer who agrees to take part. If only team members are available, record a person whose takes are not in `data/train/` and say so in the report. Two or more test signers make the confidence intervals mean something; with one signer, report per-clip results only.
2. **Consent first.** Get written consent that covers recording, local storage, and (only if Claude will be used) sending frames to Anthropic. Never record guests.
3. **Same setup as the demo.** Use the demo webcam at the demo resolution and distance, the unmirrored camera image, and a plain background. Recognition depends on the camera's aspect ratio.
4. **What to record.** For every one of the 22 classes, record 5 or more takes per signer, each with one isolated sign and the hands starting and ending at rest. For NONE, record idle hands, scratching, waving and reaching for the key card. Also record 10 or more `_OOV` takes of real signs outside the vocabulary, such as HELLO, BATHROOM and WATER.
5. **Keep everything local.** Store the clips only under `data/track_b/clips/`, which is gitignored. Never commit them and never upload them anywhere except the consented Claude run.
6. **Freeze before testing.** Train the model first and record its sha256. Do not look at test clips while training, and never add test clips to `data/train/`.

## Metrics

Every metric is defined in plain words at the bottom of each report. In short:

- **top-1**: the share of clips answered correctly, with a 95% CI computed by resampling signers (not clips).
- **Open-set false accept**: the share of clips of other signs that would be spoken as one of ours (confidence 0.6 or higher and not NONE). Lower is better. This measures whether the system refuses to guess.
- **coverage@0.6 / accuracy@0.6**: how often the demo would speak, and how often it is right when it does.
- **Paired tests**: the difference between two systems on identical clips, with a CI and p-value from resampling signers. An exact McNemar p-value is also given, but it is optimistic because it treats clips from the same signer as independent.

Never put these 7-class numbers next to published 250-class GISLR scores, or next to any other vocabulary, as if they were the same test.
