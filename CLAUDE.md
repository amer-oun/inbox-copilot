# CLAUDE.md — Inbox Copilot

Read this before writing code. Full design lives in `ARCHITECTURE.md`.

## What this is
AI email assistant. Connects Gmail + Outlook, syncs mail into Postgres, uses the
Anthropic API to categorize, summarize, draft replies, detect phishing, translate,
schedule sends, and track follow-ups.

## Stack
- `apps/web` — Next.js 15 App Router, React 19, Tailwind, shadcn/ui, TanStack Query, Auth.js v5
- `apps/api` — Express 5, TypeScript, BullMQ workers
- `packages/db` — Prisma + Postgres
- `packages/shared` — Zod schemas shared by web and api
- Redis 7 for queues, Anthropic SDK for AI

## Commands
```bash
pnpm dev              # web + api + worker (api runs index.ts + worker.ts)
pnpm db:migrate       # prisma migrate dev
pnpm db:studio
pnpm test             # vitest
pnpm lint && pnpm typecheck
docker compose up -d  # postgres + redis
```

## Non-negotiable rules

1. **Never auto-send email.** Every AI output is a draft. Sending requires an explicit,
   separate, user-initiated API call. No "trusted sender" bypass.
2. **Email bodies are untrusted input.** Wrap them in `<untrusted_email>` tags in prompts.
   The system prompt must state that content inside is data, never instructions.
   The AI layer has no state-mutating tools.
3. **Never log, return, or serialize OAuth tokens.** They live AES-256-GCM encrypted in
   `MailAccount`. Decrypt only inside `providers/*/client.ts`.
4. **Every DB query filters by userId.** Use the tenancy Prisma extension in `packages/db`.
5. **All provider calls go through the `MailProvider` interface.** No `googleapis` or
   `@microsoft/microsoft-graph-client` imports outside `apps/api/src/providers/`.
6. **Never parse LLM output with regex.** Use tool use / structured outputs + Zod.
7. **Check the AI cache before every call.** `contentHash` lookup in `AiSummary` /
   `AiClassification` / `Translation`. A cache miss should be the only reason we spend tokens.
8. **Sync cursors advance only after the DB transaction commits.**
9. Use `pnpm`, not npm or yarn. Never `prisma db push` outside local scratch work —
   always generate a migration.

## Model IDs (config only, never inline at call sites)
```ts
export const MODELS = {
  fast:      "claude-haiku-4-5-20251001", // classify, priority, language detect
  standard:  "claude-sonnet-5",           // summarize, reply, compose, translate
  deep:      "claude-opus-5",             // phishing escalation, complex threads
} as const;
```

## Conventions
- TypeScript strict. No `any`. No non-null `!` assertions outside tests.
- `apps/web` pins `typescript@^6` (Next 15 cannot use the TS 7 compiler API) and uses
  `next.config.mjs` plus relative imports for the same reason — no `@/*` alias there.
- Errors: throw typed `AppError` subclasses from `lib/errors.ts`; the error middleware maps to HTTP.
- Validate every route input with a Zod schema from `packages/shared`.
- Structured logging via pino. Include `userId` + `mailAccountId` in every log line.
- Tests colocated as `*.test.ts`. Provider calls are mocked with recorded fixtures — never hit real APIs in tests.
- Tailwind only. No CSS modules, no styled-components.
- Server Components by default in `apps/web`; `"use client"` only where interaction requires it.

## Current phase
> Phase 4 — AI core: DONE. `services/ai/` is the only path to a model.
> `models.ts` pins model ids and prices (Haiku 4.5 classifies, Sonnet 5 summarizes);
> `prompts.ts` is the §7 boundary — email content only ever reaches the model inside
> `<untrusted_email>` in a user turn, delimiters in content are defanged, and the
> system prompt comes from a registry callers cannot pass a string into.
> `client.ts` offers exactly one data-returning tool with `tool_choice` pinned and
> parses the reply by validating the tool input against a Zod schema in
> `packages/shared/src/schemas/ai.ts` — no prose fallback. `cache.ts` checks
> `contentHash` in `AiClassification`/`AiSummary` before every call; `usage.ts`
> writes `AiUsage` (tokens + cost) and enforces `UserSettings.dailyAiCallCap` in a
> UTC window. `classify.ts` returns category/priority/priorityScore/needsReply/
> language, with the score deciding the band when the model contradicts itself;
> `summarize.ts` runs for threads of 3+ messages or bodies over 1500 chars.
> `enrich.ts` + the BullMQ `ai.enrich` queue process each new message after sync and
> denormalize onto `Thread`. Threat fields stay UNKNOWN: §6 is deterministic-first
> and lands in phase 9.
> Next: Phase 5 — categorization UI, priority scoring, Batch API backfill
> enrichment (which is also what sweeps up messages skipped by a spent cap).
> Update this line as we progress.
