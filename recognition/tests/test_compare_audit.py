"""Regression cases for comparison errors found in the benchmark audit."""
import pytest

from recognition.compare import common
from recognition.compare.audit import check_index, check_records


def record(clip, label='YES', pred='YES', conf=.9, **kw):
    return common.record('ours_gru', clip, 'a', label, top=[(pred, conf)], mode='R8', fold='a', **kw)


def test_confident_none_is_not_spoken_coverage():
    recs = [record('1'), record('2', pred='NONE', conf=.99), record('3', pred='NO', conf=.8),
            record('4', conf=.5)]
    metrics = common.in_vocab_metrics(recs)
    assert metrics['coverage_at_threshold'] == .5
    assert metrics['accuracy_on_accepted'] == .5
    assert metrics['wrong_sign_spoken_rate'] == .25
    full = [common.record('s', '1', 'a', 'YES', ['YES', 'NONE'], [.01, .99])]
    assert common.in_vocab_metrics(full)['coverage_at_threshold'] == 0
    assert common.in_vocab_metrics(full)['accuracy_on_accepted'] is None


def test_acceptance_does_not_round_a_weak_sign_up_to_threshold():
    r = record('1', conf=.599999)
    assert not common.accepted(r)
    r = common.record('s', '1', 'a', 'YES', ['YES', 'NO'], [.599999, .400001])
    assert not common.accepted(r)


def test_oov_custom_threshold_is_used_everywhere():
    recs = [record(str(i), label='NONE', conf=.7, oov=True, oov_sign='apple') for i in range(3)]
    summary = common.summarize(recs, threshold=.8, B=10)
    assert summary['open_set_false_accept'] == 0
    assert summary['open_set_false_accept_ci95'] == [0, 0]
    assert summary['open_set_per_sign'] == {'apple': 0}


def test_paired_comparison_rejects_duplicate_and_mislabeled_clips():
    a = record('1')
    with pytest.raises(ValueError, match='duplicate'):
        common.paired([a, a], [a], B=10)
    with pytest.raises(ValueError, match='metadata'):
        common.paired([a], [{**a, 'signer': 'another'}], B=10)


def index():
    return {'signers': ['a', 'b'], 'none_train_signs': ['cat'], 'none_test_signs': ['dog'],
            'clips': [{'clip_id': signer, 'signer': signer, 'label': 'YES', 'oov': False,
                       'gislr_sign': None} for signer in ['a', 'b']]}


def test_split_and_completeness_checks():
    idx = index()
    assert check_index(idx)['errors'] == []
    a, b = record('a'), {**record('b'), 'signer': 'b', 'fold': 'b'}
    assert check_records(idx, [a, b], 'ours_gru', 'R8')['complete']
    assert not check_records(idx, [a], 'ours_gru', 'R8')['complete']
    assert not check_records(idx, [a, a, b], 'ours_gru', 'R8')['complete']
    assert not check_records(idx, [a, {**b, 'true_label': 'NO'}], 'ours_gru', 'R8')['complete']
    idx['none_test_signs'].append('cat')
    assert check_index(idx)['errors']


def test_non_normalized_rejection_scores_do_not_get_ece():
    r = common.record('reference', '1', 'a', 'YES', ['YES', 'NONE'], [.7, .1])
    assert common.in_vocab_metrics([r])['ece'] is None


def test_report_omits_partial_system_instead_of_comparing_different_clips():
    from recognition.compare.report import complete_groups

    a, b = record('a'), {**record('b'), 'signer': 'b', 'fold': 'b'}
    partial = {**a, 'system': 'ours_baseline'}
    groups, excluded = complete_groups(index(), [a, b, partial])
    assert ('ours_gru', 'R8') in groups
    assert ('ours_baseline', 'R8') not in groups
    assert excluded == {'ours_baseline/R8': ['1 expected clips missing']}


# ---------- protocol: manifests, equal exposure, refusal ----------

import json  # noqa: E402
from pathlib import Path  # noqa: E402

import numpy as np  # noqa: E402

