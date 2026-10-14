"""Epoch-cap sensitivity analysis for Track A v1 (AMENDMENTS.md item 11).

The protocol caps every network at 60 epochs; the GISLR winner trained for 300. This runner repeats
the protocol jobs with ONE change, a 200-epoch cap, using the very same training code (it imports
track_a_gislr and changes only its EPOCHS_MAX; no file in manifest.TRAINING_CODE is touched). Same
folds, same inner split, same nested rule (inner-signer validation loss, patience 12, temperature on
the inner signer, refit for the chosen epochs). Outputs go to data/compare/track_a_v1_epochcap200/.

    python -m recognition.compare.epoch_cap run [--workers 6]     # resumable; at most 6 jobs machine-wide
    python -m recognition.compare.epoch_cap job --system ours_gru --fold 2455 [--smoke --out DIR]
    python -m recognition.compare.epoch_cap status

Worker rule: never more than MAX_TOTAL (6) Track A training jobs at once on this machine, counting the
protocol run's jobs. While the protocol runner (data/compare/track_a_v1/run.pid) is alive it may run
up to 5 jobs, so this runner then uses at most 1.
"""
import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from recognition.compare import manifest
from recognition.compare import track_a_gislr as ta

CAP = 200
AMENDMENT = 11
OUT = ta.ROOT / "data/compare/track_a_v1_epochcap200"
PROTOCOL_RUN = ta.ROOT / "data/compare/track_a_v1"
ORDER = ["ours_gru", "islr1st_retrained", "islr1st_ourfeat"]
MAX_TOTAL = 6
PROTOCOL_RUNNER_WORKERS = 5
EPOCHS_ERROR = "epochs not chosen by the pre-registered nested rule"


def run_job(system, fold, out=OUT, smoke=False):
    ta.OUT = Path(out)
    ta.EPOCHS_MAX = CAP
    ta.run_job(system, fold, smoke=smoke)
    p = manifest.manifest_path(out, system, fold)
    m = json.loads(p.read_text())
    m["sensitivity"] = {"what": "epoch-cap sensitivity analysis", "amendment": AMENDMENT, "epochs_max": CAP,
                        "protocol_epochs_max": 60,
                        "only_change": "EPOCHS_MAX 60 -> 200; training code identical to the protocol run"}
    manifest.write(p, m)


def check(idx, system, fold, out=OUT, protocol=None):
    """Errors for one sensitivity job: every protocol check except the 60-epoch cap, plus cap == CAP."""
    files = [Path(out) / "preds" / f"{system}_{mode}_{fold}.jsonl" for mode in ta.MODES]
    if not all(f.exists() for f in files):
        return [f"{system}/{fold}: prediction files missing"]
    errors = [e for e in manifest.check(idx, system, fold, out, ta.fold_sets, files, protocol) if EPOCHS_ERROR not in e]
    m = manifest.load(out, system, fold) or {}
    t = m.get("tuning", {})
    if t.get("epochs_max") != CAP or t.get("rule") != ta.TUNING_RULE or m.get("sensitivity", {}).get("epochs_max") != CAP:
        errors.append(f"{system}/{fold}: not a {CAP}-epoch-cap sensitivity job under the nested rule")
    return errors


def protocol_code():
    """Training-code hashes of the protocol run (all its manifests must agree)."""
    keys = set()
    for p in (PROTOCOL_RUN / "preds").glob("*.manifest.json"):
        m = json.loads(p.read_text())
        if m.get("system") != "islr1st_pretrained":
            keys.add(tuple((f, m.get("code_sha256", {}).get(f)) for f in manifest.TRAINING_CODE))
    if len(keys) != 1:
        sys.exit(f"protocol run manifests disagree on training code ({len(keys)} versions); refusing")
    return dict(next(iter(keys)))


def _running_jobs():
    """(protocol-run jobs, our jobs) currently running on this machine."""
    ps = subprocess.run(["ps", "-axo", "command"], capture_output=True, text=True).stdout.splitlines()
    main = sum(1 for c in ps if "recognition.compare.track_a_gislr" in c and " job " in c and "epochcap" not in c)
    ours = sum(1 for c in ps if "recognition.compare.epoch_cap" in c and " job " in c)
    return main, ours


