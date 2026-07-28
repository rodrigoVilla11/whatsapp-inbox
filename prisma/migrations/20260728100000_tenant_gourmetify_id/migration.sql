-- Provisioning desde Gourmetify: cada cliente del SaaS mapea a un tenant
-- del inbox por su id de Gourmetify (idempotencia del alta).
ALTER TABLE "Tenant" ADD COLUMN "gourmetifyTenantId" TEXT;
CREATE UNIQUE INDEX "Tenant_gourmetifyTenantId_key" ON "Tenant"("gourmetifyTenantId");