from recognition.compare import manifest, report  # noqa: E402
from recognition.compare.track_a_gislr import (INDEX_SHA256, LEGACY_OUT, fold_sets, inner_split,  # noqa: E402
                                               pretrained_vectors)

PROTO = 'test-protocol-sha'


def toy_index():
    """3 signers; each has one YES clip, one NONE_TRAIN clip (cat) and one NONE_TEST clip (dog)."""
    clips = []
    for s in ('1', '2', '3'):
        clips += [{'clip_id': f'{s}_y', 'signer': s, 'label': 'YES', 'oov': False, 'gislr_sign': None},
                  {'clip_id': f'{s}_c', 'signer': s, 'label': 'NONE', 'oov': True, 'gislr_sign': 'cat'},
                  {'clip_id': f'{s}_d', 'signer': s, 'label': 'NONE', 'oov': True, 'gislr_sign': 'dog'}]
    return {'signers': ['1', '2', '3'], 'none_train_signs': ['cat'], 'none_test_signs': ['dog'], 'clips': clips}


def toy_preds(run, idx, system, fold):
    files = []
    for mode in ('C7', 'R8'):
        labels = ['YES', 'NO'] if mode == 'C7' else ['YES', 'NONE']
        recs = [common.record(system, c['clip_id'], c['signer'], c['label'], labels, [.7, .3], mode=mode,
                              fold=fold, oov=c['oov'], oov_sign=c['gislr_sign'])
                for c in idx['clips'] if c['signer'] == fold and (not c['oov'] or c['gislr_sign'] == 'dog')]
        path = Path(run) / 'preds' / f'{system}_{mode}_{fold}.jsonl'
        common.write_jsonl(path, recs)
        files.append(path)
    return files


def toy_manifest(run, idx, system, fold, files, **over):
    tr, te, oov = fold_sets(idx, fold)
    inner_val = sorted({c['signer'] for c in tr}, key=int)[:1]
    m = {'schema': manifest.SCHEMA, 'smoke': False, 'protocol_sha256': PROTO, 'system': system, 'fold': fold,
         'index_sha256': manifest.index_fingerprint(idx), 'data': manifest.fold_data(tr, te, oov),
         'inner': {'val_signers': inner_val, 'train_signers': [s for s in idx['signers'] if s not in inner_val + [fold]]},
         'tuning': {'rule': 'inner_val_loss_patience_12', 'epochs_max': 60},
         'code_sha256': {f: 'same' for f in manifest.TRAINING_CODE},
         'outputs': {f'preds/{Path(f).name}': manifest.sha256_file(f) for f in files}}
    m.update(over)
    manifest.write(manifest.manifest_path(run, system, fold), m)
    return m


def test_manifest_accepts_a_protocol_job_and_rejects_tampering(tmp_path):
    idx = toy_index()
    files = toy_preds(tmp_path, idx, 'ours_gru', '1')
    check = lambda: manifest.check(idx, 'ours_gru', '1', tmp_path, fold_sets, files, PROTO)
    assert check() == [f'ours_gru/1: no manifest (results produced outside the protocol)']
    toy_manifest(tmp_path, idx, 'ours_gru', '1', files)
    assert check() == []
    files[0].write_text(files[0].read_text().replace('0.7', '0.69'))
    assert any('changed after the manifest' in e for e in check())
    files = toy_preds(tmp_path, idx, 'ours_gru', '1')
    toy_manifest(tmp_path, idx, 'ours_gru', '1', files, smoke=True)
    assert any('smoke' in e for e in check())
    toy_manifest(tmp_path, idx, 'ours_gru', '1', files, protocol_sha256='other')
    assert any('different PROTOCOL.md' in e for e in check())


