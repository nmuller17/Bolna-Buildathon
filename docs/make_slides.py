"""SignBridge slides (2 pages, 16:9 PDF): overview + technical workflow. Needs reportlab; macOS Arial fonts.

    python docs/make_slides.py docs/SignBridge-workflow.pdf
"""
import sys

from reportlab.lib.colors import HexColor, white
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

OUT = sys.argv[1]
W, H = 1280, 720
F = "/System/Library/Fonts/Supplemental/"
pdfmetrics.registerFont(TTFont("Arial", F + "Arial.ttf"))
pdfmetrics.registerFont(TTFont("Arial-Bold", F + "Arial Bold.ttf"))

NAVY = HexColor("#0E2A47")
INK = HexColor("#1B2433")
MUTED = HexColor("#5B6578")
LINE = HexColor("#D5DCE5")
BLUE = HexColor("#2F6FEB")
BLUE_BG = HexColor("#EEF3FD")
GREEN = HexColor("#1E9E5A")
GREEN_BG = HexColor("#ECF8F1")
ORANGE = HexColor("#E8590C")
ORANGE_BG = HexColor("#FFF1E6")
GREY_BG = HexColor("#F5F7FA")

c = canvas.Canvas(OUT, pagesize=(W, H))
TECH_START = True
c.setTitle("SignBridge - technical workflow")
c.setAuthor("SignBridge team")


def text(x, y, s, size=10, font="Arial", color=INK):
    c.setFont(font, size)
    c.setFillColor(color)
    c.drawString(x, y, s)


def wrapped(x, y, s, width, size=8.6, font="Arial", color=INK, leading=None):
    leading = leading or size * 1.28
    c.setFont(font, size)
    c.setFillColor(color)
    for line in simpleSplit(s, font, size, width):
        c.drawString(x, y, line)
        y -= leading
    return y


def box(x, y, w, h, step, title, lines, accent, bg, tool=None, intent=False):
    """Rounded card: step tag, title, the tool in bold, bullet lines."""
    c.setLineWidth(2.6 if intent else 1)
    c.setStrokeColor(ORANGE if intent else LINE)
    c.setFillColor(ORANGE_BG if intent else white)
    c.roundRect(x, y, w, h, 8, stroke=1, fill=1)
    c.setFillColor(ORANGE if intent else accent)
    c.roundRect(x, y + h - 26, w, 26, 8, stroke=0, fill=1)
    c.rect(x, y + h - 26, w, 10, stroke=0, fill=1)
    text(x + 10, y + h - 18, step, 9.5, "Arial-Bold", white)
    text(x + 10 + c.stringWidth(step, "Arial-Bold", 9.5) + 6, y + h - 18, title, 10.5, "Arial-Bold", white)
    yy = y + h - 42
    if tool:
        yy = wrapped(x + 10, yy, tool, w - 20, 9, "Arial-Bold", ORANGE if intent else accent) - 3
    for line in lines:
        c.setFillColor(MUTED)
        c.circle(x + 13, yy + 2.8, 1.5, stroke=0, fill=1)
        yy = wrapped(x + 19, yy, line, w - 29, 8.4, "Arial", INK) - 2.5


def arrow(x1, y1, x2, y2, color=MUTED, width=1.6):
    import math
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(width)
    c.line(x1, y1, x2, y2)
    a = math.atan2(y2 - y1, x2 - x1)
    s = 7
    p = c.beginPath()
    p.moveTo(x2, y2)
    p.lineTo(x2 - s * math.cos(a - 0.45), y2 - s * math.sin(a - 0.45))
    p.lineTo(x2 - s * math.cos(a + 0.45), y2 - s * math.sin(a + 0.45))
    p.close()
    c.drawPath(p, stroke=0, fill=1)


def header(title, subtitle):
    c.setFillColor(white)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(NAVY)
    c.rect(0, H - 62, W, 62, stroke=0, fill=1)
    text(32, H - 38, title, 24, "Arial-Bold", white)
    text(32, H - 55, subtitle, 10.5, "Arial", HexColor("#C9D6EA"))
    c.setFillColor(ORANGE)
    c.roundRect(W - 300, H - 47, 268, 24, 12, stroke=0, fill=1)
    text(W - 288, H - 39, "■  Intent classification (highlighted)", 10.5, "Arial-Bold", white)


SUBTITLE = "One laptop · one screen facing the Deaf guest · the receptionist only talks and listens"

M, GAP = 32, 16
BW = (W - 2 * M - 4 * GAP) / 5


