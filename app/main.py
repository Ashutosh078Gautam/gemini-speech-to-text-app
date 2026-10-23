from datetime import datetime, timezone
from pathlib import Path
from typing import Generator

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import httpx
from pydantic import BaseModel, ConfigDict
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import DateTime, Integer, String, Text, create_engine, desc, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")
    database_url: str = "sqlite:///./speech_to_text.db"
    whisper_url: str | None = None
    gemini_api_key: str | None = None
    gemini_live_model: str = "gemini-3.5-transcribe-live"


settings = Settings()
connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


class Transcription(Base):
    __tablename__ = "transcriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str] = mapped_column(String(32), default="auto")
    duration_seconds: Mapped[float | None] = mapped_column(nullable=True)
    source: Mapped[str] = mapped_column(String(32), default="browser")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class TranscriptionCreate(BaseModel):
    text: str
    language: str = "auto"
    duration_seconds: float | None = None
    source: str = "browser"


class TranscriptionUpdate(BaseModel):
    text: str | None = None
    language: str | None = None


class TranscriptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    text: str
    language: str
    duration_seconds: float | None
    source: str
    created_at: datetime
    updated_at: datetime


Base.metadata.create_all(engine)
app = FastAPI(title="Procucev Speech to Text", version="1.0.0")
static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=static_dir), name="static")


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@app.get("/", include_in_schema=False)
def home():
    return FileResponse(static_dir / "index.html")


@app.get("/health")
def health():
    return {"status": "ok", "service": "speech-to-text", "providers": {"whisper": bool(settings.whisper_url), "gemini": bool(settings.gemini_api_key)}}


@app.get("/api/providers")
def providers():
    return {
        "browser": {"available": True, "label": "Browser Speech Recognition"},
        "whisper": {"available": bool(settings.whisper_url), "label": "Self-hosted Whisper"},
        "gemini": {"available": bool(settings.gemini_api_key), "label": "Gemini Live", "model": settings.gemini_live_model},
    }


@app.post("/api/gemini/session")
def create_gemini_session():
    """Issue a short-lived Gemini Live token without exposing the API key."""
    if not settings.gemini_api_key:
        raise HTTPException(503, "Gemini is not configured. Set GEMINI_API_KEY and restart the server.")
    try:
        from datetime import timedelta
        from google import genai

        client = genai.Client(api_key=settings.gemini_api_key)
        now = datetime.now(timezone.utc)
        token = client.auth_tokens.create(config={
            "uses": 1,
            "expire_time": now + timedelta(minutes=30),
            "new_session_expire_time": now + timedelta(minutes=1),
            "live_connect_constraints": {
                "model": settings.gemini_live_model,
                "config": {"response_modalities": ["TEXT"], "input_audio_transcription": {"language_codes": []}},
            },
        })
        return {"token": token.name, "model": settings.gemini_live_model}
    except Exception as exc:
        raise HTTPException(502, f"Gemini session creation failed: {type(exc).__name__}: {exc}") from exc


@app.get("/api/transcriptions", response_model=list[TranscriptionOut])
def list_transcriptions(db: Session = Depends(get_db)):
    return list(db.scalars(select(Transcription).order_by(desc(Transcription.created_at))))


@app.post("/api/transcriptions", response_model=TranscriptionOut, status_code=201)
def create_transcription(payload: TranscriptionCreate, db: Session = Depends(get_db)):
    text = payload.text.strip()
    if not text:
        raise HTTPException(400, "Transcription text cannot be empty")
    item = Transcription(text=text, language=payload.language, duration_seconds=payload.duration_seconds, source=payload.source)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@app.patch("/api/transcriptions/{item_id}", response_model=TranscriptionOut)
def update_transcription(item_id: int, payload: TranscriptionUpdate, db: Session = Depends(get_db)):
    item = db.get(Transcription, item_id)
    if not item:
        raise HTTPException(404, "Transcription not found")
    if payload.text is not None:
        if not payload.text.strip():
            raise HTTPException(400, "Transcription text cannot be empty")
        item.text = payload.text.strip()
    if payload.language is not None:
        item.language = payload.language
    db.commit()
    db.refresh(item)
    return item


@app.delete("/api/transcriptions/{item_id}", status_code=204)
def delete_transcription(item_id: int, db: Session = Depends(get_db)):
    item = db.get(Transcription, item_id)
    if not item:
        raise HTTPException(404, "Transcription not found")
    db.delete(item)
    db.commit()


@app.post("/api/transcribe-audio")
async def transcribe_audio(file: UploadFile = File(...)):
    """Integration seam for a self-hosted Whisper/faster-whisper service.

    The browser UI uses Web Speech for low-latency interim words. Deployments can
    set WHISPER_URL to forward recorded audio here to a local model service.
    """
    if not settings.whisper_url:
        raise HTTPException(503, "No Whisper service configured. Set WHISPER_URL to enable audio transcription.")
    audio = await file.read()
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                settings.whisper_url,
                files={"file": (file.filename or "audio.webm", audio, file.content_type or "audio/webm")},
            )
            if response.is_error:
                detail = response.text[:1000]
                raise HTTPException(502, f"Whisper service returned {response.status_code}: {detail}")
        return response.json()
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"Whisper service request failed: {exc}") from exc

