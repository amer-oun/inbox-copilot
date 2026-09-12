/*
  Warnings:

  - You are about to drop the column `tokenAuthTag` on the `MailAccount` table. All the data in the column will be lost.
  - You are about to drop the column `tokenIv` on the `MailAccount` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "MailAccount" DROP COLUMN "tokenAuthTag",
DROP COLUMN "tokenIv",
ADD COLUMN     "accessTokenAuthTag" TEXT,
ADD COLUMN     "accessTokenIv" TEXT,
ADD COLUMN     "refreshTokenAuthTag" TEXT,
ADD COLUMN     "refreshTokenIv" TEXT,
ADD COLUMN     "tokenRefreshedAt" TIMESTAMP(3);
