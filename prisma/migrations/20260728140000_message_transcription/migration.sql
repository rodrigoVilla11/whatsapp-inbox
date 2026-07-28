-- Transcripción de audios entrantes (Whisper vía Groq, bajo demanda).
ALTER TABLE "Message" ADD COLUMN "transcription" TEXT;
