"""Audit saved Track A evidence without training models or approving product accuracy.

Run: python -m recognition.compare.audit
The audit checks saved predictions and split membership; it cannot reconstruct absent
training provenance or establish human identity from dataset IDs alone.
"""
import json
import hashlib
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from recognition.compare import common
from recognition.compare.track_a_gislr import (ROOT, LEGACY_OUT as OUT, OUT as PROTOCOL_OUT, TRAINED, SYSTEMS, MODES,
                                               PRIVATE6, fold_sets, pretrained_vectors)


def check_index(idx):
    errors = []
    clips = idx['clips']
    ids = [c['clip_id'] for c in clips]
    if len(ids) != len(set(ids)):
        errors.append('Duplicate clip IDs in index')
    if set(idx['none_train_signs']) & set(idx['none_test_signs']):
        errors.append('NONE training and test vocabularies overlap')
    if set(idx['signers']) != {c['signer'] for c in clips}:
        errors.append('Signer list does not match indexed clips')
    folds = {}
    for signer in idx['signers']:
        tr, te, oov = fold_sets(idx, signer)
        train_ids = {c['clip_id'] for c in tr}
        if any(c['signer'] == signer for c in tr):
            errors.append(f'Test signer {signer} occurs in training')
        if train_ids & {c['clip_id'] for c in te + oov}:
            errors.append(f'Train/test clip overlap in fold {signer}')
        if not te or not tr:
            errors.append(f'Empty training or sign test set in fold {signer}')
        folds[signer] = {'train': len(tr), 'test_signs': len(te), 'test_oov': len(oov)}
    return {'errors': errors, 'folds': folds, 'clips': len(clips),
            'in_vocabulary': sum(not c['oov'] for c in clips),
            'all_oov': sum(c['oov'] for c in clips)}


def check_records(idx, records, system, mode):
    wanted = {c['clip_id']: c for c in idx['clips']
              if not c['oov'] or c['gislr_sign'] in idx['none_test_signs']}
    errors = []
    counts = Counter(r['clip_id'] for r in records)
    missing = sorted(set(wanted) - set(counts))
    extra = sorted(set(counts) - set(wanted))
    duplicates = sorted(c for c, n in counts.items() if n > 1)
    if missing:
        errors.append(f'{len(missing)} expected clips missing')
    if extra:
        errors.append(f'{len(extra)} unexpected clips')
    if duplicates:
        errors.append(f'{len(duplicates)} duplicate clips')
    for r in records:
        c = wanted.get(r['clip_id'])
        if c is None:
            continue
        expected = {'system': system, 'mode': mode, 'signer': c['signer'],
                    'true_label': c['label'], 'oov': c['oov'], 'oov_sign': c['gislr_sign']}
        if system in TRAINED:
            expected['fold'] = c['signer']
        for key, value in expected.items():
            if r.get(key) != value:
                errors.append(f"{r['clip_id']}: incorrect {key}")
        if not r.get('answered') or not r.get('top3'):
            errors.append(f"{r['clip_id']}: missing model answer")
        if any(t['label'] not in MODES[mode] for t in r.get('top3', [])):
            errors.append(f"{r['clip_id']}: unexpected prediction label")
    return {'complete': not errors, 'rows': len(records), 'expected_rows': len(wanted),
            'missing': missing, 'duplicates': duplicates, 'extra': extra, 'errors': errors}


