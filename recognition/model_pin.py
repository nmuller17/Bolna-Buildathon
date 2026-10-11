"""SHA-256 of the one checkpoint the server and Recognizer may load (None = not pinned yet).

Set at the H13 freeze with `python -m recognition.pin_model recognition/models/model.pt`
and commit this file. Deliberately a constant in git: never read from the models folder,
no environment override.
"""
EXPECTED_SHA256 = '82b8ed54573dc7e41f0de6c60896f632b17155e0018b0fca50c8edc0e8d525b3'
