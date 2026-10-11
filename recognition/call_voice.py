"""Captions and an optional local voice for the receptionist in the video-call demo (live.py --say).

An utterance event -> one caption line for the terminal and, when the guest's signs were clear and
form one of the fixed guest intents, the English sentence spoken by a macOS system voice on this
laptop (the voices of `say`: one warm NSSpeechSynthesizer when pyobjc AppKit is installed, which
avoids a 2 s process start per sentence, else the `say` command). Nothing goes to the cloud: no
ElevenLabs, no Claude. The sentences are the ones the app uses,
docs/vocabulary.md section 2 (merged vocabulary, where checkout is the sign LEAVE; a checkpoint
trained before the rename says FS-CHECKOUT, which is mapped to LEAVE as web/app/api/english does).

Rules (the app's, CLAUDE.md 7.2):
- needs_repeat (any sign NONE or below 0.6): caption asks the receptionist to have the guest repeat;
  nothing is spoken.
- recognizer "mock": invented answers; captioned as mock and never spoken.
- exact match of the sign sequence with an intent: caption and speak the sentence.
- clear signs that match no intent: caption the signs only (the app would ask Claude for a
  sentence; this offline demo does not), nothing spoken.
Intent 4 (NAME + a typed name) needs the keyboard and is not handled here.
"""
import queue
import shutil
import subprocess
import sys
import threading
import time

LABEL_ALIASES = {"FS-CHECKOUT": "LEAVE"}
INTENTS = {  # docs/vocabulary.md section 2 (p2-avatar e830b57 / p4-app web/app/api/english/intents.ts)
    ("YES",): "Yes.",
    ("NO",): "No.",
    ("YES", "RESERVATION"): "Yes, I have a reservation.",
    ("THANK-YOU",): "Thank you.",
    ("WHERE", "ELEVATOR"): "Where is the elevator?",
    ("FS-WIFI", "PASSWORD"): "What's the Wi-Fi password?",
    ("BREAKFAST", "TIME"): "What time is breakfast?",
    ("WHERE", "BREAKFAST"): "Where is breakfast served?",
    ("MORE", "TOWEL", "PLEASE"): "Could I have more towels, please?",
    ("LEAVE", "TIME"): "What time is checkout?",
    ("LATE", "LEAVE", "PLEASE"): "Could I have a late checkout?",
    ("WHERE", "PARKING"): "Where can I park?",
    ("TAXI", "PLEASE"): "Could you call me a taxi?",
    ("HELP", "PLEASE"): "I need some help, please.",
    ("WHERE", "ROOM"): "Where is my room?",
    ("ROOM", "HELP"): "There's a problem with my room.",
    ("WHERE", "RESTAURANT"): "Where is the restaurant?",
    ("RESTAURANT", "TIME"): "When is the restaurant open?",
    ("NO", "THANK-YOU"): "No, that's all, thank you.",
}
QUEUE_MAX = 3               # sentences waiting to be spoken; older ones are dropped
SAY_TIMEOUT = 15.0


def normalize(label):
    up = str(label).strip().upper()
    return LABEL_ALIASES.get(up, up)


def sentence_for(labels):
    """Sign labels in order -> the intent's English sentence, or None."""
    return INTENTS.get(tuple(normalize(x) for x in labels))


def caption(ev, recognizer_state="ok"):
    """utterance event -> (caption line, sentence to speak or None)."""
    labels = [normalize(p["label"]) for p in ev.get("signs", [])]
    signs = " ".join(labels) or "-"
    if ev.get("needs_repeat"):
        return f"CAPTION  [unclear: ask the guest to repeat]  (signs: {signs})", None
    sentence = sentence_for(labels)
    if recognizer_state == "mock":
        return f"CAPTION  [mock recognizer, not spoken]  {sentence or signs}", None
    if sentence is None:
        return f"CAPTION  Guest signed: {signs}  (no fixed sentence; not spoken)", None
    return f"CAPTION  Guest: {sentence}", sentence


class SayEngine:
    """One `say` process per sentence; the text goes on standard input (-f -), never through a shell.
    Measured: 1.8 to 2.5 s for `say -o file hi` alone (process start and voice load), so
    AppKitEngine is preferred when pyobjc is installed."""
    name = "say"

    def __init__(self, voice=None, run=None):
        self.exe = shutil.which("say")
        if run is None and self.exe is None:
            raise RuntimeError("--say needs the macOS 'say' command (not found on this system)")
        self.voice, self.run, self._proc = voice, run or self._run, None

    def args(self):
        return [self.exe or "say"] + (["-v", self.voice] if self.voice else []) + ["-f", "-"]

    def speak(self, text):
        self.run(self.args(), text)

    def _run(self, args, text):
        self._proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.DEVNULL)
        try:
            self._proc.communicate(text.encode(), timeout=SAY_TIMEOUT)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            self._proc.wait()
        finally:
            self._proc = None

    def stop(self):
        proc = self._proc
        if proc is not None and proc.poll() is None:
            proc.kill()


