# Procucev Speech to Text

An MVP for the Procucev AI Tech Hiring Assignment. It provides low-latency multilingual browser transcription, a relational transcription history, and CRUD operations from a single dashboard.

## Run locally

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000. For the quick demo, open the URL in Chrome or Edge rather than the Codex embedded browser: the embedded browser exposes the Speech Recognition API but its remote speech service currently returns a `network` error. Hindi/English mixed speech can be captured with `English + Indian accents`; switch to Hindi when primarily speaking Hindi.

## Architecture and production path

- `app/main.py` contains the FastAPI API, SQLAlchemy model, and CRUD endpoints.
- `app/static/app.js` contains the live recognition UI and history dashboard.
- SQLite is the default relational database. Set `DATABASE_URL` to a PostgreSQL connection string for deployment.
- The `/api/transcribe-audio` endpoint forwards the recorded WebM audio to a self-hosted Whisper/faster-whisper service. Set `WHISPER_URL`, for example `WHISPER_URL=http://localhost:9000/transcribe`, and have that service return JSON such as `{ "text": "Namaste, how are you?" }`. When configured, the returned text is inserted into the transcript area after recording stops.
- Gemini Live is available as a dashboard provider when `GEMINI_API_KEY` is set. Install the main requirements, set `GEMINI_API_KEY`, restart the app, and choose **Gemini Live** from the transcription engine selector. The server creates a short-lived token and the browser streams raw 16-bit PCM audio directly to Gemini. The default dedicated transcription model is `gemini-3.5-transcribe-live`; set `GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview` only when you specifically need the 3.1 live preview model.
- To run the optional Whisper service locally, install its dependencies and start it with `.\.venv\Scripts\python.exe -m pip install -r requirements-whisper.txt` followed by `.\.venv\Scripts\python.exe -m uvicorn whisper_service:app --host 0.0.0.0 --port 9000`.
- Without Chrome/Edge speech recognition or `WHISPER_URL`, the app can capture microphone audio but no engine exists to turn audio into words. The UI now reports this explicitly instead of silently leaving the transcript blank.

## API

- `GET /api/transcriptions`
- `POST /api/transcriptions`
- `PATCH /api/transcriptions/{id}`
- `DELETE /api/transcriptions/{id}`
- `GET /health`

## Deployment checklist

Deploy the FastAPI service to Render, Railway, Fly.io, or any container host, attach managed PostgreSQL, set `DATABASE_URL`, and use HTTPS because browser microphone recognition is restricted on insecure origins. Add authentication and migrations before production use.
