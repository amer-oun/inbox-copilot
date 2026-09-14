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

## AI in development (no API key needed)

The AI layer talks to a local stub unless you give it a key. `pnpm dev` starts it
alongside the api and worker; the whole enrich path — prompts, tool definitions,
schema validation, content-hash cache, usage ledger, `ai.enrich` queue — runs
unchanged, and nothing leaves the machine.

```bash
pnpm dev                    # api + worker + ai stub (port AI_STUB_PORT, default 4010)
pnpm ai:sweep               # enqueue every message that has no classification
pnpm ai:sweep --limit=10    # ...at most 10 per user
pnpm ai:sweep --email=you@example.com
pnpm ai:sweep --force       # ignore the remaining daily cap budget
pnpm ai:stub                # the stub on its own
```

Watch it land: `pnpm db:studio`, then `AiClassification`, `AiSummary`, `AiUsage`, and
the denormalized `category`/`priority`/`priorityScore`/`language` on `Thread`.

Stubbed output is labelled, not disguised. Every startup logs `AI calls are STUBBED`,
and each summary begins `[stubbed summary]`. Its categories are keyword heuristics
over the subject and sender — deterministic, ignorant of instruction text in bodies
(`devtools/aiStub.ts`), and **not** a signal of model quality.

**Switching to the real API:** put a key in `ANTHROPIC_API_KEY` and restart. That is
the whole switch — the stub refuses to start when a real key is set, and the client
logs `AI calls go to the Anthropic API`. `ANTHROPIC_BASE_URL` overrides both (a
gateway, or a stub on another host). In production, no key and no base URL is a
startup error rather than a silent fallback, and a stub endpoint is refused outright.

Already-stubbed rows are keyed by `contentHash` like any other, so they will be
served from cache rather than re-asked. To re-enrich with the real model, delete the
`AiClassification`/`AiSummary` rows (they are a cache, not a source of truth) and run
`pnpm ai:sweep`.

## Unenriched messages

Enrichment is two calls — classify, then summarize the thread — so it can be left
half-done: a spent daily cap, AI switched off, a dead worker, or a mailbox synced
before this phase existed. `services/ai/sweep.ts` looks for both halves:

- messages with no `AiClassification` row;
- threads over the summary threshold with no `AiSummary` row. This one is raw SQL,
  because "a body over 1500 characters" is a string-length predicate Prisma cannot
  express — and skipping it would find almost nothing, since a real mailbox is mostly
  single-message threads. Its tenancy predicate is therefore written out by hand.

Each batch is trimmed to the user's remaining daily budget, counted in messages rather
than calls, so a run can exceed a small cap by the number of summaries in flight (a
cap of 10 measured 14 calls; at the default 500 the overshoot is noise). The cap check
inside every call is the hard stop.

It runs every 30 minutes on the worker and on demand via `pnpm ai:sweep`.

## Rendering email HTML

Three independent layers, because each is assumed to fail:

1. **Sanitize** (`apps/api/src/services/security/sanitize.ts`). DOMPurify with a
   narrow allowlist, applied on read rather than on write — the stored row keeps what
   the sender sent, and only cleaned HTML crosses the wire. The DTO field is called
   `bodyHtmlSanitized` so nothing downstream can reach for raw HTML: there is none.
   Remote sources are *moved* to `data-blocked-*`, not deleted, so click-to-load has
   something to restore and the UI can count what is waiting.
2. **Sandbox** (`apps/web/lib/emailFrame.ts`). The body renders in an iframe with
   `sandbox="allow-popups allow-popups-to-escape-sandbox"` — no scripts, no
   same-origin, no forms, no top navigation. Popups are the one concession, and only
   so that clicking a link works.
3. **CSP inside the frame**: `default-src 'none'`, and `img-src` stays `data:` until
   the reader asks for images. That is what makes "images blocked" true rather than
   decorative, and it is why a tracking pixel cannot report that a message was opened.

