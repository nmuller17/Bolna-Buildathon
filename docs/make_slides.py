"""SignBridge slides (2 pages, 16:9): overview + technical workflow.

    python docs/make_slides.py docs/SignBridge-workflow     # writes .pdf and .json (then: node docs/make_slides.js)

The layout is computed once as a list of drawing operations (canvas 1280 x 720 pt, origin bottom-left), then
rendered to PDF with reportlab here, and to an editable .pptx by docs/make_slides.js from the .json, so the two
formats stay identical. Needs reportlab and the macOS Arial fonts.
"""
import json
import math
import sys

from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

W, H = 1280, 720
FONTS = "/System/Library/Fonts/Supplemental/"
pdfmetrics.registerFont(TTFont("Arial", FONTS + "Arial.ttf"))
pdfmetrics.registerFont(TTFont("Arial-Bold", FONTS + "Arial Bold.ttf"))

NAVY, INK, MUTED, LINE = "0E2A47", "1B2433", "5B6578", "D5DCE5"
BLUE, GREEN, ORANGE = "2F6FEB", "1E9E5A", "E8590C"
ORANGE_BG, GREY_BG, WHITE, SUB = "FFF1E6", "F5F7FA", "FFFFFF", "C9D6EA"

slides = []   # one list of operations per slide
ops = None


def new_slide():
    global ops
    ops = []
    slides.append(ops)


# ---- primitives (recorded) --------------------------------------------------------------------------------------
def rect(x, y, w, h, fill, stroke=None, lw=0, r=0, dash=False):
    ops.append({"t": "rect", "x": x, "y": y, "w": w, "h": h, "fill": fill, "stroke": stroke, "lw": lw, "r": r,
                "dash": dash})


def circle(cx, cy, r, fill):
    ops.append({"t": "circle", "cx": cx, "cy": cy, "r": r, "fill": fill})


def text(x, y, s, size=10, bold=False, color=INK, align="left", w=None):
    """One line; (x, y) = left (or centre) of the baseline."""
    ops.append({"t": "text", "x": x, "y": y, "lines": [s], "size": size, "bold": bold, "color": color,
                "align": align, "leading": size * 1.2, "w": w or (stringwidth(s, size, bold) + 4)})


def wrapped(x, y, s, width, size=8.6, bold=False, color=INK, leading=None):
    """Paragraph wrapped to `width`; returns the baseline y below its last line."""
    leading = leading or size * 1.28
    lines = simpleSplit(s, "Arial-Bold" if bold else "Arial", size, width)
    ops.append({"t": "text", "x": x, "y": y, "lines": lines, "size": size, "bold": bold, "color": color,
                "align": "left", "leading": leading, "w": width})
    return y - leading * len(lines)


def arrow(x1, y1, x2, y2, color=MUTED, width=1.6):
    ops.append({"t": "arrow", "x1": x1, "y1": y1, "x2": x2, "y2": y2, "color": color, "lw": width})


def stringwidth(s, size, bold=False):
    return pdfmetrics.stringWidth(s, "Arial-Bold" if bold else "Arial", size)


# ---- shared components ------------------------------------------------------------------------------------------
M, GAP = 32, 16
BW = (W - 2 * M - 4 * GAP) / 5
SUBTITLE = "One laptop · one screen facing the Deaf guest · the receptionist only talks and listens"


def header(title):
    rect(0, 0, W, H, WHITE)
    rect(0, H - 62, W, 62, NAVY)
    text(32, H - 38, title, 24, True, WHITE)
    text(32, H - 55, SUBTITLE, 10.5, False, SUB)
    rect(W - 300, H - 47, 268, 24, ORANGE, r=12)
    text(W - 288, H - 39, "■  Intent classification (highlighted)", 10.5, True, WHITE)


def card_top(x, y, w, h, color, intent, bar=26, radius=8):
    rect(x, y, w, h, ORANGE_BG if intent else WHITE, ORANGE if intent else LINE, 2.6 if intent else 1, radius)
    rect(x, y + h - bar, w, bar, ORANGE if intent else color, r=radius)
    rect(x, y + h - bar, w, bar / 2.6, ORANGE if intent else color)   # square the bar's lower corners


