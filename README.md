# Inbox Copilot

An AI assistant that sits on top of a real mailbox. It connects a Gmail account over
OAuth, syncs threads and messages into Postgres, and then does the reading for you:
every incoming message is categorized and priority-scored, long threads get a summary
with action items, suspicious mail is checked by three independent layers before
anything is said about it, and replies are drafted in a voice learned from mail you have
actually sent. It can also translate a message beside the original, hold a send until a
time you choose, and remind you when a message you expected an answer to has gone quiet.
What it will never do is send mail on its own — every generated word is a draft until a
person presses send.

Full design rationale is in **[ARCHITECTURE.md](ARCHITECTURE.md)**; the working rules
contributors are held to are in **[CLAUDE.md](CLAUDE.md)**.

> **Outlook is not implemented.** You can sign _in_ with a Microsoft account and the
> provider port has a place for it, but `mailProviderFor("OUTLOOK")` throws: there is no
> Graph sync, no delta cursor, no subscription. Gmail is the only mailbox that works end
> to end, and the Connect Outlook button is disabled rather than starting a flow that
> would take a grant and then fail.

## Features

| | |
|---|---|
| **Sync** | Gmail OAuth, 90-day backfill, incremental delta sync, real-time Pub/Sub push (optional), and an hourly keeper that notices a lapsed watch or a mailbox that has gone quiet |
| **Triage** | Category, priority and a 0–100 priority score per message; "needs reply"; detected language |
| **Summaries** | Thread-level headline, summary, key points and action items — one per thread, cached by content hash |
| **Phishing & spam** | Header truth (SPF/DKIM/DMARC alignment), then heuristics (lookalike domains, link text that disagrees with its href, raw-IP and punycode links, first-time senders), then the model. A user can appeal a verdict; the appeal is recorded and changes nothing |
| **Replies** | Three drafts per thread in your own writing style, sampled from ~30 of your sent messages |
| **Compose** | Subject and body from a prompt — as text, sent by nobody |
| **Translation** | Any message into a target language, shown _beside_ the original and labelled as machine translation |
| **Scheduled send** | Pick a wall-clock time and a timezone; a database row is the source of truth and a sweeper recovers the send if Redis loses the job |
| **Follow-ups** | Flag a message as expecting a reply and get reminded in N days — cancelled automatically the moment anything inbound lands on the thread. Optional digest email |
| **Safe rendering** | Sender HTML is sanitized, sandboxed in an iframe with no scripts, and served under a CSP that blocks remote images until you ask for them |

## Architecture on one screen

```
inbox-copilot/
├── apps/
│   ├── web/        Next.js 15 App Router, React 19, Tailwind, Auth.js v5.
│   │               Server Components by default. Never reads mail data from
│   │               Postgres — it calls the API through a BFF proxy route that
│   │               mints a 60-second internal JWT.
│   └── api/        Express 5. Two entrypoints from one codebase:
│                     src/index.ts   HTTP
│                     src/worker.ts  BullMQ consumers + repeatable jobs
├── packages/
│   ├── db/         Prisma schema, migrations, and the tenancy extension that
│   │               puts `userId` on every query.
│   ├── shared/     Zod schemas and DTOs both apps import — one definition of
│   │               every shape that crosses the wire.
│   └── config/     tsconfig bases, ESLint flat configs, Prettier config.
└── docker-compose.yml   Postgres 15 + Redis 7
```

**The provider port.** Everything upstream codes against one interface,
`apps/api/src/providers/mailProvider.ts` — list threads, get a thread, sync a delta,
send, draft, start a watch. `googleapis` is imported _only_ inside
`apps/api/src/providers/`, and ESLint enforces that. Gmail's shapes are flattened into
our `Thread`/`Message` rows in `providers/gmail/map.ts`, so no feature above the port
ever branches on which mailbox it is reading.

**The queue/worker split.** The HTTP process answers requests and enqueues; the worker
does everything slow or retryable. Nine queues, all BullMQ on Redis: `sync.backfill`,
`sync.delta`, `sync.watch`, `ai.enrich`, `ai.sweep`, `ai.style`, `schedule.send`,
`schedule.sweep`, `followup.check`. Job payloads are Zod-validated on both ends, because
a job outlives the deploy that enqueued it. Four repeatable jobs run on the worker's own
clock: the watch keeper (hourly), the enrichment sweep (30 minutes), the scheduled-send
sweeper (1 minute) and the follow-up check (15 minutes).

**The AI layer** (`apps/api/src/services/ai/`) is the only place a model is called, and
every call goes through one function. It resolves the model from a _tier_ rather than a
name; looks the answer up by content hash first; refuses to exceed the user's daily call
cap; sends a prompt from a registry with the email body wrapped in `<untrusted_email>`;
takes structured output back through tool use; validates it with Zod; and writes a usage
ledger row. Underneath that sits a **transport** port — Anthropic, Gemini, or the local
stub — which is a wire format and nothing else: no schema, no validation, no verdict, no
ledger. Adding a provider therefore cannot weaken any of the guarantees above it.