The frame does not auto-size. Measuring content height needs script *inside* the
frame, and `allow-scripts` is the flag this app will not grant to sender-authored
HTML — so the frame scrolls and the reader can expand it.

When changing `ALLOWED_URI_REGEXP`, add presentational attributes to
`ADD_URI_SAFE_ATTR` too: DOMPurify URI-checks every attribute that is not on that
list, so a strict regexp silently deletes `bgcolor="#ffffff"` and `width="600"`.

## Known: dev mode puts server secrets in the RSC payload

In `next dev` only, React 19's async debug info serializes awaited server values into
the Flight stream — including the internal JWT minted by `lib/apiClient.ts` and the
Auth.js session row. Verified absent from `next build && next start` output. The
browser already holds its own session cookie and the JWT lives 60 seconds, so the
practical gain to an attacker is nil, but do not screen-share or record dev
`view-source` output, and do not mistake it for a production leak.

## Replies, composing and sending

Three operations, deliberately unable to reach each other:

```
POST /threads/:id/replies   → 3 ReplyDraft rows. Sends nothing.
POST /threads/:id/reply     → sends the body in the request. Calls no model.
POST /compose               → subject + body as text. Sends nothing.
```

There is no endpoint that sends a stored draft by id, and no flag that sends a
generated one — so the only path from model output to a mailbox runs through a person
reading it in the composer and posting it back (rule 1). The reply tool's schema has
two fields per draft, `label` and `body`: a model that decides to mail a third party
has nowhere to put the address. Recipients are computed in `services/send.ts` from the
parent message's headers, and the thread read returns that same computation as
`replyRecipients` so the composer shows the address the send will actually use.

`sendMessage` is the one Gmail call that does **not** retry (`callOnce` in
`providers/gmail/client.ts`). A 429 or a 502 does not say whether the message went
out, and a retry that guesses wrong sends the user's mail twice. `createDraft` does
retry — a duplicated draft is deletable.

Threading is `In-Reply-To` + `References` from the parent's `internetMessageId` and
its stored `references` header, plus Gmail's own `threadId`. `services/send.ts` owns
the chain and ends it with the parent; the provider appends the parent only if the
caller did not (`appendParent`). Both layers appending is how a real send produced
`References: <parent> <parent>`. The threadId alone groups
the reply in *this* mailbox only; every other participant's client threads on the
headers. MIME is built in `providers/gmail/mime.ts` — the one place that writes
headers, so header-injection checks live there once. Long values are folded, and the
fold-aware check is why `assertFoldedHeaderSafe` exists.

The sent message is **not** written to `Message`. The sync engine owns that table and
the next delta brings the real row with the provider's ids; a row fabricated at send
time would be a second source of truth about what was sent.

## Writing style profile

`services/ai/style.ts` samples ~30 of the user's own sent messages and writes
`UserWritingStyle`, which is injected into every reply and compose prompt. §5 calls it
the main quality lever, and the difference is visible: without it a draft is competent
and anonymous.

