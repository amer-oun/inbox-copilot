-- AlterTable
ALTER TABLE "MailAccount" ADD COLUMN     "backfillCursor" TEXT,
ADD COLUMN     "backfillPageToken" TEXT;
