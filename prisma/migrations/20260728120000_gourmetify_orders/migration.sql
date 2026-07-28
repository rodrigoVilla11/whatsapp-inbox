-- Pedidos de Gourmetify espejados en el inbox (ingesta por webhook):
-- contexto del pedido + estado en vivo al lado del chat.
CREATE TABLE "GourmetifyOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "gourmetifyOrderId" TEXT NOT NULL,
    "contactId" TEXT,
    "customerPhone" TEXT NOT NULL,
    "number" TEXT,
    "statusLabel" TEXT NOT NULL,
    "statusKind" TEXT NOT NULL,
    "summary" TEXT,
    "totalLabel" TEXT,
    "deliveryLabel" TEXT,
    "scheduledLabel" TEXT,
    "orderCreatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GourmetifyOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GourmetifyOrder_tenantId_gourmetifyOrderId_key"
    ON "GourmetifyOrder"("tenantId", "gourmetifyOrderId");
CREATE INDEX "GourmetifyOrder_tenantId_contactId_idx"
    ON "GourmetifyOrder"("tenantId", "contactId");
CREATE INDEX "GourmetifyOrder_tenantId_customerPhone_idx"
    ON "GourmetifyOrder"("tenantId", "customerPhone");

ALTER TABLE "GourmetifyOrder" ADD CONSTRAINT "GourmetifyOrder_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
