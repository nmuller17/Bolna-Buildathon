# recognition (P3): sign classifier

This module turns one segmented sign, sent by the browser as a list of MediaPipe landmark frames, into the three most likely labels out of the 22 classifier classes in `docs/vocabulary.md` section 3. It never sees video: the browser runs MediaPipe and sends only landmark coordinates, which keeps the guest's face and surroundings on their own device and keeps the model small enough to run on a laptop CPU.

The pipeline is the same for training and serving. Each frame is re-normalized with the CLAUDE.md 6.2 rule (shoulder midpoint as origin, shoulder distance as unit), which is harmless if capture already did it and corrects any upstream difference. Each hand is given to `lh` or `rh` by whichever pose wrist it is closer to, so it does not matter how the landmarker labels handedness. The frames are then turned into a fixed 141-number row per frame (hand position and shape, upper body and nose; face landmarks are not used; layout documented at the top of `features.py`), resampled to 32 time steps, and passed to a small bidirectional GRU. A temperature fitted on a held-out signer may soften overconfident answers (T of 1 or more) but is never allowed to sharpen them, because sharpening on one easy validation signer made the model confidently wrong on a harder one.

## Data layout expected from capture.py

Training files go in `data/train/<LABEL>/<signer>_<n>.json`, where `<LABEL>` is exactly one of the 22 labels (for example `THANK-YOU`, `FS-WIFI`, `NONE`). Each file can be either a plain `Frame[]` list or a SignFile dict with a `frames` key (CLAUDE.md 6.1 and 6.3). The signer is taken from the SignFile `signer` field when there is one, otherwise from the file name (everything before the last underscore). Getting the signer right matters: the benchmark holds out one whole person at a time, and if every take looks like a different person it silently becomes optimistic, so the loader warns when the signer count looks wrong. Folders with unknown labels are skipped with a warning, files without any pose are skipped, parts with the wrong number of points are reported, and classes with no or very few takes are reported when loading.

## Commands

All commands run from the repository root with the project venv (`source .venv/bin/activate`). The server needs only the root `requirements.txt`; tests also need `pip install -r recognition/requirements-test.txt`.

```bash
# train (validation = one whole signer held out); --refit-all then retrains on everyone for the demo model
python -m recognition.train --data data/train --refit-all
# if the benchmark shows the simple baseline beating the GRU, train and serve that instead (same file, same server)
python -m recognition.train --data data/train --refit-all --model baseline

# benchmark: leave-one-signer-out, GRU vs baseline, latency -> recognition/reports/benchmark_team.md
python -m recognition.benchmark --data data/train --tag team

# evaluate a saved model on a separate folder in the same layout
python -m recognition.benchmark --checkpoint recognition/models/model.pt --test-data data/heldout --tag heldout

# serve (loads recognition/models/model.pt once at startup)
uvicorn recognition.server:app --host 127.0.0.1 --port 8000
# LAN / iPad: this launcher refuses a non-local host unless RECOGNITION_TOKEN is set
RECOGNITION_TOKEN=... RECOGNITION_ALLOWED_HOSTS=192.168.1.20 RECOGNITION_ALLOWED_ORIGINS=http://192.168.1.20:3000 \
  python -m recognition.server --host 0.0.0.0

# serve a mock so P4 is never blocked (no model needed; every 5th frame count gives a low-confidence answer)
RECOGNITION_MOCK=1 uvicorn recognition.server:app --host 127.0.0.1 --port 8000

# pipeline check without real data (SYNTHETIC trajectories, not real signs)
python -m recognition.tools.make_synthetic --out /tmp/synthetic_train
python -m recognition.train --data /tmp/synthetic_train --out /tmp/synthetic.pt

# optional public data (see "Public data" below): download the GISLR rerun files for our 7 signs, convert, train
pip install pandas pyarrow
python -m recognition.tools.gislr_to_frames --download --root data/gislr_raw --out data/gislr
python -m recognition.train --data data/train --extra-data data/gislr --refit-all

# tests
python -m pytest recognition/tests -q
```

The API is `POST /predict` with `{"frames": Frame[]}` returning `{"top": [{"label", "conf"} x 3]}` sorted by confidence, and `GET /health` returning `{status, model_loaded, classes, mock}`. The schema is strict: malformed input gets 422 (unknown keys such as `leftHand`, wrong point counts, strings or booleans instead of numbers, NaN, coordinates beyond plus or minus 50, an empty list, more than 300 frames). Bodies over 4 MB get 413, more than 8 requests at once get 429, a wrong or missing token gets 401 (checked before the body), an unknown `Host` header gets 400, and a missing or unloadable model gets 503. P4 should treat every non-200 answer like low confidence. The model is skipped and `NONE` is returned with confidence 0.98 when fewer than 10% of the frames contain a hand, or when fewer than 30% of the frames contain both shoulders (without shoulders the coordinates cannot be normalized, and the model would otherwise give confident nonsense).

## Privacy and security defaults

The server never logs request bodies or landmarks, never writes incoming frames to disk, and does not echo submitted data or file paths back in errors. The model does not use face landmarks at all, so the browser may send `face: null` and the prediction is unchanged. It binds to 127.0.0.1, accepts only `Host: localhost` or `127.0.0.1` (plus `RECOGNITION_ALLOWED_HOSTS`), which blocks DNS-rebinding pages, and CORS only allows the origins in `RECOGNITION_ALLOWED_ORIGINS` (default `http://localhost:3000,http://127.0.0.1:3000`). If you need to reach it from an iPad or another device on the network, use `python -m recognition.server --host 0.0.0.0`, which refuses to start without `RECOGNITION_TOKEN`; the token must then be sent in the `X-Recognition-Token` header, and the laptop's LAN address must be added to the host and origin allowlists. A token sent from browser code is visible to anyone using that browser, so it only keeps out other devices on the network, not the person at the screen. Never put port 8000 behind a tunnel such as ngrok. Checkpoints are loaded with `torch.load(weights_only=True)`, so a tampered `model.pt` passed around on chat cannot run code; a checkpoint from an older `train.py` is refused and must be retrained. `RECOGNITION_MODEL` points the server at a different checkpoint, and `RECOGNITION_MOCK=1` is announced in the log and in `/health` so it is not left on by accident.

