"""Check that the PyTorch port (islr1st.py) is faithful: load the authors' published Keras weights
(Kaggle hoyso48/islr-models, seed 42, converted from .h5 to .npz in the bench venv with h5py) into
islr1st.ISLR1st and compare its answers with the published TFLite model on the same raw clips.

    python -m recognition.compare.check_islr1st_port [--n 400]

Agreement is not expected to be 100%: the TFLite file may ensemble several seeds and runs in fp16/TFLite
kernels. A port bug (wrong point order, normalisation, block wiring) would show up as low agreement.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import torch

from recognition.compare import islr1st
from recognition.compare.track_a_gislr import LEGACY_OUT as OUT, ROOT  # port check reads the saved legacy TFLite outputs

NPZ = ROOT / "data/compare/ext/islr1st_h5/seed42_weights.npz"


def load_keras(npz=NPZ):
    w = {k.replace("|", "/"): v for k, v in np.load(npz).items()}
    g = lambda name: torch.from_numpy(w[name].astype(np.float32))
    m = islr1st.ISLR1st(n_classes=250)

    def bn(mod, prefix):
        mod.bn.weight.data, mod.bn.bias.data = g(f"{prefix}/gamma:0"), g(f"{prefix}/beta:0")
        mod.bn.running_mean.data, mod.bn.running_var.data = g(f"{prefix}/moving_mean:0"), g(f"{prefix}/moving_variance:0")

    m.stem.weight.data = g("stem_conv/stem_conv/kernel:0").T
    bn(m.stem_bn, "stem_bn/stem_bn")
    convs = [b for b in m.blocks if isinstance(b, islr1st.Conv1DBlock)]
    trans = [b for b in m.blocks if isinstance(b, islr1st.TransformerBlock)]
    for i, b in enumerate(convs, 1):
        b.expand.weight.data, b.expand.bias.data = g(f"{i}_expand_conv/{i}_expand_conv/kernel:0").T, g(f"{i}_expand_conv/{i}_expand_conv/bias:0")
        b.dw.weight.data = g(f"{i}_dwconv/{i}_dwconv/{i}_dwconv_dwconv/depthwise_kernel:0")[:, :, 0].T.unsqueeze(1).contiguous()
        bn(b.bn, f"{i}_bn/{i}_bn")
        eca = "eca" if i == 1 else f"eca_{i - 1}"
        b.eca.conv.weight.data = g(f"{eca}/{eca}/conv1d/kernel:0")[:, 0, 0].reshape(1, 1, -1)
        b.project.weight.data, b.project.bias.data = g(f"{i}_project_conv/{i}_project_conv/kernel:0").T, g(f"{i}_project_conv/{i}_project_conv/bias:0")
    for j, b in enumerate(trans):
        bn(b.bn1, f"batch_normalization{'' if j == 0 else '_' + str(2 * j)}/batch_normalization{'' if j == 0 else '_' + str(2 * j)}")
        bn(b.bn2, f"batch_normalization_{2 * j + 1}/batch_normalization_{2 * j + 1}")
        mh = "multi_head_self_attention" + ("" if j == 0 else "_1")
        b.att.qkv.weight.data = g(f"{mh}/{mh}/dense{'' if j == 0 else '_4'}/kernel:0").T
        b.att.proj.weight.data = g(f"{mh}/{mh}/dense_{1 if j == 0 else 5}/kernel:0").T
        b.ff1.weight.data = g(f"dense_{2 if j == 0 else 6}/dense_{2 if j == 0 else 6}/kernel:0").T
        b.ff2.weight.data = g(f"dense_{3 if j == 0 else 7}/dense_{3 if j == 0 else 7}/kernel:0").T
    m.top.weight.data, m.top.bias.data = g("top_conv/top_conv/kernel:0").T, g("top_conv/top_conv/bias:0")
    m.cls.weight.data, m.cls.bias.data = g("classifier/classifier/kernel:0").T, g("classifier/classifier/bias:0")
    return m.eval()


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=400)
    a = ap.parse_args(argv)
    torch.set_num_threads(2)
    s2i = json.loads((ROOT / "data/compare/ext/islr1st_hf/sign_to_prediction_index_map.json").read_text())
    i2s = {v: k for k, v in s2i.items()}
    tfl = {json.loads(l)["clip_id"]: json.loads(l) for l in open(OUT / "ext_islr1st_pretrained_raw.jsonl")}
    idx = json.loads((OUT / "index.json").read_text())
    rng = np.random.default_rng(0)
    clips = [idx["clips"][i] for i in sorted(rng.choice(len(idx["clips"]), min(a.n, len(idx["clips"])), replace=False))]
    m = load_keras()
    agree, ours_right, tfl_right, n_sign = 0, 0, 0, 0
    for c in clips:
        lg = islr1st.predict_logits(m, [islr1st.load_raw(ROOT / c["raw"])])[0]
        top = i2s[int(np.argmax(lg))]
        agree += top == tfl[c["clip_id"]]["top250"]
        truth = c["gislr_sign"] if c["oov"] else {"THANK-YOU": "thankyou"}.get(c["label"], c["label"].lower())
        ours_right += top == truth
        tfl_right += tfl[c["clip_id"]]["top250"] == truth
        n_sign += 1
    out = {"n_clips": len(clips), "top1_agreement_with_tflite": round(agree / len(clips), 4),
           "port_seed42_top1_250way": round(ours_right / n_sign, 4), "tflite_top1_250way": round(tfl_right / n_sign, 4)}
    (OUT / "port_check.json").write_text(json.dumps(out, indent=1))
    print(out)


if __name__ == "__main__":
    main()
