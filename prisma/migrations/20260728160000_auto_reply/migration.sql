-- Auto-respuesta fuera de horario: config por tenant (JSON, horarios en el
-- timezone del tenant), cooldown por conversación y marcador en el mensaje.
ALTER TABLE "Tenant" ADD COLUMN "autoReply" JSONB;
ALTER TABLE "Conversation" ADD COLUMN "lastAutoReplyAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "isAutoReply" BOOLEAN NOT NULL DEFAULT false;
