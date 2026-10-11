"""Track B helper, bench venv only (anthropic SDK): Claude as a closed-set vision baseline.

    ~/.venvs/signbridge-bench/bin/python recognition/compare/tb_claude.py --frames-dir <out>/frames16 \
        --model claude-sonnet-5 --out <file.jsonl>

PRIVACY: this sends video frames (faces included) of each clip to the Anthropic API. Run it only on
clips from people who gave written consent to third-party processing; never on guest or production
video. Track B refuses to start it without --i-have-consent.

One request per clip: the sampled frames (labelled "Frame k:") then the instruction; the answer is
forced into {"label": one of the 22 classes, "confidence": number} with structured outputs. The
confidence of a vision model is not calibrated, so the report uses its label, not a 0.6 threshold.
"""
import argparse
import base64
import json
import time
from pathlib import Path

import anthropic

CLASSES = ["YES", "NO", "RESERVATION", "NAME", "THANK-YOU", "WHERE", "ELEVATOR", "FS-WIFI", "PASSWORD",
           "BREAKFAST", "TIME", "TOWEL", "MORE", "FS-CHECKOUT", "LATE", "PLEASE", "PARKING", "TAXI", "HELP",
           "ROOM", "RESTAURANT", "NONE"]
SYSTEM = ("You classify one isolated American Sign Language sign shown as video frames in time order. "
          "Choose exactly one label from the list. NONE = no sign, or a sign that is not in the list. "
          "Fingerspelled W-I-F-I = FS-WIFI, fingerspelled C-H-E-C-K-O-U-T = FS-CHECKOUT, "
          "PASSWORD is the compound PRIVATE + WORD. Labels: " + ", ".join(CLASSES))
SCHEMA = {"type": "object", "properties": {"label": {"type": "string", "enum": CLASSES},
                                           "confidence": {"type": "number"}},
          "required": ["label", "confidence"], "additionalProperties": False}
PRICE = {"claude-sonnet-5": (2.0, 10.0), "claude-opus-5-5": (4.0, 20.0)}  # $ per million tokens (in, out)


def request(client, model, jpgs):
    content = []
    for k, p in enumerate(jpgs):
        content.append({"type": "text", "text": f"Frame {k + 1}:"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                    "data": base64.standard_b64encode(p.read_bytes()).decode()}})
    content.append({"type": "text", "text": "Which sign is this? Answer with the label and your confidence (0 to 1)."})
    kw = {"output_config": {"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}}}
    if model == "claude-sonnet-5":
        kw["thinking"] = {"type": "disabled"}  # Opus 5.5 cannot disable thinking; low effort instead
    return client.messages.create(model=model, max_tokens=2048, system=SYSTEM,
                                  messages=[{"role": "user", "content": content}], **kw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames-dir", required=True)
    ap.add_argument("--model", required=True, choices=list(PRICE))
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    client = anthropic.Anthropic()
    done = set()
    out = Path(a.out)
    if out.exists():
        done = {r["clip_id"] for r in map(json.loads, filter(str.strip, out.read_text().splitlines())) if not r.get("error")}
    with open(out, "a") as f:
        for d in sorted(p for p in Path(a.frames_dir).glob("*/*") if p.is_dir()):
            clip_id = f"{d.parent.name}/{d.name}"
            if clip_id in done:
                continue
            row = {"clip_id": clip_id, "model": a.model, "label": None, "confidence": None}
            t0 = time.perf_counter()
            try:
                r = request(client, a.model, sorted(d.glob("*.jpg")))
                row["stop_reason"] = r.stop_reason
                if r.stop_reason not in ("refusal", "max_tokens"):
                    text = next(b.text for b in r.content if b.type == "text")
                    ans = json.loads(text)
                    row["label"], row["confidence"] = ans["label"], float(ans["confidence"])
                u = r.usage
                pin, pout = PRICE[a.model]
                row.update(input_tokens=u.input_tokens, output_tokens=u.output_tokens,
                           usd=round((u.input_tokens * pin + u.output_tokens * pout) / 1e6, 5))
            except anthropic.RateLimitError as e:
                row["error"] = f"rate limited: {e.message}"
            except anthropic.APIStatusError as e:
                row["error"] = f"HTTP {e.status_code}: {e.message}"
            except anthropic.APIConnectionError:
                row["error"] = "connection error"
            except (StopIteration, json.JSONDecodeError, KeyError, ValueError) as e:
                row["error"] = f"unparseable answer: {type(e).__name__}"
            row["latency_ms"] = round((time.perf_counter() - t0) * 1000, 1)
            f.write(json.dumps(row) + "\n")
            f.flush()
            print(clip_id, row.get("label"), row.get("error", ""), flush=True)


if __name__ == "__main__":
    main()
