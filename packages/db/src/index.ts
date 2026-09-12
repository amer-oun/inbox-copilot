export {
  prisma,
  dbForUser,
  pingDatabase,
  disconnectDatabase,
  type TenantDb,
} from "./client.js";
export { tenancyExtension } from "./tenancy.js";
export { Prisma, type PrismaClient } from "@prisma/client";
export type {
  User,
  Account,
  Session,
  MailAccount,
  Thread,
  Message,
  Attachment,
  AiSummary,
  AiClassification,
  AiUsage,
  ReplyDraft,
  Translation,
  UserWritingStyle,
  UserSettings,
  ScheduledEmail,
  FollowUpReminder,
} from "@prisma/client";