def test_manifest_catches_unequal_exposure_and_test_signer_leaks(tmp_path):
    idx = toy_index()
    files = toy_preds(tmp_path, idx, 'islr1st_retrained', '1')
    tr, te, oov = fold_sets(idx, '1')
    leaked = manifest.fold_data(tr + oov, te, [])            # NONE_TEST clips used for training
    toy_manifest(tmp_path, idx, 'islr1st_retrained', '1', files, data=leaked)
    errs = manifest.check(idx, 'islr1st_retrained', '1', tmp_path, fold_sets, files, PROTO)
    assert any('TEST signs in training' in e for e in errs) and any('train_clips_sha256' in e for e in errs)
    toy_manifest(tmp_path, idx, 'islr1st_retrained', '1', files, inner={'val_signers': ['1'], 'train_signers': ['2']})
    errs = manifest.check(idx, 'islr1st_retrained', '1', tmp_path, fold_sets, files, PROTO)
    assert any('outer test signer' in e for e in errs)
    toy_manifest(tmp_path, idx, 'islr1st_retrained', '1', files, tuning={'rule': 'fixed', 'epochs_max': 60})
    errs = manifest.check(idx, 'islr1st_retrained', '1', tmp_path, fold_sets, files, PROTO)
    assert any('nested rule' in e for e in errs)


def test_report_refuses_results_without_a_matching_manifest(tmp_path):
    idx = toy_index()
    (tmp_path / 'index.json').write_text(json.dumps(idx))
    files = {f: toy_preds(tmp_path, idx, 'ours_gru', f) for f in idx['signers']}
    recs = common.read_jsonl(sorted((tmp_path / 'preds').glob('*.jsonl')))
    groups, _ = report.complete_groups(idx, recs)
    assert ('ours_gru', 'C7') in groups
    accepted, refused, _ = report.manifest_gate(idx, tmp_path, groups, fold_sets, PROTO)
    assert not accepted and 'no manifest' in refused['ours_gru'][0]
    for f, fs in files.items():
        toy_manifest(tmp_path, idx, 'ours_gru', f, fs)
    accepted, refused, used = report.manifest_gate(idx, tmp_path, groups, fold_sets, PROTO)
    assert ('ours_gru', 'R8') in accepted and not refused and len(used) == 3
    toy_manifest(tmp_path, idx, 'ours_gru', '2', files['2'], code_sha256={f: 'other' for f in manifest.TRAINING_CODE})
    accepted, refused, _ = report.manifest_gate(idx, tmp_path, groups, fold_sets, PROTO)
    assert not accepted and any('different training code' in e for e in refused['ours_gru'])


def test_inner_split_uses_only_training_signers():
    idx = toy_index()
    for fold in idx['signers']:
        tr, _, _ = fold_sets(idx, fold)
        itr, iva, how = inner_split(tr)
        val = {tr[i]['signer'] for i in iva}
        assert len(val) == 1 and fold not in val and how == f'signer:{next(iter(val))}'
        assert not val & {tr[i]['signer'] for i in itr}
        assert not {tr[i]['gislr_sign'] for i in range(len(tr))} & set(idx['none_test_signs'])


def test_pretrained_sum_rule_is_a_probability_and_max_other_is_not():
    raw = {'p7_closed': [.5, .5, 0, 0, 0, 0, 0], 'p8_reject': [.2, .1, 0, 0, 0, 0, 0, .3], 'p_none_sum': .7}
    c7, r8_sum, r8_max = pretrained_vectors(raw)
    assert np.isclose(r8_sum.sum(), 1) and np.isclose(r8_sum[-1], .7) and r8_sum.argmax() == 7
    assert r8_max.argmax() == 7 and not np.isclose(r8_max.sum(), 1)
    assert np.isclose(c7.sum(), 1)


def test_pretrained_reference_has_no_open_set_number():
    recs = [record('1'), record('2', label='NONE', oov=True, oov_sign='dog')]
    s = common.summarize([r for r in recs if not r['oov']], B=10)
    row = report.comparison_rows({'islr1st_pretrained': s}, 'x', held_out={})[0]
    assert 'excluded' in row[7]