## Running it

**Prerequisites:** Node 20+, pnpm 12 (`corepack enable`), Docker, and a Google Cloud
project. No AI key is needed to get started.

```bash
git clone <this repo> && cd inbox-copilot
pnpm install

docker compose up -d                      # postgres + redis

cp .env.example .env
node scripts/generate-secrets.mjs >> .env # encryption key, JWT keypair, auth secrets
#   then paste your Google OAuth credentials into .env — see below

pnpm db:deploy                            # apply migrations
pnpm dev                                  # web :3000, api :4000, worker, ai stub :4010
```

Open <http://localhost:3000>, sign in, then **Settings → Connected mailboxes → Connect
Gmail**. The backfill starts immediately, and the sync status on that page says how far
it has got. Enrichment follows on the `ai.enrich` queue; watch the rows land with
`pnpm db:studio`.

Other commands:

```bash
pnpm test        # vitest. Everything is mocked — no test calls a real API
pnpm typecheck
pnpm lint        # eslint, per package, through turbo
pnpm format      # prettier --write .   (read "Formatting" below first)
pnpm build
pnpm db:migrate  # prisma migrate dev — always a migration, never `db push`
pnpm ai:sweep    # enqueue anything that was never enriched
pnpm verify:prisma # after a build: will the web app find Prisma's engine on Vercel?
```

### Google OAuth credentials

Two different things need Google credentials, and they are kept separate on purpose:
signing _in_ to the app never asks for access to your mail.

