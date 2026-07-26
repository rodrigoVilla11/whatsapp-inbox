-- Búsqueda de conversaciones (GET /conversations?q=): ILIKE '%q%' sobre
-- profileName / phoneE164 / waId. Un LIKE con comodín inicial no usa
-- índices btree — trigram (pg_trgm) es el índice que sí lo sirve.
-- No se expresa en schema.prisma (Prisma no modela operator classes),
-- por eso vive solo como SQL.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "Contact_profileName_trgm_idx" ON "Contact" USING GIN ("profileName" gin_trgm_ops);
CREATE INDEX "Contact_phoneE164_trgm_idx" ON "Contact" USING GIN ("phoneE164" gin_trgm_ops);
CREATE INDEX "Contact_waId_trgm_idx" ON "Contact" USING GIN ("waId" gin_trgm_ops);