def test_retrained_recipe_early_stops_on_inner_validation():
    from recognition.compare import islr1st
    rng = np.random.default_rng(0)
    X = [rng.uniform(0.3, 0.7, (12, 543, 3)).astype(np.float32) for _ in range(8)]
    y = np.array([0, 1] * 4)
    model, info = islr1st.train_own_recipe(X[:6], y[:6], 2, 3, val=(X[6:], y[6:]), patience=1, log=lambda m: None)
    assert 1 <= info['best_epoch'] <= info['epochs_run'] <= 3 and len(info['val_curve']) == info['epochs_run']
    assert not model.training
    _, refit = islr1st.train_own_recipe(X, y, 2, info['best_epoch'], log=lambda m: None)
    assert refit['epochs_run'] == info['best_epoch'] and refit['val_curve'] == []


@pytest.mark.skipif(not (LEGACY_OUT / 'index.json').exists(), reason='GISLR data not present')
def test_saved_clip_index_matches_the_preregistered_fingerprint():
    idx = json.loads((LEGACY_OUT / 'index.json').read_text())
    assert manifest.index_fingerprint(idx) == INDEX_SHA256
    for fold in idx['signers']:
        tr, te, oov = fold_sets(idx, fold)
        assert not {c['gislr_sign'] for c in tr if c['oov']} & set(idx['none_test_signs'])
        assert fold not in {c['signer'] for c in tr}


# ---------- Track B: capture-parity path ----------

W, H = 640, 480


def holistic_take(n=24, seed=0):
    """Tasks-Holistic-shaped results; the hands are missing in the first and last 3 frames."""
    from recognition.tests.helpers import raw_frames
    from recognition.tests.test_mediapipe_adapter import tasks_holistic
    rng = np.random.default_rng(seed)
    out = []
    for i, f in enumerate(raw_frames(n, rng)):
        if i < 3 or i >= n - 3:
            f['lh'] = f['rh'] = None
        out.append(tasks_holistic(f, face=rng.uniform(0.3, 0.7, (478, 3))))
    return out


def test_track_b_frames_match_what_capture_py_makes_from_the_same_results():
    mp = pytest.importorskip('mediapipe')  # noqa: F841  (capture.landmarks imports it)
    from recognition import mediapipe_adapter as mpa
    from recognition.compare.tb_extract import convert
    from recognition.compare.track_b_video import prepare
    results = holistic_take()
    fps = 30.0
    doc = json.loads(json.dumps(convert(results, (W, H), fps)))         # through JSON, as on disk
    got, outcome = prepare(doc, gate=False, how='take')                 # whole-clip take path (sensitivity)
    lm, clean = mpa.capture_modules()
    want = clean.clean([lm.normalize(lm.to_frame(r, W / H)) for r in results], [i * 1000 / fps for i in range(len(results))])
    assert outcome == 'ok' and len(got) == len(want) == 18
    for g, w in zip(got, want):
        assert g['lh'] == w['lh'] and g['rh'] == w['rh']
        assert [g['pose'][i] for i in [0] + list(range(11, 33))] == [w['pose'][i] for i in [0] + list(range(11, 33))]
        assert g['face'] is None and all(p == g['pose'][0] for p in g['pose'][1:11])   # minimised as live


def test_track_b_framing_gate_and_no_hands_follow_the_live_rules():
    from recognition.compare.track_b_video import prepare
    from recognition.compare.tb_extract import PIPELINE
    frame = {'pose': [[0, 0, 0]] * 33, 'lh': [[0, 0, 0]] * 21, 'rh': None, 'face': None}
    doc = {'pipeline': PIPELINE, 'stage': 'uncleaned', 'frames': [None, frame, frame, frame, frame, frame, None],
           't_ms': [i * 1000 / 30 for i in range(7)],
           'framing': {'hips': ['NO_PERSON'] + ['OK'] * 4 + ['STEP_BACK', 'NO_PERSON'], 'none': ['OK'] * 7}}
    frames, outcome = prepare(doc, how='take')
    assert outcome == 'ok' and len(frames) == 5                    # 4 of 5 hand frames OK = 0.8: classified
    doc['framing']['hips'][2] = 'STEP_BACK'
    assert prepare(doc, how='take') == (None, 'framing_rejected:STEP_BACK')
    assert prepare(doc, waist='none', how='take')[1] == 'ok'
    assert prepare(doc, gate=False, how='take')[1] == 'ok'
    doc['frames'] = [None] * 7
    assert prepare(doc) == (None, 'no_hands')
    with pytest.raises(ValueError):
        prepare({**doc, 'pipeline': None})


