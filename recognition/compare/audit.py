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
        'The pretrained max-other rejection rule was selected after comparing results. PROTOCOL.md pre-specifies the sum rule; max-other is exploratory only.',
        'Legacy islr1st_retrained used a fixed 60 epochs informed by a global pilot whose validation signer (48118) is an outer test fold. PROTOCOL.md replaces it with nested per-fold early stopping; the legacy run must not be reported.',
        'Track A omits the live segmenter and framing gate and covers only seven hotel-vocabulary signs, not the 22-class product.',
        'Track B has no real held-out hotel-sign recordings. The extractor now uses the capture-parity path, but no result exists until recordings are made.',
        'The legacy runs did not store per-job manifests; the protocol report refuses them. A protocol re-run is required before any figure is used.',
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


def main():
    result = inspect_run()
    reports = Path(__file__).parent / 'reports'
    reports.mkdir(exist_ok=True)
    (reports / 'audit.json').write_text(json.dumps(result, indent=2) + '\n')
    lines = ['# Benchmark audit — not cleared for slides', '',
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
                  'Not pre-registered; the sum rule is the one PROTOCOL.md fixes for future reports. 95% CI over signers.', '',
                  '| signers | reading | #signers | #clips | top-1 [95% CI] |', '|---|---|---|---|---|']
        names = {'C7': 'C7 forced choice', 'R8_sum': 'R8, sum rule (pre-specified)', 'R8_maxother': 'R8, max-other (post hoc)'}
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
        '## Decision', '',
        'Keep the existing product model architecture. Do not adopt the winner architecture on the basis of the legacy comparison. Re-run Track A under PROTOCOL.md (manifests, nested tuning), and record and freeze a new held-out signer test for Track B before making product accuracy claims.', '',
        '## Sources', '',
        '- Kaggle rerun-set metadata (sohier/461054610546105, CC0, created by Kaggle staff 2023-02-17); its Usage column gives the public (6927, 11696, 14938, 23662) and private (2455, 11672, 15662, 32536, 34304, 48118) leaderboard signers.',
        '- Local evidence: data/compare/track_a/index.json, preds/, models/, pilot_partial.log; data/gislr_raw/labels.parqet. Artifact hashes and check results are in audit.json.',
        '- [Published model provenance](https://huggingface.co/sign/kaggle-asl-signs-1st-place).',
        '- [Original winning implementation](https://github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution).',
        '- [Dataset-creator paper](https://papers.nips.cc/paper_files/paper/2023/file/00dada608b8db212ea7d9d92b24c68de-Paper-Datasets_and_Benchmarks.pdf). The later PopSign release has a different population and split; it does not itself prove the identity mapping for this rerun set.', '']
    (reports / 'audit.md').write_text('\n'.join(lines))
    print(json.dumps({'release_approved': False, 'index_errors': result['index']['errors'],
        'source_label_mismatches': len(result['source_labels']['mismatches']),
        'incomplete': [s for s, modes in result['systems'].items() if any(not c['complete'] for c in modes.values())]}))


if __name__ == '__main__':
    main()
