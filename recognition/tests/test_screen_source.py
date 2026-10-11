"""Screen source (live.py --source screen) and the call-demo captions / voice. No screen permission
needed: every test uses a fake grabber, fake window lists and a fake clock."""
import functools
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from recognition import call_voice, live, mediapipe_adapter as mpa, screen_source as ss

ROOT = Path(__file__).resolve().parents[2]


# ---------- regions ----------

def test_parse_region_accepts_four_whole_numbers():
    assert ss.parse_region("10,20,640,360") == (10, 20, 640, 360)
    assert ss.parse_region(" 0, 0 ,1280, 720 ") == (0, 0, 1280, 720)


@pytest.mark.parametrize("text, why", [("1,2,3", "four numbers"), ("a,b,c,d", "whole numbers"),
                                       ("0,0,10.5,20", "whole numbers"), ("0,0,32,400", "too small"),
                                       ("-5,0,640,360", "0 or more"), ("", "four numbers")])
def test_parse_region_rejects_bad_input(text, why):
    with pytest.raises(ValueError, match=why):
        ss.parse_region(text)


def test_live_cli_reports_a_bad_region():
    with pytest.raises(SystemExit):
        live.main(["--source", "screen", "--region", "1,2,3"])


def test_validate_region_inside_bounds():
    assert ss.validate_region((0, 0, 100, 100), (0, 0, 100, 100)) == (0, 0, 100, 100)
    with pytest.raises(ValueError, match="not inside"):
        ss.validate_region((50, 0, 100, 100), (0, 0, 120, 100))
    with pytest.raises(ValueError, match="too small"):
        ss.validate_region((0, 0, 10, 100), (0, 0, 120, 100))


def test_output_size_caps_the_width_and_keeps_the_aspect():
    assert ss.output_size(1280, 720) == (1280, 720)
    assert ss.output_size(2560, 1440) == (1280, 720)
    assert ss.output_size(1920, 1200, 1280) == (1280, 800)


def test_size_warnings():
    assert ss.warnings_for((1280, 720)) == []
    assert any("16:9" in w for w in ss.warnings_for((800, 800)))
    assert any("pixels tall" in w for w in ss.warnings_for((480, 270)))


# ---------- windows ----------

def raw_entry(num, owner, x, y, w, h, title=None, layer=0, onscreen=True, pid=None):
    d = {"kCGWindowNumber": num, "kCGWindowOwnerName": owner, "kCGWindowLayer": layer,
         "kCGWindowIsOnscreen": onscreen, "kCGWindowBounds": {"X": x, "Y": y, "Width": w, "Height": h}}
    if title is not None:
        d["kCGWindowName"] = title
    if pid is not None:
        d["kCGWindowOwnerPID"] = pid
    return d


RAW = [raw_entry(1, "Control Center", 896, 0, 32, 33, layer=25),
       raw_entry(2, "zoom.us", 0, 0, 300, 80, title="Zoom"),                      # toolbar
       raw_entry(3, "zoom.us", 100, 50, 1280, 760, title="Zoom Meeting"),
       raw_entry(4, "Google Chrome", 0, 0, 1500, 900, title="Meet - abc-defg-hij"),
       raw_entry(5, "FaceTime", 0, 0, 900, 600, onscreen=False),
       {"kCGWindowNumber": 6, "kCGWindowOwnerName": "broken"},                    # no bounds
       raw_entry(7, "Microsoft Teams", 10.0, 20.0, 1000.0, 700.0)]                  # floats from Quartz


def test_parse_windows_skips_entries_without_bounds_and_off_screen():
    wins = ss.parse_windows(RAW)
    assert [w.id for w in wins] == [1, 2, 3, 4, 7]
    teams = wins[-1]
    assert (teams.owner, teams.title, teams.x, teams.y, teams.w, teams.h) == ("Microsoft Teams", "", 10, 20, 1000, 700)
    assert ss.parse_windows(None) == []


def test_find_window_matches_owner_or_title_and_refuses_when_several_match():
    wins = ss.parse_windows(RAW)
    assert ss.find_window("ZOOM MEETING", wins).id == 3       # title, case-insensitive
    assert ss.find_window("Google Chrome", wins).id == 4      # owner
    assert ss.find_window("teams", wins).id == 7
    assert ss.find_window("control center", wins) is None    # menu-bar layer is never chosen
    assert ss.find_window("FaceTime", wins) is None          # minimized / off screen
    assert ss.find_window("  ", wins) is None
    with pytest.raises(ss.ScreenSourceError, match="--window-id") as e:   # toolbar + meeting: never guess
        ss.find_window("zoom.us", wins)
    assert "     2  zoom.us" in str(e.value) and "     3  zoom.us" in str(e.value)