def test_track_b_run_ours_records_live_outcomes_and_a_manifest(tmp_path, monkeypatch):
    from recognition import recognizer
    from recognition.compare import track_b_video as tbv
    from recognition.compare.tb_extract import PIPELINE

    class Spy:
        def __init__(self, checkpoint, **kw):
            self.got = []

        def predict(self, frames):
            return [{'label': 'YES', 'conf': .9}, {'label': 'NO', 'conf': .05}, {'label': 'NAME', 'conf': .02}]
    monkeypatch.setattr(recognizer, 'Recognizer', Spy)
    monkeypatch.setattr(tbv, 'OUT', tmp_path / 'out')
    monkeypatch.setattr(report, 'REPORTS', tmp_path / 'reports')
    frame = {'pose': [[0, 0, 0]] * 33, 'lh': [[0, 0, 0]] * 21, 'rh': None, 'face': None}
    for name, statuses in (('s1_0', ['OK'] * 3), ('s1_1', ['STEP_BACK'] * 3)):
        (tmp_path / 'clips/YES').mkdir(parents=True, exist_ok=True)
        (tmp_path / 'clips/YES' / f'{name}.mp4').write_bytes(b'')
        lm = tmp_path / 'out/landmarks/YES' / f'{name}.json'
        lm.parent.mkdir(parents=True, exist_ok=True)
        lm.write_text(json.dumps({'pipeline': PIPELINE, 'stage': 'uncleaned', 'frames': [frame] * 3,
                                  't_ms': [0, 33.3, 66.7], 'framing': {'hips': statuses, 'none': statuses}}))
    ck = tmp_path / 'model.pt'
    ck.write_bytes(b'weights')
    tbv.run_ours(tmp_path / 'clips', ck, 'ours_gru', how='take')
    recs = common.read_jsonl([tmp_path / 'out/preds/ours_gru.jsonl'])
    assert [(r['top3'][0]['label'], r['top3'][0]['conf'], r['live_outcome'].split(':')[0]) for r in recs] == \
        [('YES', .9, 'ok'), ('NONE', 0.0, 'framing_rejected')]
    m = json.loads((tmp_path / 'out/preds/ours_gru.manifest.json').read_text())
    assert m['pipeline'] == 'capture-parity-v1' and m['checkpoint']['sha256'] == manifest.sha256_file(ck)
    from recognition import model_pin
    monkeypatch.setattr(model_pin, 'EXPECTED_SHA256', manifest.sha256_file(ck))
    report.track_b(tmp_path / 'out/preds', 'unit', B=10)          # unpinned checkpoint: refused
    assert 'not pinned' in json.loads((tmp_path / 'reports/track_b_unit.json').read_text())['refused']['ours_gru']
    tbv.run_ours(tmp_path / 'clips', ck, 'ours_gru', how='take')   # same checkpoint, now pinned
    report.track_b(tmp_path / 'out/preds', 'unit', B=10)
    assert json.loads((tmp_path / 'reports/track_b_unit.json').read_text())['refused'] == {}
    p = tmp_path / 'out/preds/ours_gru.jsonl'
    p.write_text(p.read_text().replace('0.9', '0.95'))
    report.track_b(tmp_path / 'out/preds', 'unit', B=10)
    assert 'ours_gru' in json.loads((tmp_path / 'reports/track_b_unit.json').read_text())['refused']


def test_manifest_refuses_training_code_changed_during_a_job(tmp_path):
    # Added 2026-10-10 after recognition/labels.py was edited in the middle of the first protocol run.
    idx = toy_index()
    files = toy_preds(tmp_path, idx, 'ours_gru', '1')
    check = lambda: manifest.check(idx, 'ours_gru', '1', tmp_path, fold_sets, files, PROTO)
    toy_manifest(tmp_path, idx, 'ours_gru', '1', files, code_sha256_end={f: 'same' for f in manifest.TRAINING_CODE})
    assert check() == []
    end = {f: 'same' for f in manifest.TRAINING_CODE} | {'recognition/labels.py': 'edited'}
    toy_manifest(tmp_path, idx, 'ours_gru', '1', files, code_sha256_end=end)
    assert any('changed while the job was running' in e for e in check())


