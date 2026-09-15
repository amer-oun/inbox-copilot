-- Audit trail for mailbox connect and disconnect.
--
-- Note what is NOT here: a foreign key from "MailAccountEvent"."mailAccountId" to
-- "MailAccount". One would cascade, and the disconnect record would be deleted by the
-- very delete it exists to document. The only FK is to "User".

-- CreateEnum
CREATE TYPE "MailAccountEventKind" AS ENUM ('CONNECTED', 'RECONNECTED', 'DISCONNECTED');

-- CreateTable
CREATE TABLE "MailAccountEvent" (
    "id" TEXT NOT NULL,
    "kind" "MailAccountEventKind" NOT NULL,
    "userId" TEXT NOT NULL,
    "mailAccountId" TEXT NOT NULL,
    "provider" "MailProviderType" NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "requestId" TEXT,
    "grantRevoked" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailAccountEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailAccountEvent_userId_createdAt_idx" ON "MailAccountEvent"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "MailAccountEvent_mailAccountId_idx" ON "MailAccountEvent"("mailAccountId");

-- AddForeignKey
ALTER TABLE "MailAccountEvent" ADD CONSTRAINT "MailAccountEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