def lane(y, h, label, color, cards):
    text(M, y + h + 8, label, 11.5, "Arial-Bold", color)
    xs = [M + i * (BW + GAP) for i in range(5)]
    for i, (step, title, tool, lines, intent) in enumerate(cards):
        box(xs[i], y, BW, h, step, title, lines, color, None, tool, intent)
        if i < 4:
            arrow(xs[i] + BW + 2, y + h / 2, xs[i + 1] - 2, y + h / 2, color)
    return xs


# ==== slide 1: overview (simple) ==================================================================================
def simple_box(x, y, w, h, step, title, line, tool, accent, intent=False):
    c.setLineWidth(2.6 if intent else 1)
    c.setStrokeColor(ORANGE if intent else LINE)
    c.setFillColor(ORANGE_BG if intent else white)
    c.roundRect(x, y, w, h, 10, stroke=1, fill=1)
    color = ORANGE if intent else accent
    c.setFillColor(color)
    c.roundRect(x, y + h - 34, w, 34, 10, stroke=0, fill=1)
    c.rect(x, y + h - 34, w, 12, stroke=0, fill=1)
    c.setFillColor(white)
    c.circle(x + 20, y + h - 17, 10, stroke=0, fill=1)
    c.setFont("Arial-Bold", 11)
    c.setFillColor(color)
    c.drawCentredString(x + 20, y + h - 21, step)
    text(x + 38, y + h - 23, title, 15, "Arial-Bold", white)
    wrapped(x + 14, y + h - 58, line, w - 28, 12, "Arial", INK, 15)
    text(x + 14, y + 16, tool, 11.5, "Arial-Bold", color)


def simple_lane(y, h, label, color, cards):
    text(M, y + h + 10, label, 14, "Arial-Bold", color)
    xs = [M + i * (BW + GAP) for i in range(5)]
    for i, (step, title, line, tool, intent) in enumerate(cards):
        simple_box(xs[i], y, BW, h, step, title, line, tool, color, intent)
        if i < 4:
            arrow(xs[i] + BW + 2, y + h / 2, xs[i + 1] - 2, y + h / 2, color, 2)


header("SignBridge — how it works", SUBTITLE)
simple_lane(440, 150, "The receptionist speaks   →   the guest sees ASL", BLUE, [
    ("1", "Speak", "The receptionist holds Space and talks", "Microphone", False),
    ("2", "Transcribe", "The speech becomes text", "OpenAI Whisper", False),
    ("3", "Understand", "What does the receptionist mean?", "Intent classifier", True),
    ("4", "Translate", "The text becomes ASL signs", "ASL gloss", False),
    ("5", "Sign", "A 3D bellhop signs it, with captions", "3D avatar", False),
])
simple_lane(212, 150, "The guest signs   →   the receptionist hears English", GREEN, [
    ("1", "Sign", "The guest signs to the webcam", "Camera", False),
    ("2", "Track", "Hands, body and face are tracked", "MediaPipe", False),
    ("3", "Recognize", "Each sign is recognized", "Our sign classifier", False),
    ("4", "Understand", "Which sentence does the guest mean?", "Intent decoder", True),
    ("5", "Speak", "The answer is said out loud", "ElevenLabs voice", False),
])
TW = (W - 2 * M - 2 * GAP) / 3
for i, (big, label) in enumerate([
    ("87", "signs the avatar can play, recorded by the team"),
    ("1,320", "training takes recorded by 5 signers"),
    ("≈ 90 %", "of sentences understood for a signer never seen"),
]):
    x = M + i * (TW + GAP)
    c.setFillColor(GREY_BG)
    c.setStrokeColor(LINE)
    c.setLineWidth(1)
    c.roundRect(x, 40, TW, 112, 10, stroke=1, fill=1)
    c.setFont("Arial-Bold", 38)
    c.setFillColor(NAVY)
    c.drawString(x + 22, 92, big)
    text(x + 22, 64, label, 12.5, "Arial", MUTED)
c.showPage()

# ==== slide 2: technical workflow ===================================================================================
header("SignBridge — technical workflow", SUBTITLE)

