"""Red-team regression tests: live.py --post cannot send BRIDGE_KEY or events off the laptop (A4)."""
import pytest

from recognition import live

KEY = "k" * 40

LOOPBACK_URLS = ["http://127.0.0.1:3000/api/guest/signs", "http://localhost:3000/x", "http://[::1]:3000/x",
                 "http://127.0.0.2/x", "https://127.0.0.1/x"]
REMOTE_URLS = ["http://169.254.169.254/latest/meta-data", "http://10.0.0.5:8111/x", "https://attacker.example/c",
               "http://127.0.0.1@evil.example/x", "http://localhost.evil.example/x", "http://10.0.149.212:8131/collect"]


@pytest.mark.parametrize("url", LOOPBACK_URLS)
def test_loopback_urls_are_accepted(url):
    assert live.check_post_url(url) is None


@pytest.mark.parametrize("url", REMOTE_URLS + ["file:///etc/passwd", "gopher://x/", "ftp://x/"])
def test_remote_and_non_http_urls_are_refused(url):
    assert live.check_post_url(url) is not None


def test_remote_needs_the_flag_and_https():
    assert live.check_post_url("https://app.example/x", allow_remote=True) is None
    assert "https" in live.check_post_url("http://10.0.0.5:8111/x", allow_remote=True)


@pytest.mark.parametrize("url", REMOTE_URLS)
def test_poster_refuses_to_attach_the_key_to_a_remote_url(url, monkeypatch):
    opened = []
    monkeypatch.setattr(live.urllib.request.OpenerDirector, "open", lambda self, *a, **k: opened.append(a))
    with pytest.raises(ValueError):
        live.Poster(url, KEY)
    assert opened == []


@pytest.mark.parametrize("url", ["http://169.254.169.254/latest/meta-data", "https://attacker.example/c"])
def test_live_main_exits_before_touching_the_camera(url, monkeypatch):
    monkeypatch.setenv("BRIDGE_KEY", KEY)

    def no_camera():
        raise AssertionError("camera opened")
    monkeypatch.setattr(live, "import_cv2", no_camera)
    with pytest.raises(SystemExit) as e:
        live.main(["--post", url, "--mock", "--no-preview"])
    assert "laptop" in str(e.value)
