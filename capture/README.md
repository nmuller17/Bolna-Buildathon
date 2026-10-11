# Recording training data (everyone, on your own laptop)

The sign classifier (P3) learns from many takes of each of the 22 classes in `docs/vocabulary.md` section 3.
Each team member records **12 takes per class** on their own laptop, about 25 minutes.

## 1. Setup (once)

```bash
git fetch && git switch p2-avatar && git pull
python3.12 -m venv .venv            # Python 3.12 recommended (3.13 also works)
source .venv/bin/activate           # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Intel Macs: mediapipe 1.1.0 has no wheel for them, use another laptop.

## 2. Record

```bash
python capture/train_session.py --users <your-name> --reps 12
```

Use your name in lowercase, **always the same one**: `maya`, `cosme`, `roni`, `thanya`, `nath`.
The classifier is tested by holding out one person at a time, so a typo creates a fake extra signer.

- The window shows the sign to perform and a **reference video** in the bottom-right corner.
  Do the sign exactly like the reference so everyone records the same variant.
- `SPACE` starts your 12 takes for that sign. 3 s countdown, then 2 s of recording (3 s for
  `FS-WIFI`, `PASSWORD`), then the next take starts after 1.5 s.
- `R` right after "saved": redo the last take. `P`: pause. `N`: next sign. `Q`: quit.
- Quitting is safe: run the same command again and it continues where you stopped.
- `NONE` = no sign at all: scratch your head, touch your hair, adjust your glasses, random moves.
  Make every take different.

Tips: sit about 1-1.5 m from the camera, head to waist in the frame, both shoulders and hands
always visible, light in front of you, plain background. Vary speed and size a little between
takes, but always the same sign.

If the window stays black, another camera was picked (e.g. an iPhone via Continuity Camera):
add `--camera 1` (or `0`, `2`).

## 3. Send your data to P3

Your takes are in `data/train/<SIGN>/<your-name>_<n>.json` (not on GitHub: `data/` is ignored).

```bash
zip -r train_<your-name>.zip data/train -i "*/<your-name>_*.json"
```

Send the zip to P3 (AirDrop, Drive...). They unzip all of them in the repo root: file names
contain the signer, so nothing collides. Keep the `.mp4` files in `data/videos/` on your laptop.

## Other tools

- `capture.py --mode avatar`: record the signs the avatar plays (`signs/team`, `signs/alphabet`).
- `make_references.py`: rebuild the reference videos in `capture/reference/` from Cosme's captures.
