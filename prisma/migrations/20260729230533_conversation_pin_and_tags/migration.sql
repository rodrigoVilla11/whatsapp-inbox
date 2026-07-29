-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "pinnedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'piedra',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationTag" (
    "conversationId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationTag_pkey" PRIMARY KEY ("conversationId","tagId")
);

-- CreateIndex
CREATE INDEX "Tag_tenantId_name_idx" ON "Tag"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_tenantId_slug_key" ON "Tag"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "ConversationTag_tenantId_tagId_idx" ON "ConversationTag"("tenantId", "tagId");

-- CreateIndex
CREATE INDEX "ConversationTag_tenantId_conversationId_idx" ON "ConversationTag"("tenantId", "conversationId");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_pinnedAt_idx" ON "Conversation"("tenantId", "pinnedAt" DESC);

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTag" ADD CONSTRAINT "ConversationTag_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTag" ADD CONSTRAINT "ConversationTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