Split by what each half is good at — sentence length and emoji use are *counted* from
the samples, while greeting, sign-off, register and the free-form descriptor are the
model's judgment. Quoted text is stripped before sampling (`stripQuotedText`), for
quality (a quoted original is somebody else's voice) and for safety: a reply quotes the
message it answers, so that is how an attacker's text would otherwise reach the prompt
that shapes every future draft. The descriptor is defanged like mail content when
injected, because it is derived from text we did not write.

It runs on the `ai.style` queue when a backfill finishes, and on demand:

```bash
curl -X POST .../writing-style?force=true   # rebuild now, ignoring the 30-day age check
```

Fewer than three usable samples writes **nothing** — not even an empty row. The reply
prompt asks whether a profile exists, and an empty one would be followed as a
description of a writer nobody has read.

## Real-time sync (Gmail push)

Gmail does not call us: it publishes to a Pub/Sub topic, and a push subscription calls
`POST /webhooks/gmail` with a Google-signed OIDC token. Setting that up in Google Cloud
— including how to test it from a laptop Google cannot reach — is
**docs/gmail-push-setup.md**. Without `GMAIL_PUBSUB_TOPIC` the app runs fine, just not in
real time.

**A push is a trigger, never data.** The webhook verifies the token (signature, issuer,
audience, our service account), decodes the payload far enough to know *which mailbox*,
and enqueues a delta. The history id it carries is logged and discarded: believing it
would let whoever can publish to the topic decide how far back we read, or skip history
we never fetched. Everything written comes from an authenticated Gmail read we initiate.
So the worst a compromised topic achieves is making us re-read a mailbox we already have
access to.

**Bursts collapse.** Gmail publishes one notification per change, so a four-message
thread arrives as four pushes. The mailbox id is the delta job's id *and* its dedup key,
with a 2-second delay: the first push queues a delayed job, the rest land on the same id
and do nothing. Measured on a real mailbox: five pushes, one sync.

**The cursor advances last.** Only after every thread a delta touched has committed, and
only to the value the provider reported for that window. A crash halfway is a replay, and
every write is idempotent on `(mailAccountId, providerMessageId)` — so a replay is a
no-op. When a delta defers threads (more than 40 changed at once) the cursor does not
move at all: their changes are inside that window.

**Enrichment is queued for new *inbound* messages only.** New, because a label change
re-fetches the whole thread and re-enriching it would pay for classifications we already
hold — which is why `syncOneThread` asks which messages exist *before* upserting them.
Inbound, because classifying the user's own sent mail would put a priority score and
"needs reply" on their own words.

## When sync goes quiet

Two failures matter, and neither announces itself — an inbox with no new mail looks
exactly like a working one.

1. **The watch expired.** Gmail's watch lasts seven days. `services/watch.ts` renews any
   with less than two days left, so a renewal has to fail repeatedly before push lapses.
2. **The watch is live but notifications are not arriving** — a deleted subscription, a
   revoked topic permission, our endpoint failing for an hour. Nothing in our own data
   says so; the only symptom is silence. So the keeper also queues a catch-up delta for
   any mailbox that has not synced in an hour, whatever its `watchExpiresAt` says.

The keeper runs **hourly**, not daily. Renewal only needs a daily cadence, but
discovering a lapse within an hour rather than a day is the difference between a gap and
an outage; when nothing is wrong the run is one indexed query.

**An expired cursor is a re-sync, not an error.** `history.list` answers 404 for a
`startHistoryId` older than about a week. That is a `SyncCursorExpiredError` (mapped in
the Gmail client, not left as a bare 404), and the delta worker clears the cursor and
queues a full backfill — because a mailbox that cannot catch up incrementally must not be
left quietly frozen. Verified on the real mailbox by forcing `syncCursor` to `1`: cursor
cleared → backfill → (it hit a Gmail rate limit, went to ERROR, retried on its own
curve) → ACTIVE with a fresh cursor, 63 threads and no duplicates.

## Current phase
> Phase 7 — Real-time sync: DONE for Gmail. `startWatch`/`stopWatch` in
> `GmailProvider`, `POST /webhooks/gmail` (`routes/webhooks.ts` + `lib/pubsub.ts`),
> `services/deltaSync.ts` (the `sync.delta` job), `services/watch.ts` (the hourly
> `sync.watch` keeper), and the Google Cloud setup in `docs/gmail-push-setup.md`.
> Read "Real-time sync (Gmail push)" and "When sync goes quiet" above before touching
> any of it.
> Verified live end to end against the real mailbox with the development token: five
> pushes collapsed into one delta, 6 changes read from the stored cursor, 4 threads and
> 6 messages written, 0 enriched (all outbound), cursor advanced only afterwards. The
> expired-cursor fallback was verified by forcing a stale cursor. Not yet verified: a
> genuine Pub/Sub delivery, which needs the Google Cloud setup and a public URL.
> Next: Phase 8 — Outlook. The `MailProvider` port is the seam; Graph subscriptions
> replace Gmail watches and `deltaLink` replaces the history id, behind the same
> interface.
> Update this line as we progress.