def bullets(x, y, items, width, size=8.4, gap=2.5):
    for item in items:
        circle(x + 3, y + size * 0.33, 1.5, MUTED)
        y = wrapped(x + 9, y, item, width - 9, size) - gap
    return y


def tech_box(x, y, w, h, step, title, tool, lines, color, intent=False):
    card_top(x, y, w, h, color, intent)
    text(x + 10, y + h - 18, step, 9.5, True, WHITE)
    text(x + 10 + stringwidth(step, 9.5, True) + 6, y + h - 18, title, 10.5, True, WHITE)
    yy = wrapped(x + 10, y + h - 42, tool, w - 20, 9, True, ORANGE if intent else color) - 3
    bullets(x + 10, yy, lines, w - 20)


def lane(y, h, label, color, cards, box=tech_box, label_size=11.5, arrow_w=1.6):
    text(M, y + h + 8, label, label_size, True, color)
    xs = [M + i * (BW + GAP) for i in range(5)]
    for i, card in enumerate(cards):
        box(xs[i], y, BW, h, *card[:4], color, card[4])
        if i < 4:
            arrow(xs[i] + BW + 2, y + h / 2, xs[i + 1] - 2, y + h / 2, color, arrow_w)
    return xs


def simple_box(x, y, w, h, step, title, line, tool, color, intent=False):
    c = ORANGE if intent else color
    card_top(x, y, w, h, color, intent, bar=34, radius=10)
    circle(x + 20, y + h - 17, 10, WHITE)
    text(x + 20, y + h - 21, step, 11, True, c, align="center", w=20)
    text(x + 38, y + h - 23, title, 15, True, WHITE)
    wrapped(x + 14, y + h - 58, line, w - 28, 12, False, INK, 15)
    text(x + 14, y + 16, tool, 11.5, True, c)


# ==== slide 1: overview ============================================================================================
new_slide()
header("SignBridge — how it works")
lane(440, 150, "The receptionist speaks   →   the guest sees ASL", BLUE, [
    ("1", "Speak", "The receptionist holds Space and talks", "Microphone", False),
    ("2", "Transcribe", "The speech becomes text", "OpenAI Whisper", False),
    ("3", "Understand", "What does the receptionist mean?", "Intent classifier", True),
    ("4", "Translate", "The text becomes ASL signs", "ASL gloss", False),
    ("5", "Sign", "A 3D bellhop signs it, with captions", "3D avatar", False),
], box=simple_box, label_size=14, arrow_w=2)
lane(212, 150, "The guest signs   →   the receptionist hears English", GREEN, [
    ("1", "Sign", "The guest signs to the webcam", "Camera", False),
    ("2", "Track", "Hands, body and face are tracked", "MediaPipe", False),
    ("3", "Recognize", "Each sign is recognized", "Our sign classifier", False),
    ("4", "Understand", "Which sentence does the guest mean?", "Intent decoder", True),
    ("5", "Speak", "The answer is said out loud", "ElevenLabs voice", False),
], box=simple_box, label_size=14, arrow_w=2)
TW = (W - 2 * M - 2 * GAP) / 3
for i, (big, label) in enumerate([("87", "signs the avatar can play, recorded by the team"),
                                  ("1,320", "training takes recorded by 5 signers"),
                                  ("≈ 90 %", "of sentences understood for a signer never seen")]):
    x = M + i * (TW + GAP)
    rect(x, 40, TW, 112, GREY_BG, LINE, 1, 10)
    text(x + 22, 92, big, 38, True, NAVY)
    text(x + 22, 64, label, 12.5, False, MUTED)