# ---- lane A: receptionist -> guest ------------------------------------------------------------------------------
YA, HA = 448, 150
xa = lane(YA, HA, "RECEPTIONIST → GUEST   speech to ASL", BLUE, [
    ("1", "Push-to-talk", "Space held = record", [
        "MacBook built-in mic, chosen automatically (AirPods / iPhone avoided)",
        "MediaRecorder → webm audio",
        "the room noise is never transcribed"], False),
    ("2", "Speech to text", "OpenAI Whisper (whisper-1)", [
        "Next.js route /api/transcribe, key server-side",
        "fallback: Chrome Web Speech API"], False),
    ("3", "INTENT CLASSIFIER", "20 receptionist intents (hotel front desk)", [
        "keyword patterns + resemblance to the reference sentence (≥ 1/3 of its content words)",
        "slots: room number, times",
        "web/lib/voice/intents.ts · /api/gloss → { gloss, intents }"], True),
    ("4", "Text → ASL gloss", "intent → curated ASL gloss", [
        "ASL word order, BROWS-UP / BROWS-DOWN on questions, numbers",
        "unknown sentence → word by word: 87 known signs, synonyms, plurals, else fingerspelling (FS:WORD)"], False),
    ("5", "3D signing avatar", "Three.js · rigged bellhop (GLB)", [
        "Tripo mesh, Mixamo skeleton, 3 phalanges per finger",
        "replays 87 signs the team recorded with MediaPipe",
        "retargeting: arm IK, wrist basis, phalanx aiming · transitions · 30 fps · karaoke captions"], False),
])

# ---- lane B: guest -> receptionist ------------------------------------------------------------------------------
YB, HB = 210, 150
xb = lane(YB, HB, "GUEST → RECEPTIONIST   ASL to speech", GREEN, [
    ("1", "Guest turn & capture", "recognition/live_key.py · OpenCV", [
        "starts when the avatar has finished signing",
        "webcam 1280×720; ends when the hands rest 2.5 s",
        "live MJPEG preview on the page (green frame)"], False),
    ("2", "Landmarks", "MediaPipe Holistic 1.1.0, on-device", [
        "33 pose + 2 × 21 hand + 26 face points",
        "normalized on the shoulders, 30 fps, cleaned",
        "no video leaves the laptop"], False),
    ("3", "Sign classifier", "PyTorch, 22 classes (21 signs + NONE)", [
        "trained on 1,320 takes by 5 signers (12 per sign each)",
        "141 features per frame, resampled to 32 steps",
        "scores sliding 1 s windows (step 0.13 s)"], False),
    ("4", "INTENT DECODER", "22 guest sentences = guest intents", [
        "aligns each candidate sentence on the window probabilities (monotonic dynamic programming)",
        "the sentence context fixes misread signs",
        "recognition/sentence.py"], True),
    ("5", "Text to speech", "ElevenLabs (eleven_flash_v2_5)", [
        "Next.js route /api/tts",
        "fallback: browser speechSynthesis",
        "spoken on the laptop + “You said: …” on screen"], False),
])

# ---- bottom cards -----------------------------------------------------------------------------------------------
CY, CH = 40, 112
CW = (W - 2 * M - 2 * GAP) / 3
cards = [
    ("Turn-taking   web/lib/turns.ts", NAVY, [
        "FRONT DESK → REQUESTING → GUEST → SPEAKING → FRONT DESK",
        "microphone muted for the whole guest turn and while the answer is spoken",
        "recognizer events: live_key → POST /api/guest/signs → SSE /api/guest/stream → page",
        "timeouts: recognizer silent 3 s, guest turn 30 s"]),
    ("Stack", NAVY, [
        "Web: Next.js 16 · React 19 · TypeScript · Three.js",
        "Recognition: Python 3.12 · MediaPipe 1.1.0 · OpenCV · PyTorch",
        "Cloud: OpenAI Whisper (speech) · ElevenLabs (voice)",
        "Data: 87 avatar signs + 1,320 training takes recorded by the team"]),
    ("Results", NAVY, [
        "Isolated signs, unseen signer (leave-one-out): 89.8 % right · top-3 97.1 %",
        "Continuous sentences, unseen signer (simulated): ≈ 90 %",
        "Live rehearsal, no guidance: 8 / 8 guest sentences",
        "Decoding < 0.1 s after the hands rest; voice ≈ 0.5 s"]),
]
for i, (title, color, lines) in enumerate(cards):
    x = M + i * (CW + GAP)
    c.setFillColor(GREY_BG)
    c.setStrokeColor(LINE)
    c.setLineWidth(1)
    c.roundRect(x, CY, CW, CH, 8, stroke=1, fill=1)
    text(x + 12, CY + CH - 20, title, 11, "Arial-Bold", color)
    yy = CY + CH - 38
    for line in lines:
        c.setFillColor(MUTED)
        c.circle(x + 15, yy + 2.8, 1.5, stroke=0, fill=1)
        yy = wrapped(x + 21, yy, line, CW - 33, 8.8) - 3

c.showPage()
c.save()
print("wrote", OUT)
