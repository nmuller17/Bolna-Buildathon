"""Regression cases for the fairness-audit findings (Track B scoring and blinding, R8 macro-F1, signer averages)."""
import csv
import json

from recognition.compare import common, fairness


def rec(system, clip, signer, label, pred=None, conf=None, **kw):
    return common.record(system, clip, signer, label, top=[(pred, conf)] if pred else [], track="B", **kw)


def test_track_b_counts_non_answers_as_wrong_not_dropped(tmp_path, monkeypatch):
    from recognition.compare import report
    recs = []
    for i in range(60):
        right = i % 4 != 0
        recs.append(rec("sysA", f"c{i}", f"s{i % 4}", "YES", "YES" if right else "NO"))
        # the rival answers only the 15 clips it gets right and leaves the rest blank
        recs.append(rec("rival", f"c{i}", f"s{i % 4}", "YES", "YES" if i % 4 == 0 else None))
    recs = [r for r in recs if not (r["system"] == "rival" and r["clip_id"] == "c59")]  # and one row is missing
    common.write_jsonl(tmp_path / "preds" / "all.jsonl", recs)
    monkeypatch.setattr(report, "REPORTS", tmp_path / "reports")
    report.track_b(tmp_path / "preds", "unit", B=20)
    out = json.loads((tmp_path / "reports" / "track_b_unit.json").read_text())
    assert out["systems"]["sysA"]["metrics"]["accuracy"] == 0.75
    assert out["systems"]["rival"]["metrics"]["accuracy"] == 0.25
    assert out["systems"]["rival"]["n_clips"] == 60
    assert out["no_answer_rate"]["rival"] == 0.75


def test_open_set_non_answer_is_not_an_accept():
    r = rec("x", "1", "a", "NONE", None, oov=True, oov_sign="dog")
    assert not common.accepted(r)


def test_map_text_never_turns_several_keywords_into_none():
    from recognition.compare.track_b_video import map_text
    assert map_text("Where is my room?") == (["WHERE", "ROOM"], "multi:WHERE|ROOM")
    assert map_text("Yes please")[0] == ["YES", "PLEASE"]
    assert map_text("What time is breakfast?")[0] == ["TIME", "BREAKFAST"]
    assert map_text("What is your name?") == (["NAME"], "mapped")
    assert map_text("good morning") == (["NONE"], "no-match")
    assert map_text("   ") == ([], "empty")


def test_manual_sheet_is_blinded_and_unblinded_only_by_the_key(tmp_path, monkeypatch):
    from recognition.compare import track_b_video as tb
    clips = tmp_path / "clips"
    for lab, name in [("YES", "p1_0"), ("THANK-YOU", "p1_1"), ("_OOV", "p1_dog_0")]:
        (clips / lab).mkdir(parents=True, exist_ok=True)
        (clips / lab / f"{name}.mp4").write_bytes(b"not a real video")
    monkeypatch.setattr(tb, "OUT", tmp_path / "out")
    sheet = tmp_path / "blind" / "rylo.csv"
    key = tb.template(clips, "rylo", sheet)
    text = sheet.read_text()
    for leak in ("YES", "THANK", "_OOV", "dog", "p1_"):
        assert leak not in text
    blind_files = sorted(p.name for p in (sheet.parent / "rylo_clips").iterdir())
    assert all("YES" not in n and "dog" not in n for n in blind_files) and len(blind_files) == 3
    assert key.parent != sheet.parent
    rows = list(csv.DictReader(open(sheet)))
    answers = {"YES/p1_0": "yes", "THANK-YOU/p1_1": "thank you very much", "_OOV/p1_dog_0": "where is the room"}
    k = json.loads(key.read_text())["tokens"]
    for r in rows:
        r["output_text"] = answers[k[r["token"]]]
    with open(sheet, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    tb.manual(sheet, clips, "rylo", key)
    got = {r["clip_id"]: r for r in common.read_jsonl([tmp_path / "out" / "preds" / "rylo.jsonl"])}
    assert common.pred_of(got["YES/p1_0"]) == "YES"
    assert common.pred_of(got["THANK-YOU/p1_1"]) == "THANK-YOU"
    assert common.accepted(got["_OOV/p1_dog_0"])  # a sentence naming our signs on an outside clip is a false accept


def test_r8_macro_f1_with_none_penalises_refusals():
    labels = ["YES", "NO", "NONE"]
    def r(clip, true, pred, oov=False):
        return common.record("s", clip, "a", true, top=[(pred, .9)], oov=oov)
    refuser = [r("1", "YES", "YES"), r("2", "NO", "NONE"), r("3", "NONE", "NONE", True)]
    # NONE is a class: the refused NO clip is a false positive of NONE, so NONE's F1 is 2/3, not 1
    assert abs(fairness.macro_f1_with_none(refuser, labels) - (1 + 0 + 2 / 3) / 3) < 1e-9
    # a false accept on an outside clip costs the precision of the sign it was mistaken for
    acceptor = [r("1", "YES", "YES"), r("2", "NO", "NO"), r("3", "NONE", "YES", True)]
    assert abs(fairness.macro_f1_with_none(acceptor, labels) - (2 / 3 + 1 + 0) / 3) < 1e-9


def test_signer_average_weights_people_equally():
    recs = [common.record("s", f"a{i}", "a", "YES", top=[("YES", .9)]) for i in range(9)]
    recs.append(common.record("s", "b0", "b", "YES", top=[("NO", .9)]))
    assert fairness.top1(recs) == 0.9
    assert fairness.signer_avg(recs) == 0.5