In the [Google Cloud console](https://console.cloud.google.com/), create a project,
enable the **Gmail API**, configure the OAuth consent screen as **External**, and add
yourself as a test user. Then under **APIs & Services → Credentials** create an _OAuth
client ID_ of type _Web application_ and register the redirect URIs:

```
http://localhost:3000/api/auth/callback/google    # sign-in  (Auth.js, apps/web)
http://localhost:4000/oauth/google/callback       # mailbox   (apps/api)
```

One client can serve both; put its id and secret into `.env` twice —
`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` for sign-in, and
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` for the mailbox flow. Sign-in asks for
`openid profile email` and nothing more; the Gmail scopes are requested later, when you
connect a mailbox, and the connect page says which. (The Microsoft equivalents exist in
`.env.example` and sign-in works, but see the note about Outlook above.)

Real-time push is optional and needs a Pub/Sub topic. The whole setup — including how to
drive it from a laptop Google cannot reach — is in
**[docs/gmail-push-setup.md](docs/gmail-push-setup.md)**. Without it mail still syncs,
just on the keeper's schedule rather than within seconds.

### Choosing an AI provider

`AI_PROVIDER` picks one of three. Left **empty**, the choice is inferred the way it was
before that variable existed: a key means the real API, and no key outside production
means the stub.

```bash
AI_PROVIDER=stub         # the development default. Nothing leaves the machine.
AI_PROVIDER=gemini       # needs GEMINI_API_KEY
AI_PROVIDER=anthropic    # needs ANTHROPIC_API_KEY
```

**The stub** is a local server that speaks the Anthropic wire format and answers with
canned, deterministic responses. `pnpm dev` starts it, and only when it is actually the
selected provider. The entire pipeline runs against it: prompts, tool definitions, schema
validation, the content-hash cache, the usage ledger, the queues. Its output is labelled
rather than disguised — every startup logs `AI calls are STUBBED` and every summary
begins `[stubbed summary]` — and it is refused in production. Its categories are keyword
heuristics over the subject line, so do not read them as a signal of anything.

**Gemini** is the free option. Take a key from
[Google AI Studio](https://aistudio.google.com/apikey), set `AI_PROVIDER=gemini` and
`GEMINI_API_KEY`, and restart. Gemini is used _only_ when named: a key sitting in `.env`
never silently redirects anything. Free-tier calls are priced at zero in the ledger while
their tokens are still counted, and you should expect rate limiting to interrupt any bulk
run — which is recoverable, because unfinished work is left visibly unfinished and the
next sweep finds it.

**Anthropic** is the same switch with `ANTHROPIC_API_KEY`. `ANTHROPIC_BASE_URL` overrides
everything, if you want a gateway.

Either way a feature asks for a _tier_ (`fast`, `standard`, `deep`) and the provider maps
it to its own pinned model id in `services/ai/models.ts` — never a `-latest` alias, since
the ledger records which model answered and an alias that moves under you makes every
historical row a guess.

Enriched rows are cached by content hash, so switching provider does not by itself re-run
anything. To re-assess a whole mailbox with the new one:

```bash
pnpm ai:sweep --email=you@example.com --force
```

### Formatting

Prettier is configured, but the repository has **not been reformatted yet**: it predates
the tool, and `pnpm format` currently rewrites about half the files. That reformat is
meant to land as its own commit, reviewed on its own, rather than hidden inside a change
that also does something. Until it does, `pnpm lint` deliberately does not check
formatting — a lint task people learn to ignore is worse than no lint task. Markdown is
left alone entirely, so hand-wrapped prose stays as its authors wrapped it.

## Deploying

Render for the API, Vercel for the web app, full walkthrough in
**[docs/deployment.md](docs/deployment.md)** — both services' environment variables, the
exact build and start commands for this pnpm/turbo monorepo, and the two Google OAuth
clients with their redirect URIs.

Three things from it that belong here rather than buried in a doc:

**On a single service, `WORKER_IN_PROCESS=true` is not optional.** The API and the queue
workers are separate processes by design (a 90-day backfill should not share an event loop
with request handling), and `pnpm dev` still runs them separately. But a free tier gives
you one process, so this flag hosts the same consumers — the same code, from
`queueWorkers.ts` — inside the API. Without it, producing jobs still succeeds and nothing
consumes them: a mailbox connects and never syncs, and nothing errors.

**Prisma's engine has to be copied into `apps/web`, not just deployed.** Auth.js talks to
Postgres through the Prisma adapter, and getting that working on Vercel is the one part of
deploying this that does not come for free. Next bundles the generated client, and a bundled
client looks for its engine under `process.cwd()` — which in a function is the project
directory — so the engine `prisma generate` wrote into `packages/db` can be shipped perfectly
and never be looked at. `scripts/copy-prisma-engine.mjs` runs before `next build` and puts the
schema and engine at `apps/web/generated/client`; `pnpm verify:prisma` checks it against a real
build. The full reasoning, including Prisma's own resolution code and how to reproduce the
failure locally, is in
[docs/deployment.md](docs/deployment.md#prisma-on-vercel-the-query-engine-error).

**Scheduled send is late, not lost, on a service that sleeps.** A free Render service spins
down after ~15 minutes idle, and with the workers inside it every timer stops. Measured
rather than assumed: BullMQ runs **one** catch-up tick after downtime, not one per missed
interval — a six-minute gap in a one-minute sweeper produced a single catch-up run. So a
9am scheduled send goes out when somebody next opens the app. Nothing is lost, because the
`ScheduledEmail` row is the source of truth and the sweeper re-enqueues from the row alone —
but "sends at the time you chose" is not true on that plan. Real-time sync degrades the same
way, to "syncs when you open the app". The fix, if you need those, is a separate Render
background worker: it does not sleep on inbound traffic. The table in
[docs/deployment.md](docs/deployment.md#what-degrades-on-a-sleeping-service) has every job
and what happens to it.

## Security properties that are deliberate

These are not incidental. Several of them cost something, and they are the reason the
code is shaped the way it is.

**Nothing is ever sent automatically.** Generating drafts and sending mail are different
endpoints, and there is no endpoint that takes a draft id and sends it.
`POST /threads/:id/replies` returns three drafts and sends nothing;
`POST /threads/:id/reply` sends the body in the request and calls no model. There is no
"trusted sender" bypass, and a delayed send is the same rule with a clock —
`POST /scheduled/replies` also carries a body a person read. The reply tool's schema has
two fields per draft, a label and a body, so a model that decided to mail a third party
would have nowhere to put the address.

**Email content is data, never instructions.** Every body reaches a prompt wrapped in
`<untrusted_email>` tags, under a system prompt that says what that means, and the AI
layer has no state-mutating tools to be talked into using. Model output is never parsed
with a regular expression: it arrives as a tool call and is validated with Zod, so a
response that does not fit the schema is an error rather than a best guess. Translation
is the one deliberate inversion — there the instruction is to _translate_ a demand rather
than ignore it, because a threat in the body is evidence the reader needs, and the schema
gives the model nowhere to add a remark of its own.

**The rules floor the threat verdict.** The deterministic layers run first and the model
runs last, given their findings. The verdict is the more severe of the two, and the
model's tool has no field with which to argue a rule down: a DMARC failure stays
suspicious however plausible the prose. That ordering also means a mailbox whose daily AI
cap is spent still gets its authentication failures flagged — it just does not get the
explanation. And because the rules can never say "phishing" on their own (naming an
attack means reading intent), a rules-only verdict tops out at _suspicious_.

**A push notification is a trigger, not data.** Gmail's webhook is verified as a
Google-signed token from our own service account, then decoded only far enough to learn
_which mailbox_. The history id it carries is logged and thrown away. Everything written
to the database comes from a read we initiated and authenticated ourselves — so the worst
a compromised Pub/Sub topic achieves is making us re-read a mailbox we already had access
to.

**And underneath all of it:** OAuth tokens are AES-256-GCM encrypted at rest and
decrypted only inside a provider client, never logged, returned or serialized. Every
database query is filtered by `userId` through a Prisma extension rather than by
remembering to write a `where`. Sync cursors advance only after the transaction that used
them commits, so a crash is a replay and every write is idempotent on
`(mailAccountId, providerMessageId)`. And `sendMessage` is the one provider call that is
never retried: a 429 does not say whether the mail went out, and a retry that guesses
wrong sends somebody's mail twice.