def inspect_run():
    idx = json.loads((OUT / 'index.json').read_text())
    result = {'created': datetime.now(timezone.utc).isoformat(timespec='seconds'),
              'release_approved': False, 'index': check_index(idx), 'systems': {}}
    for system in SYSTEMS:
        result['systems'][system] = {}
        for mode in MODES:
            paths = sorted((OUT / 'preds').glob(f'{system}_{mode}_*.jsonl'))
            records = common.read_jsonl(paths)
            checked = check_records(idx, records, system, mode)
            checked['artifact_sha256'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
            if checked['complete']:
                inv = [r for r in records if not r['oov']]
                oov = [r for r in records if r['oov']]
                checked['corrected_metrics'] = common.in_vocab_metrics(inv)
                checked['oov_false_accept'] = common.false_accept_rate(oov)
                checked['near_acceptance_boundary'] = sum(abs(common.conf_of(r) - .6) <= .00001 for r in records)
            result['systems'][system][mode] = checked
    # Independently compare each indexed label with the source label table.
    import pandas as pd
    labels = pd.read_parquet(ROOT / 'data/gislr_raw/labels.parqet')
    truth = dict(zip(labels['path'], labels['sign']))
    mapping = {'YES': 'yes', 'NO': 'no', 'THANK-YOU': 'thankyou', 'WHERE': 'where',
               'TIME': 'time', 'PLEASE': 'please', 'ROOM': 'room'}
    mismatches = []
    missing_files = []
    for c in idx['clips']:
        source_path = str(Path(c['raw']).relative_to('data/gislr_raw'))
        want = c['gislr_sign'] if c['oov'] else mapping[c['label']]
        if truth.get(source_path) != want:
            mismatches.append(c['clip_id'])
        if not (ROOT / c['raw']).is_file() or not (ROOT / c['json']).is_file():
            missing_files.append(c['clip_id'])
    result['source_labels'] = {'mismatches': mismatches, 'missing_files': missing_files,
        'sha256': hashlib.sha256((ROOT / 'data/gislr_raw/labels.parqet').read_bytes()).hexdigest()}
    result['pretrained_exploratory'] = pretrained_exploratory(idx)
    result['protocol_run'] = protocol_run_status()
    result['release_blockers'] = [
        'Pretrained reference provenance: SEPARATE by participant ID (none of its 21 training IDs is one of the 10 test IDs); that IDs are different people is UNVERIFIED; 4 test signers (public leaderboard) influenced the winner\'s model selection. It may only appear as a separately labelled reference, never as a matched comparison.',
        'Pretrained OOV rejection is not a matched unseen-vocabulary test: all 30 outside signs belong to its original 250-label training vocabulary. PROTOCOL.md excludes it from every OOV comparison.',
        'Both pretrained R8 rejection rules were fixed after alternatives had been examined (max-other after comparing results; the sum rule afterwards, with p_none_sum already stored). No pretrained R8 figure is cleared (AMENDMENTS.md item 15).',
        'Legacy islr1st_retrained used a fixed 60 epochs informed by a global pilot whose validation signer (48118) is an outer test fold. PROTOCOL.md replaces it with nested per-fold early stopping; the legacy run must not be reported.',
        'Track A omits the live segmenter and framing gate and covers only seven hotel-vocabulary signs, not the 22-class product.',
        'Track B has no real held-out hotel-sign recordings. Our rows now replay recognition.stream (segmenter, extent, framing gate, clean) on the capture-parity landmarks, checked against SignStream.push/flush on the same MediaPipe results (synthetic results; no real video exists), and pre-cleaned files are refused; no Track B result exists until recordings are made.',
        'PROTOCOL.md (endpoint and -0.05 margin) was written after the legacy exploratory results on the same clips were seen, so Track A v1 is not a blind pre-registration (AMENDMENTS.md item 10). Talha has not confirmed the margin.',
        'The protocol caps every network at 60 epochs; the winner trained for 300. The 200-epoch-cap sensitivity analysis (AMENDMENTS.md item 11) is done and printed next to the primary; the winner\'s fixed 300-epoch setting without early stopping, its AWP and its seeds remain untested.',
        'With 10 signers the confidence-interval method can decide the non-inferiority verdict; per-signer t and cluster-robust t intervals and an exact sign-flip test are printed next to the registered bootstrap (AMENDMENTS.md item 12).',
        'The legacy runs did not store per-job manifests; the protocol report refuses them. The protocol re-run (data/compare/track_a_v1, 41 manifests) replaces them; only its figures, as worded in the cleared sentences, may be used.',
    ]
    if any(not c['complete'] for modes in result['systems'].values() for c in modes.values()):
        result['release_blockers'].insert(0, 'Some prediction sets are incomplete or inconsistent; compare only complete systems on identical clips.')
    return result


def pretrained_exploratory(idx):
    """Exploratory (not pre-registered) re-reading of the saved legacy TFLite outputs: C7 and both R8
    rules on all 10 signers and on the 6 private-leaderboard signers. In-vocabulary clips only."""
    raw_path = OUT / 'ext_islr1st_pretrained_raw.jsonl'
    if not raw_path.exists():
        return None
    raw = {json.loads(l)['clip_id']: json.loads(l) for l in open(raw_path)}
    res = {'raw_sha256': hashlib.sha256(raw_path.read_bytes()).hexdigest(), 'note':
           'exploratory; in-vocabulary clips only; the pretrained model is excluded from OOV comparisons'}
    for subset, keep in (('all10', None), ('private6', set(PRIVATE6))):
        clips = [c for c in idx['clips'] if not c['oov'] and (keep is None or c['signer'] in keep)]
        for rule in ('C7', 'R8_sum', 'R8_maxother'):
            labels = MODES['C7'] if rule == 'C7' else MODES['R8']
            recs = []
            for c in clips:
                c7, r8s, r8m = pretrained_vectors(raw[c['clip_id']])
                p = {'C7': c7, 'R8_sum': r8s, 'R8_maxother': r8m}[rule]
                recs.append(common.record('islr1st_pretrained', c['clip_id'], c['signer'], c['label'], labels, p))
            res[f'{subset}/{rule}'] = {'n_signers': len({r['signer'] for r in recs}), 'n_clips': len(recs),
                                       'top1': round(common.STATS['top1'](recs), 4),
                                       'top1_ci95': common.boot_ci(recs, 'top1')}
    return res


def protocol_run_status():
    pre = PROTOCOL_OUT / 'preds'
    found = sorted(p.name for p in pre.glob('*.manifest.json')) if pre.exists() else []
    return {'run_dir': str(PROTOCOL_OUT.relative_to(ROOT)), 'manifests': len(found),
            'expected_manifests': 4 * 10 + 1}


# ---------- post-audit clearance (2026-10-11) ----------

SCOPE_A = ('our training recipe retrained per fold on 9 GISLR participants; NOT the shipped model, NOT the live pipeline, '
           'NOT our 22-sign hotel vocabulary')
FINDING_OUTCOMES = [
    ('PROTOCOL.md written after the legacy results were seen', 'accepted',
     'Re-verified: v1 ours_gru and islr1st_ourfeat equal the legacy predictions (top-1 and confidences), ours_baseline the same top-1. AMENDMENTS.md item 10 discloses it; every primary quote carries the label.'),
    ('Only the competitor\'s training rule changed (60-epoch cap vs 300)', 'accepted',
     'Re-verified (fold 11672 inner loss still falling near best epoch 42; islr1st_ourfeat 14938 best epoch 54 of 60). AMENDMENTS.md item 11: every network re-run with a 200-epoch cap (recognition/compare/epoch_cap.py), reported next to the primary; qualifier attached to islr1st_retrained. Result: all 30 cap-200 jobs finished; under the nested rule early stopping, not the cap, ended training (islr1st_retrained ran 30-66 epochs, best 18-54); the primary difference moved from +0.6 to +1.4 points and its verdict category did not change. A fixed 300-epoch run without early stopping (the winner\'s own setting) remains untested.'),
    ('With 10 signers the CI method decides the verdict', 'accepted',
     'Re-verified exactly on the legacy data (bootstrap -0.039, cluster-robust t -0.043, per-signer t -0.078, sign-flip p 0.914). AMENDMENTS.md item 12: all three printed next to the registered bootstrap, with the prescribed wording when they disagree.'),
    ('Product-relevant outside-vocabulary error is only secondary', 'accepted',
     'AMENDMENTS.md item 13: the primary is always printed with R8 wrong-sign-spoken and open-set false accept (signer CIs, paired differences); wrong-sign-spoken now has a CI in every table.'),
    ('Protocol and margin launched without Talha\'s sign-off', 'partly accepted',
     'Still unconfirmed and labelled on every primary quote (AMENDMENTS.md item 14). Not applied: holding back the read until he confirms. He is asleep and asked for the run to finish overnight, the margin is frozen in the hashed file and amendments, and any later change is labelled post hoc. The non-inferiority VERDICT stays uncleared until he confirms.'),
    ('Pretrained sum rule labelled pre-specified', 'accepted',
     'Re-verified (sum 0.823 vs max-other 0.900 on the legacy raw file). AMENDMENTS.md item 15: label withdrawn, both rules printed side by side, no pretrained R8 figure cleared.'),
    ('Track B parity test is plumbing on synthetic landmarks', 'accepted (partly limited)',
     'prepare() now replays the real recognition.stream.SignStream; new tests check it frame for frame against SignStream.push/flush (one sign, resting hands, two signs, framing rejection); pre-cleaned files refused outside smoke. Limit: the results are still synthetic; no real video recording exists.'),
    ('Track A ours_gru is a recipe, not the product', 'accepted',
     'Scope label on every Track A claim and in the report header; data/gislr/MANIFEST.json identity and licence notes corrected.'),
]


def _pct(v):
    return f"{100 * v:.1f}%"


def _ci(ci):
    return f"{100 * ci[0]:.1f}-{100 * ci[1]:.1f}%"


def _pp(v):
    return f"{100 * v:+.1f}"


def _ppci(ci):
    return f"{100 * ci[0]:+.1f} to {100 * ci[1]:+.1f}"


def clearance(reports, independent=None):
    """Cleared sentences (verbatim, with scope labels) and the not-cleared list, built from reports/track_a_v1.json
    and, for the integrity sentence, an independent manifest re-check (audit_scratch/indep_audit.json format)."""
    tj = reports / 'track_a_v1.json'
    t = json.loads(tj.read_text()) if tj.exists() else None
    ind = json.loads(Path(independent).read_text()) if independent and Path(independent).exists() else None
    cleared, pending = [], []
    nc = ['"Our model is as accurate as / matches / beats the Kaggle winner", in any form. The pretrained winner is not a matched comparison; the retrained one is a constrained port.',
          'Any pretrained R8 / 8-way number (sum rule or max-other): both rules were fixed after alternatives were examined.',
          'Any pretrained open-set / outside-vocabulary / false-accept number: all 30 outside signs are in its 250-sign training vocabulary.',
          'Any statement that GISLR test signers are "distinct people" from the winner\'s training signers (verified by participant ID only).',
          'Any statement about product, live-pipeline or hotel-vocabulary (22-class) accuracy from Track A.',
          'Any Track B accuracy, false-accept or wrong-sign number: there are no real held-out recordings.',
          'Latency numbers measured on the shared, loaded machine.',
          'C7 (forced-choice) accuracy quoted without the R8 wrong-sign-spoken and false-accept rates next to it.',
          'Any "pre-registered" label on Track A v1 results without the disclosure that the legacy results were visible when PROTOCOL.md was written.',
          'Partial-fold numbers of any system or of the epoch-cap sensitivity run.']
    if ind and ind.get('n_manifests') == 41 and not ind.get('manifest_problems') and ind.get('distinct_training_code_sets') == 1 \
            and ind.get('inner_split_identical_across_systems') is True and ind.get('index_matches_disk') \
            and ind.get('pretrained_manifest') and all(ind['pretrained_manifest'].values()):
        cleared.append('[Integrity only; no accuracy claim] On the GISLR rerun Track A set (10 participant IDs, 1,105 in-vocabulary clips, '
                       '225 outside-vocabulary test clips), an independent re-check of all 41 protocol manifests (40 trained jobs and the '
                       'pretrained reference) found that every compared system trained on the identical clip list per fold, never saw the '
                       'held-out signer or any of the 15 test-only outside signs, used the same inner split, and used one set of training '
                       'code; PROTOCOL.md sha256 ac59252a...6413f was unchanged.')
    else:
        pending.append('Integrity sentence: needs the independent manifest re-check of all 41 manifests to pass.')
    if not t:
        pending.append('All accuracy sentences: reports/track_a_v1.json does not exist yet.')
        return cleared, nc, pending
    C7, R8 = t['modes'].get('C7', {}), t['modes'].get('R8', {})
    g7, g8 = C7.get('systems', {}).get('ours_gru'), R8.get('systems', {}).get('ours_gru')
    tag = f'[Exploratory, legacy-equivalent; {SCOPE_A}]'
    if g7:
        cleared.append(f"{tag} On 7 signs shared with GISLR, our GRU recipe trained on 9 GISLR participants and tested on the 10th reached "
                       f"{_pct(g7['metrics']['accuracy'])} forced-choice top-1 (95% CI over signers {_ci(g7['top1_ci95'])}; "
                       f"{g7['n_signers']} participant IDs, {g7['n_clips']:,} clips, signer-held-out).")
    pb = C7.get('paired', {}).get('ours_gru - ours_baseline', {}).get('top1')
    if pb:
        cleared.append(f"[Same scope] On those clips our GRU recipe was {100 * pb['diff']:.1f} percentage points more accurate than our "
                       f"logistic-regression baseline (paired on identical clips, 95% CI over signers {_ppci(pb['ci95'])}; "
                       f"{pb['n_signers']} signers, {pb['n_clips']:,} clips, signer-held-out).")
    if g8 and g8['metrics'].get('wrong_sign_spoken_rate') is not None and g8.get('wrong_sign_spoken_ci95'):
        cleared.append(f"[Same scope, must be quoted together with the two sentences above] When the product rule speaks a sign only at "
                       f"confidence >=0.6, our GRU recipe spoke a wrong in-vocabulary sign on {_pct(g8['metrics']['wrong_sign_spoken_rate'])} "
                       f"of clips (95% CI {_ci(g8['wrong_sign_spoken_ci95'])}; {g8['n_signers']} signers, {g8['n_clips']:,} clips), and spoke "
                       f"one of our signs for {_pct(g8['open_set_false_accept'])} of clips of 15 unseen outside signs (95% CI "
                       f"{_ci(g8['open_set_false_accept_ci95'])}; {g8['n_signers']} signers, {g8['n_oov_clips']} clips).")
    ref = t.get('reference_pretrained', {}).get('C7')
    if ref:
        a10, p6 = ref['all10'], ref['private6']
        cleared.append('[Reference only, not a matched comparison] The published GISLR 1st-place ensemble, a much larger model trained on '
                       'about 94k clips of 250 signs from 21 other participant IDs (that the IDs are different people is unverified; 4 of '
                       f"the 10 test signers influenced its selection), reached {_pct(a10['metrics']['accuracy'])} forced-choice top-1 on the "
                       f"same 7 signs (95% CI {_ci(a10['top1_ci95'])}; {a10['n_signers']} signers, {a10['n_clips']:,} clips), and "
                       f"{_pct(p6['metrics']['accuracy'])} on the 6 private-leaderboard signers only (95% CI {_ci(p6['top1_ci95'])}; "
                       f"{p6['n_clips']} clips).")
    pr = t.get('primary')
    ec = t.get('epoch_cap_sensitivity', {})
    cap_c = ec.get('ours_gru (60) minus islr1st_retrained (200)')
    cap_s = ec.get('ours_gru (200) minus islr1st_retrained (200)')
    if pr and cap_c:
        pa = pr['product_axis_R8']
        a_, b_ = pa['ours_gru'], pa['islr1st_retrained']
        sens = pr['ci_sensitivity']
        extra = (f" With the competitor recipe allowed up to 200 epochs (sensitivity analysis, same rule) the difference was "
                 f"{_pp(cap_c['diff'])} points (bootstrap 95% CI {_ppci(cap_c['ci95'])})")
        extra += (f", and {_pp(cap_s['diff'])} points ({_ppci(cap_s['ci95'])}) when both were allowed 200 epochs." if cap_s else ".")
        cleared.append('[Primary endpoint, DESCRIPTIVE ONLY (no verdict); endpoint and margin chosen after exploratory results on the same '
                       f'test set were seen; margin not yet confirmed by Talha; {SCOPE_A}; competitor = PyTorch port of the GISLR 1st-place '
                       'network and recipe, at most 60 epochs, 1 seed, no AWP, CPU, about 1,200 training clips per fold; quote the whole '
                       'paragraph or none of it] On the 7 shared signs, our GRU recipe\'s forced-choice top-1 minus the retrained winner '
                       f"recipe's was {_pp(pr['diff'])} percentage points (95% CI over signers {_ppci(pr['ci95'])} by the registered pooled "
                       f"signer bootstrap; {_ppci(sens['unweighted_signer_mean_t95'])} for the unweighted per-signer mean; exact sign-flip "
                       f"p = {sens['sign_flip_exact_p']}; {pr['n_signers']} signers, {pr['n_clips']:,} clips, signer-held-out).{extra} "
                       f"In the product setting (speak only at confidence >=0.6, never NONE), ours spoke a wrong sign on "
                       f"{_pct(a_['R8_wrong_sign_spoken']['value'])} ({_ci(a_['R8_wrong_sign_spoken']['ci95'])}) and the retrained winner "
                       f"recipe on {_pct(b_['R8_wrong_sign_spoken']['value'])} ({_ci(b_['R8_wrong_sign_spoken']['ci95'])}) of "
                       f"{a_['R8_wrong_sign_spoken']['n_clips']:,} in-vocabulary clips, and they spoke one of our signs for "
                       f"{_pct(a_['R8_open_set_false_accept']['value'])} ({_ci(a_['R8_open_set_false_accept']['ci95'])}) and "
                       f"{_pct(b_['R8_open_set_false_accept']['value'])} ({_ci(b_['R8_open_set_false_accept']['ci95'])}) of "
                       f"{a_['R8_open_set_false_accept']['n_clips']} outside-vocabulary clips (10 signers).")
        nc.insert(0, f"The non-inferiority VERDICT of the primary (registered rule: \"{pr['verdict']}\"; reading across interval methods: "
                     f"\"{pr['robust_verdict']}\"): not cleared until Talha confirms the -0.05 margin; even then it carries the labels above.")
    elif pr:
        pending.append('Primary endpoint sentence: the 200-epoch-cap sensitivity run for islr1st_retrained has not finished all 10 folds, '
                       'and AMENDMENTS.md item 11 requires it next to the primary.')
        nc.insert(0, 'Any primary-endpoint number or verdict until the epoch-cap sensitivity analysis is reported next to it.')
    else:
        pending.append('Primary endpoint: not computable yet (islr1st_retrained has not finished all 10 protocol folds).')
        nc.insert(0, 'Any primary-endpoint number or verdict (ours_gru vs islr1st_retrained): not computed yet.')
    of = C7.get('paired', {}).get('ours_gru - islr1st_ourfeat', {}).get('top1')
    o8 = R8.get('systems', {}).get('islr1st_ourfeat')
    if of and o8 and pr and cap_c:
        cap_o = ec.get('ours_gru (200) minus islr1st_ourfeat (200)')
        capt = (f" With both allowed up to 200 epochs the change was {_pp(-cap_o['diff'])} points "
                f"({_ppci([-cap_o['ci95'][1], -cap_o['ci95'][0]])})." if cap_o else
                " (No 200-epoch sensitivity result for this system; with the 60-epoch cap it stopped at the cap in 1 of 10 folds.)")
        cleared.append(f"[Secondary, descriptive; endpoint chosen after exploratory results on the same test set were seen; {SCOPE_A}; "
                       "quote the whole paragraph or none of it] Keeping our features and training code and changing only the "
                       f"network to the 1st-place architecture changed forced-choice top-1 by {_pp(-of['diff'])} percentage points "
                       f"(95% CI over signers {_ppci([-of['ci95'][1], -of['ci95'][0]])}; {of['n_signers']} signers, {of['n_clips']:,} clips, "
                       f"signer-held-out).{capt} Under the product rule it spoke a wrong sign on "
                       f"{_pct(o8['metrics']['wrong_sign_spoken_rate'])} ({_ci(o8['wrong_sign_spoken_ci95'])}) of in-vocabulary clips "
                       f"and one of our signs for {_pct(o8['open_set_false_accept'])} ({_ci(o8['open_set_false_accept_ci95'])}) of "
                       f"{o8['n_oov_clips']} outside-vocabulary clips, against {_pct(g8['metrics']['wrong_sign_spoken_rate'])} and "
                       f"{_pct(g8['open_set_false_accept'])} for our GRU recipe.")
    elif of:
        pending.append('Architecture-only secondary sentence (islr1st_ourfeat): waits for the primary sentence to be cleared.')
    return cleared, nc, pending


DECISION = (
    'Release status: only the cleared sentences above may be used; no product, live-pipeline or 22-sign accuracy claim is '
    'cleared, and no claim of matching or beating the Kaggle winner. '
    'Architecture: keep the GRU for now. Track A gives no evidence that the 1st-place architecture improves forced-choice '
    'accuracy (architecture-only change -0.2 points, 95% CI -1.3 to +1.2, 60-epoch cap; -0.9 points, -1.9 to +0.2, at a '
    '200-epoch cap; 10 signers, 1,105 clips), so adopting it is not supported by this evidence. '
    'Recipe: the retrained winner recipe (its own preprocessing with face points, augmentation and optimiser) spoke fewer wrong '
    'signs and fewer outside-vocabulary signs under the product rule (see the primary paragraph; secondary, descriptive, no '
    'multiplicity correction). Whether to adopt parts of that recipe is Talha\'s decision; any such change should be '
    'specified before testing and checked on Track B, because Track A does not test the shipped model or the live path. '
    'Non-inferiority verdict: not cleared until Talha confirms the -0.05 margin, and even then it holds under the registered '
    'pooled bootstrap only (inconclusive under per-signer weighting). '
    'Product accuracy claims need Track B: a frozen, hashed model and real held-out recordings.')


def main(independent=None):
    import sys
    if independent is None and len(sys.argv) > 2 and sys.argv[1] == '--independent':
        independent = sys.argv[2]
    result = inspect_run()
    reports = Path(__file__).parent / 'reports'
    reports.mkdir(exist_ok=True)
    lines = ['# Benchmark audit — clearance decision (only the cleared sentences below may be used)', '',
             'This audit checks saved evidence and corrects acceptance metrics. It does not validate real guest accuracy or authorize a model replacement.', '',
             f"Checked at {result['created']}.", '',
             f"Index: {result['index']['clips']} clips; {result['index']['in_vocabulary']} in-vocabulary and {result['index']['all_oov']} outside-vocabulary clips.",
             f"Index errors: {len(result['index']['errors'])}. Source-label mismatches: {len(result['source_labels']['mismatches'])}. Missing source files: {len(result['source_labels']['missing_files'])}.", '',
             '## Saved legacy run completeness (data/compare/track_a)', '', '| System | C7 | R8 |', '|---|---|---|']
    for system, modes in result['systems'].items():
        cells = [f"{c['rows']}/{c['expected_rows']} ({'complete' if c['complete'] else 'not complete'})" for c in modes.values()]
        lines.append(f"| {system} | {' | '.join(cells)} |")
    pe = result.get('pretrained_exploratory')
    if pe:
        lines += ['', '## Pretrained reference, exploratory re-reading of the saved outputs', '',
                  'GISLR rerun set, 7 shared signs, in-vocabulary clips only; signer-held-out by participant ID only (identity unverified). '
                  'Not pre-registered. Neither R8 rule is cleared: both were fixed after alternatives were examined (AMENDMENTS.md item 15). 95% CI over signers.', '',
                  '| signers | reading | #signers | #clips | top-1 [95% CI] |', '|---|---|---|---|---|']
        names = {'C7': 'C7 forced choice', 'R8_sum': 'R8, sum rule (fixed after alternatives were examined; not cleared)',
                 'R8_maxother': 'R8, max-other (chosen after seeing results; not cleared)'}
        for key, v in pe.items():
            if '/' in key:
                subset, rule = key.split('/')
                lines.append(f"| {'all 10' if subset == 'all10' else 'private 6'} | {names[rule]} | {v['n_signers']} | {v['n_clips']} | "
                             f"{v['top1']:.3f} [{v['top1_ci95'][0]:.3f}, {v['top1_ci95'][1]:.3f}] |")
    pr = result['protocol_run']
    lines += ['', f"Protocol run folder `{pr['run_dir']}`: {pr['manifests']} of {pr['expected_manifests']} manifests present."]
    lines += ['', '## Findings that prevent release', '']
    lines += [f'- {text}' for text in result['release_blockers']]
    lines += ['', '## Metric corrections', '',
        '- Coverage and accuracy on accepted answers now exclude NONE, including confident refusals. The earlier report counted them as spoken answers.',
        '- Saved confidence values are no longer rounded before applying the 0.6 threshold. Historical predictions remain rounded; check boundary cases before using them.',
        '- Paired comparisons reject duplicate clip IDs and inconsistent signer, label, or OOV metadata.',
        '- A nondefault rejection threshold now applies consistently to open-set confidence intervals and per-sign rates.',
        '- The pretrained R8 max-other vector is a score vector, not a normalized probability distribution; its ECE is suppressed.', '',
        '## Sources', '',
        '- Kaggle rerun-set metadata (sohier/461054610546105, CC0, created by Kaggle staff 2023-02-17); its Usage column gives the public (6927, 11696, 14938, 23662) and private (2455, 11672, 15662, 32536, 34304, 48118) leaderboard signers.',
        '- Local evidence: data/compare/track_a/index.json, preds/, models/, pilot_partial.log; data/gislr_raw/labels.parqet. Artifact hashes and check results are in audit.json.',
        '- [Published model provenance](https://huggingface.co/sign/kaggle-asl-signs-1st-place).',
        '- [Original winning implementation](https://github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution).',
        '- [Dataset-creator paper](https://papers.nips.cc/paper_files/paper/2023/file/00dada608b8db212ea7d9d92b24c68de-Paper-Datasets_and_Benchmarks.pdf). The later PopSign release has a different population and split; it does not itself prove the identity mapping for this rerun set.', '']
    cleared, not_cleared, pending = clearance(reports, independent)
    result['clearance'] = {'cleared': cleared, 'not_cleared': not_cleared, 'pending': pending,
                           'finding_outcomes': [dict(zip(('finding', 'outcome', 'how'), f)) for f in FINDING_OUTCOMES]}
    (reports / 'audit.json').write_text(json.dumps(result, indent=2) + '\n')
    sources = lines[lines.index('## Sources'):]
    lines = lines[:lines.index('## Sources')]
    lines += ['## Independent-audit findings (2026-10-11) and what was done', '', '| # | finding | outcome | how |', '|---|---|---|---|']
    lines += [f'| {i} | {f} | {o} | {h} |' for i, (f, o, h) in enumerate(FINDING_OUTCOMES, 1)]
    lines += ['', '## Clearance decision', '',
              'Only the sentences below may be used, verbatim, each with its bracketed scope label. Everything else is not cleared.', '',
              '### Cleared sentences', '']
    lines += [f'{i}. {c}' for i, c in enumerate(cleared, 1)] or ['None.']
    lines += ['', '### Not cleared', ''] + [f'- {c}' for c in not_cleared]
    if pending:
        lines += ['', '### Waiting for (not cleared until done)', ''] + [f'- {c}' for c in pending]
    lines += ['', '## Decision', '', DECISION, ''] + sources
    (reports / 'audit.md').write_text('\n'.join(lines))
    print(json.dumps({'release_approved': False, 'index_errors': result['index']['errors'],
        'source_label_mismatches': len(result['source_labels']['mismatches']),
        'incomplete': [s for s, modes in result['systems'].items() if any(not c['complete'] for c in modes.values())]}))


if __name__ == '__main__':
    main()
