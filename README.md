# CamelHack: Two-Way Sign Language Translator (Hotel Reception)

Live translation between a hearing hotel receptionist (spoken English) and a Deaf guest (ASL) on an iPad.
See [Directions.md](Directions.md) for the full workflow.

## Quick start
1. `cd backend && pip install -r requirements.txt`
2. Copy `.env.example` to `.env` and add your Anthropic API key
3. `python ../scripts/download_models.py`
4. `uvicorn main:app --reload`
5. Open `frontend/index.html` in Safari on the iPad