class AppKitEngine:
    """The same macOS voices as `say`, through one NSSpeechSynthesizer kept open (pyobjc AppKit), so
    each sentence starts without a new process. Created in the speaking thread and warmed up at
    volume 0. Measured (render to a file, warm): 0.32 to 0.35 s for a whole sentence."""
    name = "appkit"

    def __init__(self, voice=None):
        from AppKit import NSSpeechSynthesizer   # ImportError -> the caller falls back to `say`
        vid = None
        if voice:
            for v in NSSpeechSynthesizer.availableVoices():
                attrs = NSSpeechSynthesizer.attributesForVoice_(v)
                if str(attrs.get("VoiceName", "")).lower() == voice.lower() or str(v).lower().endswith("." + voice.lower()):
                    vid = v
                    break
            if vid is None:
                raise LookupError(f"voice {voice!r} not found")
        self.syn = NSSpeechSynthesizer.alloc().initWithVoice_(vid)
        if self.syn is None:
            raise RuntimeError("NSSpeechSynthesizer could not start")
        self.syn.setVolume_(0.0)
        self.speak("ready")
        self.syn.setVolume_(1.0)

    def speak(self, text):
        self.syn.startSpeakingString_(text)
        end = time.monotonic() + SAY_TIMEOUT
        time.sleep(0.02)
        while self.syn.isSpeaking() and time.monotonic() < end:
            time.sleep(0.02)

    def stop(self):
        self.syn.stopSpeaking()


class Speaker:
    """Speaks sentences one after another in a worker thread; speak() never blocks. Older sentences
    are dropped when more than maxsize wait.

    engine: "auto" (AppKitEngine if pyobjc AppKit loads, else `say`), "appkit" or "say".
    run: a fake process runner for tests (forces the `say` engine)."""

    def __init__(self, voice=None, engine="auto", run=None, maxsize=QUEUE_MAX, log=None):
        if engine not in ("auto", "appkit", "say"):
            raise ValueError("engine must be auto, appkit or say")
        self.voice, self.want = voice, "say" if run is not None else engine
        self.log = log or (lambda msg: print(msg, file=sys.stderr))
        self.say = SayEngine(voice, run) if self.want != "appkit" else None    # raises early if `say` is missing
        self.engine = None
        self.q = queue.Queue(maxsize=maxsize)
        self.spoken = self.dropped = 0
        self.busy = False
        self.ready = threading.Event()
        self._stop = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def speak(self, text):
        if not text:
            return
        try:
            self.q.put_nowait(text)
        except queue.Full:
            try:
                self.q.get_nowait()
                self.dropped += 1
            except queue.Empty:
                pass
            self.q.put_nowait(text)

    def _make(self):
        if self.want in ("auto", "appkit"):
            try:
                return AppKitEngine(self.voice)
            except Exception as e:
                if self.want == "appkit" or self.say is None:
                    self.log(f"  speech: AppKit voice unavailable ({type(e).__name__}: {e}); nothing will be spoken")
                    return None
                self.log(f"  speech: AppKit voice unavailable ({type(e).__name__}); using the 'say' command")
        return self.say

    def _loop(self):
        self.engine = self._make()
        self.ready.set()
        while not self._stop.is_set():
            try:
                text = self.q.get(timeout=0.1)
            except queue.Empty:
                continue
            if self.engine is None:
                continue
            self.busy = True
            try:
                self.engine.speak(text)
                self.spoken += 1
            except Exception as e:  # a voice failure must never stop recognition
                self.log(f"  speech failed ({type(e).__name__})")
            finally:
                self.busy = False

    def close(self, timeout=SAY_TIMEOUT):
        """Let the queued sentences finish (at most timeout seconds), then stop any speech."""
        end = timeout
        while (not self.q.empty() or self.busy) and end > 0:
            self._stop.wait(0.05)
            end -= 0.05
        self._stop.set()
        if self.engine is not None:
            try:
                self.engine.stop()
            except Exception:
                pass
        self.thread.join(1.0)
