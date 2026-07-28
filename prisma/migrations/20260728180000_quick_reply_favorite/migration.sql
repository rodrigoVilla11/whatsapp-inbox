-- Chips de respuestas rápidas: hasta 4 favoritas por tenant se muestran
-- como chips táctiles arriba del composer.
ALTER TABLE "QuickReply" ADD COLUMN "isFavorite" BOOLEAN NOT NULL DEFAULT false;
