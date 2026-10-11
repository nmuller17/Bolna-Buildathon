"""Print a checkpoint's SHA-256 and pin it in recognition/model_pin.py (commit that file).

    python -m recognition.pin_model recognition/models/model.pt           # print + pin
    python -m recognition.pin_model recognition/models/model.pt --print   # print only
    python -m recognition.pin_model --unpin
"""
import argparse
import hashlib
import re
from pathlib import Path

PIN_FILE = Path(__file__).parent / "model_pin.py"


def file_sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_pin(digest, pin_file=PIN_FILE):
    """Rewrite the EXPECTED_SHA256 line of model_pin.py (digest = 64 hex chars, or None)."""
    if digest is not None and not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("not a SHA-256 hex digest")
    pin_file = Path(pin_file)
    text = pin_file.read_text()
    new, n = re.subn(r"(?m)^EXPECTED_SHA256 = .*$", f"EXPECTED_SHA256 = {digest!r}", text)
    if n != 1:
        raise ValueError(f"{pin_file} has no single EXPECTED_SHA256 line")
    pin_file.write_text(new)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("checkpoint", nargs="?")
    ap.add_argument("--print", dest="print_only", action="store_true", help="print the hash, do not pin it")
    ap.add_argument("--unpin", action="store_true", help="set EXPECTED_SHA256 back to None")
    args = ap.parse_args(argv)
    if args.unpin:
        write_pin(None)
        print(f"unpinned ({PIN_FILE})")
        return
    if not args.checkpoint:
        ap.error("give a checkpoint path (or --unpin)")
    digest = file_sha256(args.checkpoint)
    print(digest)
    if not args.print_only:
        write_pin(digest)
        print(f"pinned in {PIN_FILE}; commit it, and share exactly this model.pt with whoever runs the server")


if __name__ == "__main__":
    main()