# ---------- Track B: the replay is the live stream (audit 2026-10-11, AMENDMENTS.md item 16) ----------

def _live_vs_replay(seq, **kw):
    """The same raw MediaPipe results through the REAL SignStream.push/flush and through tb_extract.convert ->
    JSON on disk -> track_b_video.replay_stream. Returns (frames live classified, replay segments, live events)."""
    pytest.importorskip('mediapipe')
    from recognition.compare.tb_extract import convert
    from recognition.compare.track_b_video import replay_stream
    from recognition.tests import test_stream as ts
    spy = ts.Spy()
    _, events = ts.run_live(seq, [i / 30 for i in range(len(seq))], spy, **kw)
    doc = json.loads(json.dumps(convert(seq, (ts.W, ts.H), 30.0)))
    segs = replay_stream(doc, gate=kw.get('gate', True), waist=kw.get('waist', 'hips'))
    return json.loads(json.dumps(spy.got)), segs, events, doc


def test_track_b_stream_replay_gives_the_frames_the_live_stream_classifies():
    from recognition.compare.track_b_video import prepare
    from recognition.tests import test_stream as ts
    rng = np.random.default_rng(11)
    for seq in (ts.motion(75, False, rng),                                   # hands come up from below
                ts.motion(10, True, rng, sign_at=99) + ts.motion(60, True, rng) + ts.motion(45, True, rng, sign_at=99)):
        live, segs, _, doc = _live_vs_replay(seq)
        assert len(live) == 1 and [s_['frames'] for s_ in segs] == live      # identical frames, value for value
        frames, outcome = prepare(doc)
        assert outcome == 'ok' and frames == live[0]


def test_track_b_stream_replay_reports_splits_and_framing_rejections_like_live():
    from recognition import framing
    from recognition.compare.track_b_video import prepare
    from recognition.tests import test_stream as ts
    rng = np.random.default_rng(4)
    two = ts.motion(40, True, rng, sign_at=5, sign_len=20) + ts.motion(60, True, rng, sign_at=5, sign_len=20)
    live, segs, _, doc = _live_vs_replay(two)
    assert len(live) == 2 and [s_['frames'] for s_ in segs] == live
    frames, outcome = prepare(doc)
    assert outcome == 'split:2' and frames == max(live, key=len)
    rng = np.random.default_rng(9)
    bad = ts.motion(20, False, rng, sign_at=99) + ts.motion(110, False, rng, sign_at=5)
    for r in bad:                                    # hips below the picture: the live gate rejects the sign
        for i in (23, 24):
            r.pose_landmarks[i].y = 0.99
    live, segs, events, doc = _live_vs_replay(bad)
    rejected = [e['status'] for e in events if e['type'] == 'framing' and 'rejected_seq' in e]
    assert live == [] and segs == [{'rejected': s_} for s_ in rejected] == [{'rejected': framing.MOVE_CAMERA_DOWN}]
    assert prepare(doc) == (None, f'framing_rejected:{framing.MOVE_CAMERA_DOWN}')
    live, segs, _, doc = _live_vs_replay(bad, waist='none')
    assert len(live) == 1 and [s_['frames'] for s_ in segs] == live