## Reading the benchmark report

`recognition/reports/benchmark_<tag>.md` starts with a summary table comparing the GRU with a simple baseline (logistic regression on per-take averages, spreads, minima and maxima). Every metric is defined in plain words at the bottom of the report. The most important numbers for the demo are the accuracy on accepted answers and the "wrong sign spoken" rate: the first says how often the system is right when it is confident enough to speak, and the second says how often it would confidently say something the guest did not sign. Leave-one-signer-out numbers describe a person the model has never seen; a team member who also recorded training data will usually do better live. The per-class recall table shows which signs need more or cleaner captures, and the confusion matrix shows which pairs get mixed up. The "wrong sign spoken at T=1" row shows what the temperature changes, and the unknown-sign section (baseline only, because it needs one retraining per sign) estimates how often a sign outside the vocabulary is spoken as one of ours; on real data this is usually high, which is why broad `NONE` captures matter. If the GRU does not beat the baseline clearly on real captures, the deep model is not earning its keep on that data; the baseline also looks at the three thirds of each take separately, so it can tell movement direction. Reports made with the tag or data path containing "synthetic" carry a banner, because those numbers only prove that the code runs.

## Known limitations

- The training signers are four hearing, non-native signers, so the model learns their versions of the signs; native signers and new guests will be harder.
- It recognises isolated signs from a closed list of 21 plus `NONE`. It depends on the browser segmenter cutting one sign per segment and cannot follow continuous signing.
- Training landmarks come from Python MediaPipe Holistic (capture.py), while the live app uses the JavaScript tasks-vision landmarkers. The two can produce slightly different points (and different hand detection rates), which is a train/serve skew we have not measured. Recording a few takes through the browser pipeline and evaluating them with `--checkpoint ... --test-data ...` is the way to check it.
- MediaPipe x and y are divided by image width and height separately, so the shoulder normalization does not cancel a different camera aspect ratio. Capture and live use should use the same camera resolution (or the coordinates should be converted to pixels before normalizing).
- Browser selfie views are usually mirrored, and MediaPipe hand labels depend on whether the image was flipped. Hands are reassigned by the pose wrists, and training uses random left/right mirroring so the model tolerates a mirrored body and left-handed signers, but the browser should still feed MediaPipe the unmirrored camera image (mirror only the on-screen preview).
- A closed-set classifier will often speak a confident wrong word for a sign it was never trained on. Record varied `NONE` takes, and consider adding public out-of-vocabulary signs as `NONE` (`--oov-none`, below).
- `recognition/models/model.pt` is gitignored; whoever trains the demo model must share it with the person running the server.

## Public data

Only one public dataset is usable in the time we have: Kaggle "Google - Isolated Sign Language Recognition" (GISLR, 2023). It ships MediaPipe Holistic landmarks only (no video), in the same image-normalized, y-down coordinates we use, for 250 signs. Seven of our 21 signs are among them: `yes`, `no`, `please`, `thankyou`, `where`, `time`, `room` (checked against the 250-sign map downloaded from Kaggle). The other 14 (RESERVATION, NAME, ELEVATOR, FS-WIFI, PASSWORD, BREAKFAST, TOWEL, MORE, FS-CHECKOUT, LATE, PARKING, TAXI, HELP, RESTAURANT) are not in it, so it cannot replace our own captures.

- **Access.** The competition train set (about 40 GB, reported elsewhere, not checked) needs a Kaggle account and accepting the rules. A labelled re-run copy published by Kaggle staff (dataset `sohier/461054610546105`, 39,443 sequences, 10 participant IDs) can be downloaded file by file without logging in; we checked that both the labels file and a landmark file download (HTTP 200). Our 7 signs there are 1,105 sequences from 8 to 10 people per sign (about 556 MB by Kaggle's file listing). `--download` fetches exactly those (plus `--oov-none N` takes of every other sign if asked).
- **Licence.** The data card says CC BY 4.0, but the competition rules forbid redistributing the data. So: train on it and share model weights with attribution, but keep raw and converted files in the gitignored `data/` folder and never commit them or put them in `signs/`.
- **Signers.** The data card describes 21 Deaf signers who use ASL as their primary form of communication, recorded on Pixel 4a phones, some signing with the left hand and some switching hands. That makes it most useful as an honest test on people who are not on our team: train on team data, then run `python -m recognition.benchmark --checkpoint recognition/models/model.pt --test-data data/gislr --tag gislr` (it only scores the 7 shared signs, and the other 14 classes simply never appear).
- **Format details.** Each parquet has 543 rows per frame (face 468, left hand 21, pose 33, right hand 21), and a hand that was not detected is 21 rows of NaN, which the converter writes as `null`. The frame rate is not stated (30 fps is assumed), and the clip aspect ratio is not given, so x and y are scaled differently from our webcam.
- **Other datasets checked and not used.** ASL Citizen covers 15 of our signs but its Microsoft Research licence forbids redistributing the data and allows non-commercial research only; WLASL covers 15 but is video scraped from third-party sites with many dead links and a non-commercial licence; PopSign has the same 250 signs as GISLR as raw video only; the Kaggle fingerspelling set is continuous character sequences, not whole-word `FS-WIFI` or `FS-CHECKOUT` units.
