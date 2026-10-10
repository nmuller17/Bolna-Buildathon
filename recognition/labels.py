"""Classifier labels, in the order of docs/vocabulary.md section 3 (22 classes)."""

CLASSES = [
    "YES", "NO", "RESERVATION", "NAME", "THANK-YOU", "WHERE", "ELEVATOR",
    "FS-WIFI", "PASSWORD", "BREAKFAST", "TIME", "TOWEL", "MORE", "FS-CHECKOUT",
    "LATE", "PLEASE", "PARKING", "TAXI", "HELP", "ROOM", "RESTAURANT", "NONE",
]
NONE = "NONE"
INDEX = {c: i for i, c in enumerate(CLASSES)}
