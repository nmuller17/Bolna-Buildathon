# Amendments and deviations to PROTOCOL.md (Track A v1)

PROTOCOL.md sha256 at launch: `ac59252ac6aa9dc6e83a3bc89bd0eb52afc1d2a1f8a1f628e533583e81a6413f` (verified equal to the value recorded in the progress notes before launch). PROTOCOL.md itself is not edited.

## DEVIATIONS

### 2026-10-10 ~20:16 EDT, written BEFORE any protocol job started (no result under this protocol had been seen)

1. **Launch without Talha's explicit sign-off of the file or of the -0.05 margin.** PROTOCOL.md asks Talha to review it, and to confirm the -0.05 non-inferiority margin, before launch. No explicit confirmation was recorded. The run was launched on his standing instruction to "continue with the benchmark audit" and to "benchmark against the competitor ... in terms of accuracy". The verdict rule and margin stay exactly as written in the hashed file. If Talha later changes the margin or any other rule, that change will have been made after results were visible, and it must be added here labelled "post hoc", with the original verdict reported next to the new one.
2. **Runner started at reduced CPU priority (`nice -n 15`).** A live camera recording session (`capture/train_session.py` in another worktree) was running when the run was launched. To avoid dropping frames in that recording, the runner and all its jobs run at low priority. Worker count (5) and threads per job (2) are as in PROTOCOL.md section 9. Priority changes only wall-clock time, not results.
3. **Pretrained reference run inside `run`, not as a separate step.** `run` (all systems) runs the TFLite reference after the trained jobs, as the code does; this is the same command as section 9 step 4.

### 2026-10-10 ~21:52 EDT: first launch abandoned; clean restart. No result of the abandoned run was read (only per-job epoch and temperature fields in the progress notes).

4. **`recognition/labels.py` was edited during the run by another session** (file time 21:45:18 EDT): class 13 was renamed from `FS-CHECKOUT` to `LEAVE`. Nothing else in that file changed, and none of the Track A labels (YES, NO, THANK-YOU, WHERE, TIME, PLEASE, ROOM, NONE) moved, so the change should not affect Track A. But `report.py` correctly refuses to combine manifests written under different training code, and the runner hashed the code at the END of each job, so 5 jobs that started under the old file would have recorded the new hash. At that point 27 of 40 jobs were done (all 20 `ours_*`, 5 `islr1st_ourfeat`, 2 `islr1st_retrained`) and 5 were running. I stopped the run, killed its 5 jobs, moved the whole folder to `data/compare/track_a_v1_superseded_labels_2026-10-10/` (kept, never reported), and restarted all 40 jobs plus the pretrained reference from scratch under the new `labels.py`.
5. **Hardening of the runner before the restart (no change to any training, tuning, data or scoring rule).**
   - `run_job` now hashes the code at job START (`code_sha256`) and again at the end (`code_sha256_end`).
   - `manifest.check` refuses a job whose training code changed while it was running.
   - `run_all` refuses to start any further job once the training code differs from what it was at launch, so a mid-run edit stops the run instead of mixing code.
   - New test `test_manifest_refuses_training_code_changed_during_a_job`. `test_compare_audit.py`: 19 passed.
   - This changes `recognition/compare/track_a_gislr.py`, which is listed in TRAINING_CODE. Every job of the restarted run uses the new version.