# Review finding 3: a Meet window and our own call-share page are both Google Chrome windows.
CHROME = [raw_entry(1, "Google Chrome", 0, 0, 900, 600, title="Meet - abc-defg-hij"),
          raw_entry(2, "Google Chrome", 0, 0, 1440, 900, title="SignBridge call share"),
          raw_entry(3, "Google Chrome", 0, 0, 1280, 720, title="127.0.0.1:3000/call-share/window"),
          raw_entry(4, "Python", 0, 0, 1280, 720, title="recognition (screen source)", pid=4242)]


def test_own_windows_are_never_chosen():
    wins = ss.parse_windows(CHROME)
    assert wins[3].pid == 4242
    assert ss.find_window("google chrome", wins, own_pid=4242).id == 1     # not the larger avatar page
    assert ss.find_window("signbridge", wins, own_pid=4242) is None
    assert ss.find_window("python", wins, own_pid=4242) is None            # our own preview
    for own in (2, 3, 4):
        with pytest.raises(ss.ScreenSourceError, match="own window"):
            ss.find_window_id(own, wins, own_pid=4242)
    assert ss.find_window_id(1, wins, own_pid=4242).title.startswith("Meet")
    with pytest.raises(ss.ScreenSourceError, match="--list-windows"):
        ss.find_window_id(99, wins, own_pid=4242)
    text = ss.format_windows(wins, own_pid=4242)
    assert text.splitlines()[0].strip().startswith("id") and text.count("never read") == 3


def test_window_id_is_followed_and_stops_when_it_turns_into_our_page():
    clock = FakeClock()
    state = {"wins": ss.parse_windows(CHROME[:1])}
    logs = []
    src = ss.ScreenSource(window_id=1, grabber=(g := FakeGrabber()), windows=lambda: state["wins"],
                          permission=lambda: True, clock=clock, sleep=clock.sleep, log=logs.append, own_pid=4242)
    assert src.rect == [0, 0, 900, 600] and "window 1 'Google Chrome'" in src.describe()
    assert src.read()[0]
    state["wins"] = ss.parse_windows([raw_entry(1, "Google Chrome", 0, 0, 900, 600, title="SignBridge AI")])
    clock.t += 1.0
    n = len(g.calls)
    assert src.read() == (False, None) and len(g.calls) == n and "own page" in logs[-1]
    state["wins"] = ss.parse_windows(CHROME[:1])                                         # tab back to Meet
    clock.t += 1.0
    assert src.read()[0]


def test_something_to_read_must_be_named():
    with pytest.raises(ss.ScreenSourceError, match="--whole-screen"):
        make_source(region=None)
    with pytest.raises(ss.ScreenSourceError, match="not both"):
        make_source(region=None, window_id=1, window_name="zoom.us")
    with pytest.raises(ss.ScreenSourceError, match="cannot be combined"):
        make_source(whole_screen=True)                     # with the default region


def test_region_alone_must_lie_on_a_display():
    with pytest.raises(ValueError, match="not inside"):
        make_source(region=(5000, 5000, 640, 360))
    with pytest.raises(ValueError, match="not inside"):
        make_source(region=(2800, 0, 640, 360))            # runs off the right edge
    assert make_source(region=(2384, 1604, 640, 360))[0].rect == [2384, 1604, 640, 360]


def test_unknown_permission_warns_and_goes_on():
    logs = []
    clock = FakeClock()
    src = ss.ScreenSource(region=(0, 0, 640, 360), bounds=lambda: SCREEN, grabber=FakeGrabber(),
                          permission=lambda: None, clock=clock, sleep=clock.sleep, log=logs.append)
    assert src.size == (640, 360) and any("could not check" in m for m in logs)


def test_live_refuses_screen_source_without_a_target(monkeypatch):
    monkeypatch.setattr(live, "import_cv2", lambda: None)
    monkeypatch.setattr(ss, "ScreenSource", functools.partial(ss.ScreenSource, permission=lambda: True,
                                                              grabber=FakeGrabber()))
    with pytest.raises(SystemExit, match="--whole-screen"):
        live.main(["--source", "screen", "--mock"])


def test_format_windows_explains_missing_titles():
    text = ss.format_windows(ss.parse_windows([raw_entry(9, "zoom.us", 0, 0, 800, 600)]))
    assert "zoom.us" in text and "Screen Recording permission" in text
    assert ss.format_windows([]) == "(no on-screen windows found)"


