import json

import numpy as np
import pytest
import torch

from recognition.benchmark import metrics, open_set
from recognition.data import load_dataset, signer_of, to_arrays
from recognition.labels import CLASSES, INDEX
from recognition.model import Predictor, fit_temperature, load_checkpoint, save_checkpoint, softmax
from recognition.tests.helpers import raw_frames
from recognition.tools.make_synthetic import REVERSED_PAIRS, generate
from recognition.train import split, train_baseline, train_model

CHANCE = 1 / len(CLASSES)


@pytest.fixture(scope="module")
def synth(tmp_path_factory):
    root = tmp_path_factory.mktemp("synthetic_train")
    generate(root, n_signers=3, n_takes=4, seed=1)
    return root, load_dataset(root, warn=False)


def test_signer_from_filename():
    assert signer_of("data/train/YES/cosme_12.json") == "cosme"
    assert signer_of("x/gislr26734_1000035562.json") == "gislr26734"
    assert signer_of("x/anne_marie_3.json") == "anne_marie"
    assert signer_of("data/train/YES/take-01.json", {"signer": "alice", "frames": []}) == "alice"
    assert signer_of("data/train/YES/bob_2.json", []) == "bob"


def test_loader_uses_signfile_signer_skips_no_pose_and_warns_on_bad_shapes(tmp_path, capsys):
    d = tmp_path / "YES"
    d.mkdir()
    rng = np.random.default_rng(0)
    for i, who in enumerate(["alice", "bob"]):
        (d / f"take-0{i}.json").write_text(json.dumps({"id": "YES", "signer": who, "frames": raw_frames(5, rng)}))
    no_pose = [{**f, "pose": None} for f in raw_frames(5, rng)]
    (d / "carol_1.json").write_text(json.dumps(no_pose))
    full_face = [{**f, "face": [[0, 0, 0]] * 468} for f in raw_frames(5, rng)]
    (d / "dave_1.json").write_text(json.dumps(full_face))
    seqs, labels, signers, paths = load_dataset(tmp_path)
    err = capsys.readouterr().err
    assert signers == ["dave", "alice", "bob"]
    assert "no pose in any frame, skipped" in err and "carol_1.json" in err
    assert "wrong number of points in face" in err


def test_temperature_never_sharpens():
    y = np.arange(len(CLASSES))
    perfect = np.eye(len(CLASSES)) * 3.0  # all right: the NLL alone would push T toward 0
    assert fit_temperature(perfect, y) == 1.0
    wrong = np.roll(np.eye(len(CLASSES)) * 20.0, 1, axis=1)  # confidently wrong: softening allowed
    assert fit_temperature(wrong, y) > 1.0


def test_checkpoint_without_kind_is_refused(tmp_path):
    from recognition.model import SignGRU
    path = tmp_path / "old.pt"
    save_checkpoint(path, SignGRU())
    ck = torch.load(path, weights_only=True)
    del ck["kind"]
    torch.save(ck, path)
    with pytest.raises(ValueError, match="kind"):
        load_checkpoint(path)


def test_time_reversed_pairs_need_frame_order(synth):
    # Each pair shares location, handshape and path and differs only in direction of time.
    _, (seqs, labels, signers, _) = synth
    tr, va, _ = split(labels, signers, val_signer="synthC")
    pair = [INDEX[c] for p in REVERSED_PAIRS for c in p]
    va_pair = va[np.isin(labels[va], pair)]
    X = torch.from_numpy(to_arrays([seqs[i] for i in va_pair]))
    Xrev = torch.from_numpy(to_arrays([{k: v[::-1].copy() for k, v in seqs[i].items()} for i in va_pair]))
    model, _, _ = train_model(seqs, labels, tr, va, epochs=25, batch_size=32, seed=0, log=lambda m: None)
    with torch.inference_mode():
        assert (model(X).numpy().argmax(1) == labels[va_pair]).mean() >= 0.75
        assert (model(Xrev).numpy().argmax(1) == labels[va_pair]).mean() <= 0.25
    b, _, _ = train_baseline(seqs, labels, tr, va)
    assert (b.logits(X.numpy()).argmax(1) == labels[va_pair]).mean() >= 0.75


def test_split_by_signer_has_no_leakage(synth):
    _, (seqs, labels, signers, _) = synth
    tr, va, how = split(labels, signers, val_signer="synthC")
    s = np.asarray(signers)
    assert how == "signer:synthC" and set(s[va]) == {"synthC"} and "synthC" not in set(s[tr])


