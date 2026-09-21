import { Prisma } from "../generated/client/index.js";

/**
 * Rule 4: every query filters by userId. This extension enforces it mechanically
 * so a forgotten `where` clause cannot leak another user's mail.
 *
 * Each model declares how it reaches a User:
 *   - "self"   the model *is* the user row  -> filter on `id`
 *   - "direct" the model has a `userId`     -> filter on `userId`
 *   - "path"   reachable through relations  -> filter on the nested relation path
 *   - "global" not tenant-scoped at all     -> left alone
 */
type TenancyRule =
  | { kind: "self" }
  | { kind: "direct" }
  | { kind: "path"; path: readonly string[] }
  | { kind: "global" };

const TENANCY: Readonly<Record<string, TenancyRule>> = {
  User: { kind: "self" },
  Account: { kind: "direct" },
  Session: { kind: "direct" },
  VerificationToken: { kind: "global" },

  MailAccount: { kind: "direct" },
  /*
   * Direct, not path-scoped through MailAccount — it has no relation to one, on
   * purpose, so that a disconnect record outlives the mailbox it records (see the
   * model's own comment). `userId` is what scopes it.
   */
  MailAccountEvent: { kind: "direct" },
  UserWritingStyle: { kind: "direct" },
  UserSettings: { kind: "direct" },
  AiUsage: { kind: "direct" },
  ScheduledEmail: { kind: "direct" },
  FollowUpReminder: { kind: "direct" },

  Thread: { kind: "path", path: ["mailAccount"] },
  Message: { kind: "path", path: ["mailAccount"] },
  Attachment: { kind: "path", path: ["message", "mailAccount"] },
  AiSummary: { kind: "path", path: ["thread", "mailAccount"] },
  ReplyDraft: { kind: "path", path: ["thread", "mailAccount"] },
  AiClassification: { kind: "path", path: ["message", "mailAccount"] },
  // Direct rather than path-scoped through Message, even though it has both: the
  // appeal is a statement *by a user*, and stamping `userId` on create is what
  // makes "who said this was safe" a fact the row cannot be born without.
  ThreatAppeal: { kind: "direct" },
  Translation: { kind: "path", path: ["message", "mailAccount"] },
};

/** Operations that accept a `where` we can narrow. */
const FILTERED_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);

/** Operations that write new rows and therefore need `userId` stamped on. */
const CREATE_OPS = new Set(["create", "createMany", "createManyAndReturn"]);

function tenantFilter(rule: TenancyRule, userId: string): Record<string, unknown> {
  switch (rule.kind) {
    case "self":
      return { id: userId };
    case "direct":
      return { userId };
    case "path": {
      // ["message", "mailAccount"] -> { message: { mailAccount: { userId } } }
      let filter: Record<string, unknown> = { userId };
      for (let i = rule.path.length - 1; i >= 0; i--) {
        filter = { [rule.path[i] as string]: filter };
      }
      return filter;
    }
    case "global":
      return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the tenancy extension for one user. Apply it once per request:
 *
 *   const db = prisma.$extends(tenancyExtension(session.userId));
 *   await db.thread.findMany();   // implicitly scoped to that user
 */
export function tenancyExtension(userId: string) {
  if (!userId) {
    throw new Error("tenancyExtension requires a userId");
  }

  return Prisma.defineExtension({
    name: "tenancy",
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          const rule = TENANCY[model];
          if (!rule || rule.kind === "global") {
            return query(args);
          }

          // The arg union across every model/operation is not indexable, so
          // widen once and narrow structurally.
          const raw: unknown = args;
          if (!isRecord(raw)) {
            return query(args);
          }

          if (FILTERED_OPS.has(operation)) {
            const existing = isRecord(raw["where"]) ? raw["where"] : {};
            return query({
              ...raw,
              where: { ...existing, ...tenantFilter(rule, userId) },
            } as typeof args);
          }

          // create/upsert: stamp the owner so a row can never be born orphaned.
          if (CREATE_OPS.has(operation) || operation === "upsert") {
            if (rule.kind !== "direct") {
              return query(args);
            }
            return query(stampUserId(raw, operation, userId) as typeof args);
          }

          return query(args);
        },
      },
    },
  });
}

function stampUserId(
  args: Record<string, unknown>,
  operation: string,
  userId: string,
): Record<string, unknown> {
  if (operation === "upsert") {
    const where = isRecord(args["where"]) ? args["where"] : {};
    const create = isRecord(args["create"]) ? args["create"] : {};
    return {
      ...args,
      where: { ...where, userId },
      create: { ...create, userId },
    };
  }

  const data = args["data"];
  if (Array.isArray(data)) {
    return {
      ...args,
      data: data.map((row) => (isRecord(row) ? { ...row, userId } : row)),
    };
  }
  if (isRecord(data)) {
    return { ...args, data: { ...data, userId } };
  }
  return args;
}