# ---------- permission ----------

def test_missing_permission_is_a_clear_error():
    with pytest.raises(ss.ScreenPermissionError, match="Screen & System Audio Recording"):
        ss.ScreenSource(region=(0, 0, 640, 360), permission=lambda: False, grabber=FakeGrabber())


def test_live_exits_with_the_permission_hint(monkeypatch, capsys):
    monkeypatch.setattr(live, "import_cv2", lambda: None)
    monkeypatch.setattr(ss, "has_screen_permission", lambda: False)
    monkeypatch.setattr(ss, "ScreenSource", functools.partial(ss.ScreenSource, permission=lambda: False))
    with pytest.raises(SystemExit) as e:
        live.main(["--source", "screen", "--region", "0,0,640,360", "--mock"])
    assert "Privacy & Security" in str(e.value.code)


def test_permission_check_does_not_prompt():
    assert ss.has_screen_permission() in (True, False, None)


# ---------- capture ----------

class FakeGrabber:
    """grabber factory: each grab returns a BGRA image of the asked size times scale, value = call count."""

    def __init__(self, scale=1, fail_after=None):
        self.scale, self.fail_after, self.calls, self.made, self.closed = scale, fail_after, [], 0, 0

    def __call__(self):
        self.made += 1

        def grab(x, y, w, h):
            self.calls.append((x, y, w, h))
            if self.fail_after is not None and len(self.calls) > self.fail_after:
                raise OSError("display gone")
            img = np.zeros((h * self.scale, w * self.scale, 4), np.uint8)
            img[..., 0], img[..., 2], img[..., 3] = 10, 200, 255        # B=10, R=200, alpha
            img[:, : w * self.scale // 2, 1] = 50                         # left half G=50 (to check mirroring)
            return img

        def close():
            self.closed += 1
        grab.close = close
        return grab


class FakeClock:
    def __init__(self):
        self.t, self.slept = 100.0, []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


SCREEN = (0, 0, 3024, 1964)          # all displays, for checking a --region given alone


def make_source(grabber=None, clock=None, **kw):
    clock = clock or FakeClock()
    kw.setdefault("region", (0, 0, 640, 360))
    kw.setdefault("bounds", lambda: SCREEN)
    kw.setdefault("log", lambda m: None)
    return ss.ScreenSource(grabber=grabber or FakeGrabber(), permission=lambda: True, clock=clock,
                           sleep=clock.sleep, **kw), clock


def test_frames_are_bgr_of_the_reported_size():
    src, _ = make_source()
    assert src.size == (640, 360) and src.isOpened()
    ok, bgr = src.read()
    assert ok and bgr.shape == (360, 640, 3) and bgr.dtype == np.uint8 and bgr.flags["C_CONTIGUOUS"]
    assert tuple(bgr[0, 0]) == (10, 50, 200) and tuple(bgr[0, -1]) == (10, 0, 200)


def test_retina_pixels_are_downscaled_to_max_width():
    pytest.importorskip("cv2")
    src, _ = make_source(grabber=FakeGrabber(scale=2), region=(0, 0, 1280, 720))
    assert src.pixels == (2560, 1440) and src.size == (1280, 720)
    ok, bgr = src.read()
    assert ok and bgr.shape == (720, 1280, 3)


def test_mirror_flips_left_and_right():
    src, _ = make_source(mirror=True)
    ok, bgr = src.read()
    assert tuple(bgr[0, 0]) == (10, 0, 200) and tuple(bgr[0, -1]) == (10, 50, 200)


def test_frames_are_paced_at_the_target_fps():
    src, clock = make_source(fps=20)
    times = []
    for _ in range(5):
        assert src.read()[0]
        times.append(clock())
    assert np.allclose(np.diff(times), 0.05)


def test_fps_must_be_sensible():
    for fps in (0, -1, 500):
        with pytest.raises(ValueError, match="--fps"):
            make_source(fps=fps)


def test_capture_failure_returns_false_instead_of_raising():
    src, _ = make_source(grabber=FakeGrabber(fail_after=2))       # the probe grab is call 1
    assert src.read()[0] is True
    assert src.read() == (False, None)


def test_release_closes_the_grabber():
    g = FakeGrabber()
    src, _ = make_source(grabber=g)
    src.read()
    src.release()
    assert g.made == 2 and g.closed == 2      # probe + reading thread, both closed


def test_window_with_relative_region_follows_the_window():
    clock = FakeClock()
    state = {"wins": ss.parse_windows([raw_entry(3, "zoom.us", 100, 50, 1280, 760)])}
    logs = []
    src = ss.ScreenSource(window_name="zoom.us", region=(640, 40, 640, 360), grabber=(g := FakeGrabber()),
                          windows=lambda: state["wins"], permission=lambda: True, clock=clock, sleep=clock.sleep,
                          log=logs.append, follow_sec=1.0)
    assert src.rect == [740, 90, 640, 360] and src.size == (640, 360)
    src.read()
    assert g.calls[-1] == (740, 90, 640, 360)
    state["wins"] = ss.parse_windows([raw_entry(3, "zoom.us", 200, 60, 1280, 760)])        # moved
    clock.t += 1.0
    src.read()
    assert g.calls[-1] == (840, 100, 640, 360)
    state["wins"] = ss.parse_windows([raw_entry(3, "zoom.us", 200, 60, 1000, 700)])        # resized: warn once
    for _ in range(2):
        clock.t += 1.0
        src.read()
    assert sum("resized" in m for m in logs) == 1 and g.calls[-1][2:] == (640, 360)
    state["wins"] = []                                                                      # closed / minimized
    clock.t += 1.0
    assert src.read() == (False, None) and "closed or minimized" in logs[-1]
    n = len(g.calls)
    assert src.read() == (False, None) and len(g.calls) == n          # the old rectangle is never read again
    state["wins"] = ss.parse_windows([raw_entry(3, "zoom.us", 0, 0, 1280, 760)])            # restored
    clock.t += 1.0
    assert src.read()[0] and g.calls[-1] == (640, 40, 640, 360)


def test_window_region_must_fit_the_window_and_window_must_exist():
    wins = ss.parse_windows([raw_entry(3, "zoom.us", 100, 50, 800, 450)])
    with pytest.raises(ValueError, match="not inside"):
        make_source(window_name="zoom.us", region=(400, 0, 640, 360), windows=lambda: wins)
    with pytest.raises(ss.ScreenSourceError, match="--list-windows"):
        make_source(window_name="FaceTime", region=None, windows=lambda: wins)


def test_whole_display_only_when_asked():
    src, _ = make_source(region=None, whole_screen=True, display=lambda: (0, 0, 1512, 982))
    assert src.rect == [0, 0, 1512, 982] and src.size == (1280, 831)


def test_screen_options_need_source_screen():
    for extra in (["--window-name", "zoom.us"], ["--window-id", "4"], ["--whole-screen"]):
        with pytest.raises(SystemExit, match="need --source screen"):
            live.main([*extra, "--mock"])


def test_importing_does_not_load_capture_libraries():
    code = ("import sys, recognition.screen_source, recognition.call_voice, recognition.live, recognition.server; "
            "print(sorted(m for m in ('mss', 'Quartz', 'cv2', 'mediapipe') if m in sys.modules))")
    out = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "[]"


# ---------- captions and voice ----------

def utt(labels, confs=None, repeat=False):
    confs = confs or [0.9] * len(labels)
    return {"type": "utterance", "signs": [{"label": l, "conf": c} for l, c in zip(labels, confs)],
            "needs_repeat": repeat}


def test_captions_follow_the_app_rules():
    line, say = call_voice.caption(utt(["WHERE", "ELEVATOR"]))
    assert say == "Where is the elevator?" and "Where is the elevator?" in line
    assert call_voice.caption(utt(["FS-CHECKOUT", "TIME"]))[1] == "What time is checkout?"      # old label -> LEAVE
    assert call_voice.caption(utt(["LATE", "LEAVE", "PLEASE"]))[1] == "Could I have a late checkout?"
    line, say = call_voice.caption(utt(["MORE", "TOWEL", "PLEASE"], repeat=True))
    assert say is None and "repeat" in line
    line, say = call_voice.caption(utt(["YES"]), "mock")
    assert say is None and "mock" in line
    line, say = call_voice.caption(utt(["WHERE", "TAXI"]))
    assert say is None and "WHERE TAXI" in line


def test_every_intent_uses_known_labels():
    from recognition.labels import CLASSES
    known = {call_voice.normalize(c) for c in CLASSES}
    assert len(call_voice.INTENTS) == 19                      # section 2 minus #4 (NAME + typed name)
    assert all(set(k) <= known for k in call_voice.INTENTS)


def test_speaker_uses_say_with_stdin_and_drops_the_oldest():
    got = []
    sp = call_voice.Speaker(voice="Samantha", run=lambda args, text: got.append((args, text)), maxsize=2)
    sp.speak("Yes.")
    sp.close(timeout=2)
    assert got and got[0][1] == "Yes." and got[0][0][-4:] == ["-v", "Samantha", "-f", "-"]
    sp2 = call_voice.Speaker(run=lambda a, t: None, maxsize=1)
    sp2._stop.set()                       # worker stopped: the queue fills
    sp2.thread.join(1)
    sp2.speak("one"), sp2.speak("two")
    assert sp2.dropped == 1 and sp2.q.get_nowait() == "two"


# ---------- the whole pipeline from a fake screen ----------

def test_fake_screen_drives_the_live_pipeline(monkeypatch, capsys):
    """live.main --source screen --say: fake screen frames -> (fake) landmarker -> real SignStream,
    segmenter and framing gate -> recognizer -> sign / utterance events -> caption + spoken sentence."""
    from recognition.tests.test_stream import Spy, motion
    rng = np.random.default_rng(3)
    results = motion(20, False, rng, sign_at=99) + motion(110, False, rng, sign_at=5)

    clock = FakeClock()
    monkeypatch.setattr(live.time, "monotonic", clock)
    grab = FakeGrabber()
    monkeypatch.setattr(ss, "ScreenSource", functools.partial(
        ss.ScreenSource, grabber=grab, permission=lambda: True, clock=clock, sleep=clock.sleep, log=lambda m: None,
        bounds=lambda: SCREEN))

    class SyncReader:                        # CameraReader without the thread, on the fake clock
        def __init__(self, cap):
            self.cap, self.skipped, self.n = cap, 0, 0

        def get(self):
            if self.n >= len(results):
                return None
            ok, img = self.cap.read()
            self.n += 1
            return (img, clock()) if ok else None

        def stop(self):
            pass

    class LM:
        def __init__(self):
            self.i, self.sizes = 0, set()

        def detect_for_video(self, img, ts):
            self.sizes.add(img.shape)
            r = results[self.i]
            self.i += 1
            return r

        def close(self):
            pass

    lm = LM()
    spoken = []
    monkeypatch.setattr(live, "CameraReader", SyncReader)
    monkeypatch.setattr(live, "load_landmarker", lambda args: lm)
    monkeypatch.setattr(live, "load_recognizer", lambda args, allow_missing: (Spy(conf=0.9, label="YES"), "ok"))
    monkeypatch.setattr(mpa, "mp_image", lambda rgb: rgb)
    monkeypatch.setattr(live.call_voice, "Speaker",
                        functools.partial(call_voice.Speaker, run=lambda args, text: spoken.append(text)))
    live.main(["--source", "screen", "--region", "0,0,1280,720", "--fps", "30", "--say", "--utterance-gap", "1.5"])
    out = capsys.readouterr().out
    assert lm.i == len(results) and lm.sizes == {(720, 1280, 3)}        # every frame, at the captured size
    assert "screen screen region at 0,0 size 1280x720" in out
    assert "sign 1: YES 0.90" in out and "utterance: YES" in out
    assert "CAPTION  Guest: Yes." in out and spoken == ["Yes."]


def test_speaker_prefers_the_warm_engine_and_falls_back_to_say(monkeypatch):
    spoken = []

    class Warm:
        name = "appkit"

        def __init__(self, voice):
            self.voice = voice

        def speak(self, text):
            spoken.append(text)

        def stop(self):
            pass
    monkeypatch.setattr(call_voice, "AppKitEngine", Warm)
    sp = call_voice.Speaker(voice="Daniel", engine="auto", log=lambda m: None)
    assert sp.ready.wait(5) and sp.engine.name == "appkit" and sp.engine.voice == "Daniel"
    sp.speak("Thank you.")
    sp.close(timeout=2)
    assert spoken == ["Thank you."]

    def broken(voice):
        raise ImportError("no AppKit")
    monkeypatch.setattr(call_voice, "AppKitEngine", broken)
    logs = []
    sp = call_voice.Speaker(engine="auto", log=logs.append)
    assert sp.ready.wait(5) and sp.engine.name == "say" and "using the 'say' command" in logs[0]
    sp.close(timeout=0)                      # nothing queued: nothing is spoken
    sp = call_voice.Speaker(engine="appkit", log=logs.append)
    assert sp.ready.wait(5) and sp.engine is None and "nothing will be spoken" in logs[-1]
    sp.close(timeout=0)
