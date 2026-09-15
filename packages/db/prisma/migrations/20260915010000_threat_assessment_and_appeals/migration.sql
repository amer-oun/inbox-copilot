-- Phase 9: layered phishing detection.
--
-- Additive only. The threat columns on "AiClassification" already existed (phase 4
-- wrote UNKNOWN/0 into them); what is new is where the model's half of the verdict
-- goes, and a table for a user disagreeing with it.

-- AlterTable
ALTER TABLE "AiClassification" ADD COLUMN     "threatExplanation" TEXT,
ADD COLUMN     "threatIntent" TEXT,
ADD COLUMN     "threatModel" TEXT;

-- CreateTable
CREATE TABLE "ThreatAppeal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "claimedLevel" "ThreatLevel" NOT NULL,
    "claimedScore" INTEGER NOT NULL,
    "shownReasons" JSONB NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThreatAppeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ThreatAppeal_messageId_key" ON "ThreatAppeal"("messageId");

-- CreateIndex
CREATE INDEX "ThreatAppeal_userId_createdAt_idx" ON "ThreatAppeal"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "ThreatAppeal" ADD CONSTRAINT "ThreatAppeal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThreatAppeal" ADD CONSTRAINT "ThreatAppeal_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