# ==== slide 2: technical workflow ==================================================================================
new_slide()
header("SignBridge — technical workflow")
lane(506, 124, "RECEPTIONIST → GUEST   speech to ASL", BLUE, [
    ("1", "Push-to-talk", "Space held = record", [
        "MacBook built-in mic, chosen automatically (AirPods / iPhone avoided)",
        "MediaRecorder → webm; room noise never transcribed"], False),
    ("2", "Speech to text", "OpenAI Whisper (whisper-1)", [
        "Next.js route /api/transcribe, key server-side",
        "fallback: Chrome Web Speech API"], False),
    ("3", "INTENT CLASSIFIER", "20 receptionist intents", [
        "keywords + similarity to the reference sentence (see below)",
        "/api/gloss → { gloss, intents }"], True),
    ("4", "Text → ASL gloss", "intent → curated ASL gloss", [
        "ASL word order, BROWS-UP / DOWN on questions, numbers",
        "else word by word: 87 signs, synonyms, plurals, fingerspelling"], False),
    ("5", "3D signing avatar", "Three.js · rigged bellhop (GLB)", [
        "Tripo mesh, Mixamo skeleton, 3 phalanges per finger",
        "replays the team's MediaPipe captures: arm IK, finger aiming, 30 fps, captions"], False),
])
lane(346, 124, "GUEST → RECEPTIONIST   ASL to speech", GREEN, [
    ("1", "Guest turn & capture", "recognition/live_key.py · OpenCV", [
        "starts when the avatar has finished signing",
        "ends when the hands rest 2.5 s; live preview on the page"], False),
    ("2", "Landmarks", "MediaPipe Holistic 1.1.0, on-device", [
        "33 pose + 2 × 21 hand + 26 face points",
        "shoulder-normalized, 30 fps; no video leaves the laptop"], False),
    ("3", "Sign classifier", "PyTorch, 22 classes (21 signs + NONE)", [
        "trained on the team's 1,320 takes (see below)",
        "scores sliding 1 s windows (step 0.13 s)"], False),
    ("4", "INTENT DECODER", "22 guest sentences = guest intents", [
        "aligns each sentence on the window probabilities (see below)",
        "recognition/sentence.py"], True),
    ("5", "Text to speech", "ElevenLabs (eleven_flash_v2_5)", [
        "Next.js route /api/tts; fallback: browser voice",
        "spoken on the laptop + “You said: …” on screen"], False),
])

# How the classifiers are built
text(M, 292, "HOW THE CLASSIFIERS ARE BUILT", 11.5, True, NAVY)
CW = (W - 2 * M - 2 * GAP) / 3
for i, (title, tool, items, color, intent) in enumerate([
    ("Intent classifier — receptionist", "Rule-based · TypeScript · no training", [
        "20 intents, one per receptionist sentence of docs/vocabulary.md",
        "keyword patterns per intent (regex), incl. Whisper variants: keycard, wi-fi, booking…",
        "kept only if ≥ 1/3 of the sentence's content words belong to its reference sentence; ties → most specific rule",
        "slots by regex: room number, times → ASL numbers",
        "deterministic, unit-tested: 20 / 20 vocabulary sentences"], ORANGE, True),
    ("Sign classifier", "Trained · PyTorch · on our own data", [
        "data: 1,320 takes = 5 signers × 22 classes × 12, MediaPipe (capture/train_session.py)",
        "features: 141 per frame (hand shape relative to the wrist, upper body, nose), 32 time steps",
        "model kept: logistic regression on per-take statistics (mean, std, min, max, thirds), L-BFGS, temperature-calibrated",
        "vs a 2-layer BiGRU (AdamW, augmentation): the simpler model won, 89.8 % vs 87.9 % (leave-one-signer-out)"],
     GREEN, False),
    ("Intent decoder — guest", "Algorithm · Python / NumPy · no training", [
        "input: classifier probabilities on sliding 1 s windows",
        "each of the 22 guest sentences is aligned on the windows: its signs in order, each on a contiguous run "
        "(monotonic dynamic programming)",
        "score = mean log-probability; the best sentence wins, so misread signs are fixed by the sentence",
        "window length tuned on a held-out signer: 1 s → 90 %, 1.7 s → 84 %"], ORANGE, True),
]):
    x = M + i * (CW + GAP)
    card_top(x, 112, CW, 168, color, intent)
    text(x + 10, 112 + 168 - 18, title, 10.5, True, WHITE)
    yy = wrapped(x + 10, 112 + 168 - 42, tool, CW - 20, 9.5, True, color) - 3
    bullets(x + 10, yy, items, CW - 20, 8.5)