def _protocol_runner_alive():
    pid = PROTOCOL_RUN / "run.pid"
    try:
        os.kill(int(pid.read_text().split()[0]), 0)
        return True
    except (OSError, ValueError):
        return False


def run_all(workers, log=print):
    workers = min(workers, MAX_TOTAL)
    pid = OUT / "run.pid"
    if pid.exists():
        sys.exit(f"{pid} exists (pid {pid.read_text().strip()}): check `ps` and remove it if stale")
    if manifest.protocol_sha256() is None:
        sys.exit("PROTOCOL.md missing")
    want = protocol_code()
    now = manifest.training_code_hashes()
    if now != want:
        sys.exit("training code here differs from the protocol run's manifests; run from /Users/trehman/CamelHack-bench")
    OUT.mkdir(parents=True, exist_ok=True)
    if not (OUT / "index.json").exists():
        (OUT / "index.json").write_text((PROTOCOL_RUN / "index.json").read_text())
    idx = ta.load_index(OUT)
    jobs = [(s, f) for s in ORDER for f in idx["signers"] if check(idx, s, f)]
    (OUT / "logs").mkdir(exist_ok=True)
    pid.write_text(f"{os.getpid()}\n")
    env = {**os.environ, "OMP_NUM_THREADS": str(ta.THREADS), "PYTHONHASHSEED": "0", "PYTHONUNBUFFERED": "1"}
    children, gate, stop = set(), threading.Lock(), threading.Event()
    log(f"{time.strftime('%F %T')} {len(jobs)} jobs, cap {CAP}, up to {workers} workers (<= {MAX_TOTAL} machine-wide)")

    def kill_all(*_):
        stop.set()
        for p in list(children):
            p.kill()
    signal.signal(signal.SIGTERM, lambda *a: (kill_all(), sys.exit(143)))

    def one(job):
        s, f = job
        with gate:          # start jobs one at a time, only when a machine-wide slot is free
            while not stop.is_set():
                main, ours = _running_jobs()
                limit = MAX_TOTAL - PROTOCOL_RUNNER_WORKERS if _protocol_runner_alive() else MAX_TOTAL - main
                if ours < min(limit, workers):
                    break
                time.sleep(30)
            if stop.is_set():
                return 1
            if manifest.training_code_hashes() != want:
                log(f"REFUSED {s} {f}: training code changed since launch")
                stop.set()
                return 1
            t0 = time.time()
            fh = open(OUT / "logs" / f"{s}_{f}.log", "w")
            p = subprocess.Popen([sys.executable, "-m", "recognition.compare.epoch_cap", "job", "--system", s,
                                  "--fold", f], cwd=ta.ROOT, env=env, stdout=fh, stderr=subprocess.STDOUT)
            children.add(p)
            log(f"{time.strftime('%F %T')} start {s} {f} (pid {p.pid})")
            time.sleep(5)
        rc = p.wait()
        children.discard(p)
        fh.close()
        log(f"{time.strftime('%F %T')} {'ok ' if rc == 0 else 'FAILED'} {s} {f} {time.time() - t0:.0f}s")
        return rc
    try:
        with ThreadPoolExecutor(workers) as ex:
            rcs = list(ex.map(one, jobs))
        log(f"{time.strftime('%F %T')} finished: {sum(1 for r in rcs if r == 0)} ok, {sum(1 for r in rcs if r)} failed")
    finally:
        kill_all()
        pid.unlink(missing_ok=True)


def status(out=OUT):
    idx = ta.load_index(out) if (Path(out) / "index.json").exists() else None
    if idx is None:
        print("no sensitivity run yet")
        return {}
    res = {s: [f for f in idx["signers"] if not check(idx, s, f, out)] for s in ORDER}
    for s, done in res.items():
        print(f"{s}: {len(done)}/10 done")
    return res


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--workers", type=int, default=MAX_TOTAL)
    j = sub.add_parser("job")
    j.add_argument("--system", required=True, choices=ORDER)
    j.add_argument("--fold", required=True)
    j.add_argument("--smoke", action="store_true")
    j.add_argument("--out", default=str(OUT))
    sub.add_parser("status")
    a = ap.parse_args(argv)
    if a.cmd == "job":
        run_job(a.system, a.fold, Path(a.out).resolve(), smoke=a.smoke)
    elif a.cmd == "status":
        status()
    else:
        run_all(a.workers)


if __name__ == "__main__":
    main()