def test_track_b_refuses_precleaned_files_outside_smoke(tmp_path, monkeypatch):
    from recognition import recognizer
    from recognition.compare import track_b_video as tbv
    from recognition.compare.track_b_video import prepare
    frame = {'pose': [[0, 0, 0]] * 33, 'lh': [[0, 0, 0]] * 21, 'rh': None, 'face': None}
    with pytest.raises(ValueError, match='pre-cleaned'):
        prepare({'stage': 'cleaned', 'frames': [frame]})
    with pytest.raises(ValueError, match='pre-cleaned'):
        prepare([frame])
    assert prepare([frame], allow_precleaned=True) == ([frame], 'precleaned')

    class Spy:
        def __init__(self, checkpoint, **kw):
            pass

        def predict(self, frames):
            return [{'label': 'YES', 'conf': .9}]
    monkeypatch.setattr(recognizer, 'Recognizer', Spy)
    monkeypatch.setattr(tbv, 'OUT', tmp_path / 'out')
    monkeypatch.setattr(report, 'REPORTS', tmp_path / 'reports')
    (tmp_path / 'clips/YES').mkdir(parents=True)
    (tmp_path / 'clips/YES/s1_0.mp4').write_bytes(b'')
    lm = tmp_path / 'out/landmarks/YES/s1_0.json'
    lm.parent.mkdir(parents=True)
    lm.write_text(json.dumps({'pipeline': 'precleaned', 'stage': 'cleaned', 'frames': [frame] * 3}))
    ck = tmp_path / 'model.pt'
    ck.write_bytes(b'weights')
    from recognition import model_pin
    monkeypatch.setattr(model_pin, 'EXPECTED_SHA256', manifest.sha256_file(ck))
    with pytest.raises(ValueError, match='pre-cleaned'):
        tbv.run_ours(tmp_path / 'clips', ck, 'ours_gru')
    tbv.run_ours(tmp_path / 'clips', ck, 'ours_gru', allow_precleaned=True)     # smoke-style run
    report.track_b(tmp_path / 'out/preds', 'team', B=10)
    assert 'pre-cleaned' in json.loads((tmp_path / 'reports/track_b_team.json').read_text())['refused']['ours_gru']
    report.track_b(tmp_path / 'out/preds', 'smoke', B=10)
    assert json.loads((tmp_path / 'reports/track_b_smoke.json').read_text())['refused'] == {}


# ---------- Track A report: post-audit labels and sensitivity analyses (AMENDMENTS.md items 10-15) ----------

def _paired_toy(diffs):
    """Two systems on the same clips; signer k has 10 clips and system A is right on diffs[k] more of them."""
    a, b = [], []
    for k, d in enumerate(diffs):
        for i in range(10):
            ra = record(f'{k}_{i}', pred='YES' if i < 5 + d else 'NO')
            rb = record(f'{k}_{i}', pred='YES' if i < 5 else 'NO')
            ra['signer'] = rb['signer'] = str(k)
            a.append(ra)
            b.append({**rb, 'system': 'islr1st_retrained'})
    return a, b


def test_signer_sensitivity_matches_hand_computation():
    a, b = _paired_toy([1, -1, 2, 0, 1, 0, -2, 1, 1, 0])
    s = report.signer_sensitivity(a, b)
    d = np.array([1, -1, 2, 0, 1, 0, -2, 1, 1, 0]) / 10
    assert s['n_signers'] == 10 and s['pooled_diff'] == round(d.mean(), 4) == s['unweighted_signer_mean']
    half = 2.262 * d.std(ddof=1) / np.sqrt(10)
    assert s['unweighted_signer_mean_t95'] == [round(d.mean() - half, 4), round(d.mean() + half, 4)]
    assert s['cluster_robust_t95'][0] < s['pooled_diff'] < s['cluster_robust_t95'][1]
    # exact sign-flip p by brute force
    import itertools
    sums = d * 10
    p = np.mean([abs(np.dot(sums, sg)) >= abs(sums.sum()) - 1e-9 for sg in itertools.product([-1, 1], repeat=10)])
    assert s['sign_flip_exact_p'] == round(float(p), 4)


def test_robust_verdict_flags_a_bootstrap_only_non_inferiority():
    sens = {'unweighted_signer_mean_t95': [-0.078, 0.045], 'cluster_robust_t95': [-0.043, 0.030]}
    text, cats = report.robust_verdict([-0.039, 0.022], sens)
    assert text.startswith('not worse by more than 5 points under the pre-registered pooled bootstrap only')
    assert cats['per-signer t (unweighted)'] == 'inconclusive'
    text, _ = report.robust_verdict([-0.03, 0.02], {'unweighted_signer_mean_t95': [-0.04, 0.03],
                                                    'cluster_robust_t95': [-0.04, 0.03]})
    assert text.startswith('same verdict under all three intervals')


