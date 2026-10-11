"""Shared VLM prompts and the robust reply parser (no model needed)."""
from recognition.vlm import prompts as P


def test_label_list_is_the_22_classes():
    assert len(P.LABELS) == 22 and len(set(P.LABELS)) == 22
    assert P.LABELS[-1] == "NONE" and "LEAVE" in P.LABELS
    assert set(P.SIGN_HINTS) == set(P.LABELS)


def test_closed_set_prompt_lists_every_label_once_and_is_engine_neutral():
    for hints in (True, False):
        text = P.build_closed_set(8, hints=hints)
        for lab in P.LABELS:
            assert lab in text
        assert "8 frames" in text and "JSON" in text
    assert "dictionary form" in P.build_closed_set(4, hints=True)
    assert "dictionary form" not in P.build_closed_set(4, hints=False)


def test_other_prompts_build():
    assert "3 most likely" in P.build_open_set(6)
    q = P.build_qc("PASSWORD", 6, 8)
    assert "first 6 images" in q and "next 8 images" in q and "PRIVATE" in q
    assert "yes_no_question" in P.build_facial(8)


def test_parse_json_variants():
    assert P.parse_json('{"label": "YES"}') == {"label": "YES"}
    assert P.parse_json('Sure!\n```json\n{"label": "NO", "confidence": 0.4}\n```\nDone') == {
        "label": "NO", "confidence": 0.4}
    assert P.parse_json('<think>{"label":"X"}</think> {"label": "TIME"}') == {"label": "TIME"}
    assert P.parse_json("{'label': 'HELP', 'confidence': 0.5,}") == {"label": "HELP", "confidence": 0.5}
    assert P.parse_json('{"a": {"b": 1}, "s": "brace } in string"}') == {"a": {"b": 1}, "s": "brace } in string"}
    assert P.parse_json('{"ok": True, "x": None}') == {"ok": True, "x": None}
    assert P.parse_json("no json here") is None
    assert P.parse_json("") is None
    assert P.parse_json('{"label": "YES"') is None  # truncated


def test_normalize_label_synonyms():
    n = P.normalize_label
    assert n("thank you") == "THANK-YOU"
    assert n("Wi-Fi") == "FS-WIFI"
    assert n("FS-CHECKOUT") == "LEAVE" and n("checkout") == "LEAVE"
    assert n("thank_you") == "THANK-YOU"
    assert n(" breakfast. ") == "BREAKFAST"
    assert n("DOG") is None and n(None) is None and n(3) is None


def test_parse_closed_set_json_and_fallbacks():
    r = P.parse_closed_set('{"label": "thank you", "confidence": 85, "top3": ["THANK-YOU", "PLEASE", "DOG"]}')
    assert r["ok"] and r["label"] == "THANK-YOU" and r["confidence"] == 0.85
    assert r["top3"] == ["THANK-YOU", "PLEASE"]
    r = P.parse_closed_set('{"label": "DOG"}')
    assert not r["ok"] and r["format"] == "json_bad_label"
    r = P.parse_closed_set("I think this is the sign WHERE, maybe TIME.")
    assert r["ok"] and r["label"] == "WHERE" and r["format"] == "free_text"
    r = P.parse_closed_set("unclear")
    assert not r["ok"] and r["label"] is None
    # top3 is reordered so the chosen label comes first
    r = P.parse_closed_set('{"label": "NO", "top3": ["YES", "NO"]}')
    assert r["top3"][0] == "NO"
    # restricted label set
    r = P.parse_closed_set('{"label": "YES"}', labels=["NO", "NONE"])
    assert not r["ok"]


def test_parse_open_set():
    r = P.parse_open_set('{"is_sign": true, "meanings": [{"gloss": "water", "english": "Can I have water?", '
                         '"confidence": 0.6}, "drink", {"bad": 1}, {"gloss": "x"}, {"gloss": "y"}]}')
    assert r["ok"] and r["is_sign"] is True
    assert [m["gloss"] for m in r["meanings"]] == ["WATER", "DRINK", "X"]
    r = P.parse_open_set('{"is_sign": "false", "meanings": []}')
    assert r["ok"] and r["is_sign"] is False and r["meanings"] == []
    assert not P.parse_open_set("nope")["ok"]


def test_parse_qc():
    r = P.parse_qc('{"same_sign": false, "score": 0.2, "handshape_ok": "no", "issues": "wrong location"}')
    assert r["ok"] and r["same_sign"] is False and r["handshape_ok"] is False
    assert r["issues"] == ["wrong location"]
    r = P.parse_qc('{"score": 0.9}')
    assert r["ok"] and r["same_sign"] is True
    assert not P.parse_qc('{"issues": []}')["ok"]
    assert not P.parse_qc("garbage")["ok"]


def test_parse_facial():
    assert P.parse_facial('{"marker": "wh-question"}')["marker"] == "wh_question"
    assert P.parse_facial('{"marker": "Yes/No question"}')["marker"] == "yes_no_question"
    assert P.parse_facial('{"marker": "none"}')["marker"] == "neutral"
    assert not P.parse_facial('{"marker": "happy"}')["ok"]


def test_tasks_registry():
    assert set(P.TASKS) == {"closed_set", "open_set", "qc", "facial"}