def test_gru_learns_held_out_signer_well_above_chance(synth, tmp_path):
    _, (seqs, labels, signers, _) = synth
    tr, va, _ = split(labels, signers, val_signer="synthC")
    model, temp, info = train_model(seqs, labels, tr, va, epochs=8, batch_size=32, seed=0, log=lambda m: None)
    assert info["val_acc"] > 0.3 > 5 * CHANCE
    path = tmp_path / "model.pt"
    save_checkpoint(path, model, temp)
    pred = Predictor(path)
    top = pred.top(seqs[va[0]])
    assert len(top) == 3 and abs(sum(pred.probs(seqs[va[0]])) - 1) < 1e-5


def test_training_is_deterministic(synth):
    _, (seqs, labels, signers, _) = synth
    tr, va, _ = split(labels, signers, val_signer="synthC")
    runs = [train_model(seqs, labels, tr, va, epochs=2, batch_size=32, seed=3, log=lambda m: None)[0] for _ in range(2)]
    for a, b in zip(runs[0].state_dict().values(), runs[1].state_dict().values()):
        assert torch.equal(a, b)


def test_baseline_above_chance_and_servable(synth, tmp_path):
    _, (seqs, labels, signers, _) = synth
    tr, va, _ = split(labels, signers, val_signer="synthC")
    b, temp, info = train_baseline(seqs, labels, tr, va)
    assert info["val_acc"] > 3 * CHANCE
    path = tmp_path / "baseline.pt"
    save_checkpoint(path, b, temp)
    pred = Predictor(path)
    assert pred.ck["kind"] == "baseline"
    assert np.allclose(pred.probs(seqs[va[0]]), softmax(b.logits(to_arrays([seqs[va[0]]])), temp)[0], atol=1e-5)


def test_metrics_on_known_predictions():
    y = np.array([0, 1, 21, 21])
    probs = np.full((4, len(CLASSES)), 0.0)
    probs[0, 0] = 1.0           # right
    probs[1, 21] = 1.0          # sign -> NONE
    probs[2, 21] = 1.0          # right
    probs[3, 2] = 1.0           # NONE -> sign, accepted and wrong
    m = metrics(probs, y)
    assert m["accuracy"] == 0.5
    assert m["none_false_accept_rate"] == 0.5
    assert m["none_false_alarm_rate"] == 0.5
    assert m["coverage_at_threshold"] == 1.0
    assert m["wrong_sign_spoken_rate"] == 0.25
    assert m["ece"] == pytest.approx(0.5)
    assert np.array(m["confusion"]).sum() == 4


def test_extra_data_is_train_only(tmp_path):
    from recognition.benchmark import cross_validate
    from recognition.data import load_with_extra
    from recognition.model import load_checkpoint
    from recognition.train import main
    primary, extra = tmp_path / "team", tmp_path / "extra"
    generate(primary, n_signers=2, n_takes=2, seed=4)
    generate(extra, n_signers=1, n_takes=2, seed=5)
    for f in extra.rglob("synthA_*.json"):
        doc = json.loads(f.read_text())
        doc["signer"] = "ext"
        f.with_name(f.name.replace("synthA", "ext")).write_text(json.dumps(doc))
        f.unlink()
    seqs, labels, signers, n_primary = load_with_extra(primary, [extra])
    assert n_primary == 2 * 2 * len(CLASSES) and len(seqs) == 3 * 2 * len(CLASSES)
    assert set(signers[n_primary:]) == {"ext"}
    out = tmp_path / "m.pt"
    main(["--data", str(primary), "--extra-data", str(extra), "--epochs", "1", "--out", str(out)])
    meta = load_checkpoint(out)[1]["meta"]
    assert meta["split"] in ("signer:synthA", "signer:synthB") and meta["n_train"] == 2 * 2 * len(CLASSES)
    P, P1, info, _ = cross_validate(seqs, labels, signers, epochs=1, seed=0, n_primary=n_primary, log=lambda m: None)
    assert P["gru"].shape == P1["gru"].shape == (n_primary, len(CLASSES))
    assert [f["fold"] for f in info] == ["signer:synthA", "signer:synthB"]
    o = open_set(seqs, labels, signers, seed=0, n_primary=n_primary, log=lambda m: None)
    assert set(o["per_sign"]) == set(CLASSES) - {"NONE"} and 0 <= o["unknown_sign_spoken_rate"] <= 1