def test_product_axis_has_cis_and_paired_differences():
    a, b = _paired_toy([1, 0, 1, 0])
    oa = [record(f'o{k}', label='NONE', pred='YES', conf=.9 if k % 2 else .3, oov=True, oov_sign='dog') for k in range(4)]
    for k, r in enumerate(oa):
        r['signer'] = str(k)
    ob = [{**r, 'system': 'islr1st_retrained', 'top3': [{'label': 'NONE', 'conf': .9}]} for r in oa]
    g = {('ours_gru', 'R8'): a + oa, ('islr1st_retrained', 'R8'): b + ob}
    out = report.product_axis(g, ['ours_gru', 'islr1st_retrained'], B=50)
    assert out['ours_gru']['R8_open_set_false_accept']['value'] == .5
    assert out['islr1st_retrained']['R8_open_set_false_accept']['value'] == 0
    assert out['paired']['R8_open_set_false_accept']['diff'] == .5
    ws = out['ours_gru']['R8_wrong_sign_spoken']
    assert ws['ci95'] is not None and ws['n_signers'] == 4 and ws['n_clips'] == 40
    assert 'R8_wrong_sign_spoken' in out['paired']


def test_epoch_cap_runner_changes_only_the_cap(tmp_path):
    from recognition.compare import epoch_cap
    idx = toy_index()
    assert epoch_cap.CAP == 200 and epoch_cap.OUT != epoch_cap.PROTOCOL_RUN
    assert not set(manifest.TRAINING_CODE) & {'recognition/compare/epoch_cap.py', 'recognition/compare/report.py'}
    # a sensitivity manifest must carry cap 200 under the nested rule; every other protocol check still applies
    errs = epoch_cap.check(idx, 'ours_gru', 'a', tmp_path)
    assert errs and 'missing' in errs[0]


def test_clearance_withholds_the_primary_until_the_epoch_cap_run_and_never_clears_the_verdict(tmp_path):
    from recognition.compare import audit
    v = {'value': .1, 'ci95': [.05, .15], 'n_clips': 225, 'n_signers': 10}
    t = {'modes': {}, 'primary': {'diff': .006, 'ci95': [-.029, .048], 'n_signers': 10, 'n_clips': 1105,
                                  'verdict': 'ours_gru not worse by more than 0.05', 'robust_verdict': 'x',
                                  'ci_sensitivity': {'unweighted_signer_mean_t95': [-.066, .067], 'sign_flip_exact_p': .78},
                                  'product_axis_R8': {s: {'R8_wrong_sign_spoken': v, 'R8_open_set_false_accept': v}
                                                      for s in ('ours_gru', 'islr1st_retrained')}},
         'epoch_cap_sensitivity': {}}
    (tmp_path / 'track_a_v1.json').write_text(json.dumps(t))
    cleared, nc, pending = audit.clearance(tmp_path)
    assert not any('Primary' in c for c in cleared) and any('epoch-cap' in p for p in pending)
    t['epoch_cap_sensitivity']['ours_gru (60) minus islr1st_retrained (200)'] = {'diff': .014, 'ci95': [-.022, .055]}
    (tmp_path / 'track_a_v1.json').write_text(json.dumps(t))
    cleared, nc, pending = audit.clearance(tmp_path)
    prim = [c for c in cleared if c.startswith('[Primary')]
    assert len(prim) == 1 and 'DESCRIPTIVE ONLY' in prim[0] and 'margin not yet confirmed by Talha' in prim[0]
    assert 'after exploratory results' in prim[0] and 'wrong sign' in prim[0]
    assert nc[0].startswith('The non-inferiority VERDICT') and 'not cleared until Talha confirms' in nc[0]
    assert not any(c.startswith('[Integrity') for c in cleared)       # no independent re-check given
