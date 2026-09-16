-- Phase 10: scheduled send, follow-up reminders, translation.
--
-- Purely additive: three new columns and two nullable ones. `ScheduledEmail`,
-- `FollowUpReminder`, `Translation` and `UserSettings.followUpDays`/`translationLang`
-- all shipped in the phase-0 schema, so this migration is only what phase 10 found
-- missing while implementing them. Nothing here drops or rewrites a column.

-- `localSendAt` is the wall-clock time the user chose, kept beside the resolved
-- `sendAt` instant so a DST rule change is recoverable rather than an hour-late send.
-- Nullable rather than defaulted: a default would be a wall time nobody picked.
-- `expectsReply` drives the follow-up reminder created after a scheduled send lands.
-- `parentMessageId` is deliberately not a foreign key — see the model comment.
ALTER TABLE "ScheduledEmail" ADD COLUMN     "expectsReply" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "localSendAt" TEXT,
ADD COLUMN     "parentMessageId" TEXT;

-- So the digest can avoid naming the same overdue thread every morning.
ALTER TABLE "FollowUpReminder" ADD COLUMN     "digestSentAt" TIMESTAMP(3);

-- Opt-in, off by default: the digest is the only mail this application sends to the
-- user, and it should be something they asked for.
ALTER TABLE "UserSettings" ADD COLUMN     "followUpDigest" BOOLEAN NOT NULL DEFAULT false;