# footer: turn-taking, stack, results
for i, (title, line) in enumerate([
    ("Turn-taking  web/lib/turns.ts", "FRONT DESK → GUEST → SPEAKING → FRONT DESK · mic muted during the guest turn · "
                                       "events via POST /api/guest/signs → SSE"),
    ("Stack", "Next.js 16 · React 19 · Three.js · Python 3.12 · MediaPipe 1.1.0 · OpenCV · PyTorch · Whisper · ElevenLabs"),
    ("Results", "89.8 % isolated signs, unseen signer (top-3 97.1 %) · ≈ 90 % continuous sentences (simulated) · "
                "8 / 8 live, unguided"),
]):
    x = M + i * (CW + GAP)
    rect(x, 24, CW, 70, GREY_BG, LINE, 1, 8)
    text(x + 12, 24 + 70 - 18, title, 10, True, NAVY)
    wrapped(x + 12, 24 + 70 - 33, line, CW - 24, 8.4, False, INK)


# ---- render ---------------------------------------------------------------------------------------------------------
def render_pdf(path):
    from reportlab.lib.colors import HexColor
    from reportlab.pdfgen import canvas
    c = canvas.Canvas(path, pagesize=(W, H))
    c.setTitle("SignBridge - workflow")
    c.setAuthor("SignBridge team")
    for page in slides:
        for o in page:
            if o["t"] == "rect":
                c.setFillColor(HexColor("#" + o["fill"]))
                if o["stroke"]:
                    c.setStrokeColor(HexColor("#" + o["stroke"]))
                    c.setLineWidth(o["lw"])
                    c.setDash(5, 3) if o["dash"] else c.setDash()
                if o["r"]:
                    c.roundRect(o["x"], o["y"], o["w"], o["h"], o["r"], stroke=1 if o["stroke"] else 0, fill=1)
                else:
                    c.rect(o["x"], o["y"], o["w"], o["h"], stroke=1 if o["stroke"] else 0, fill=1)
                c.setDash()
            elif o["t"] == "circle":
                c.setFillColor(HexColor("#" + o["fill"]))
                c.circle(o["cx"], o["cy"], o["r"], stroke=0, fill=1)
            elif o["t"] == "text":
                c.setFont("Arial-Bold" if o["bold"] else "Arial", o["size"])
                c.setFillColor(HexColor("#" + o["color"]))
                for k, line in enumerate(o["lines"]):
                    y = o["y"] - k * o["leading"]
                    (c.drawCentredString if o["align"] == "center" else c.drawString)(o["x"], y, line)
            elif o["t"] == "arrow":
                col = HexColor("#" + o["color"])
                c.setStrokeColor(col)
                c.setFillColor(col)
                c.setLineWidth(o["lw"])
                x1, y1, x2, y2 = o["x1"], o["y1"], o["x2"], o["y2"]
                c.line(x1, y1, x2, y2)
                a, s = math.atan2(y2 - y1, x2 - x1), 7
                p = c.beginPath()
                p.moveTo(x2, y2)
                p.lineTo(x2 - s * math.cos(a - 0.45), y2 - s * math.sin(a - 0.45))
                p.lineTo(x2 - s * math.cos(a + 0.45), y2 - s * math.sin(a + 0.45))
                p.close()
                c.drawPath(p, stroke=0, fill=1)
        c.showPage()
    c.save()


if __name__ == "__main__":
    base = sys.argv[1] if len(sys.argv) > 1 else "docs/SignBridge-workflow"
    render_pdf(base + ".pdf")
    with open(base + ".json", "w") as f:
        json.dump({"w": W, "h": H, "slides": slides}, f)
    print("wrote", base + ".pdf", base + ".json")
