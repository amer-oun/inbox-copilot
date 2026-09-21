# Deploying Inbox Copilot — Render (API) + Vercel (web)

The API is a long-running Node process with queue workers; the web app is Next.js. This
splits naturally into Render for the first and Vercel for the second, and that split is
also where most of the configuration mistakes live, because the two halves have to agree
about three things: the internal JWT keypair, the database, and each other's URLs.

If you are here because the web app is throwing
`PrismaClientInitializationError: Prisma Client could not locate the Query Engine`, go
straight to [Prisma on Vercel](#prisma-on-vercel-the-query-engine-error).

Everything below assumes the free tiers. Read
[**What degrades on a sleeping service**](#what-degrades-on-a-sleeping-service) before you
rely on scheduled send — it is not a footnote.

> Dashboard labels move around. The commands, environment variables and redirect URIs in
> this document were checked against this codebase; the click-paths were not, so if a
> field is not where this says, the value it wants is still the value here.

---

## 0. What you need first

- A **Google Cloud project** with the Gmail API enabled. (See [Google Cloud](#4-google-cloud-oauth-clients) — there are two OAuth clients, not one.)
- A **Gemini API key** from [Google AI Studio](https://aistudio.google.com/apikey), or an Anthropic key.
- The **generated secrets**, made once and pasted into both services:

  ```bash
  node scripts/generate-secrets.mjs
  ```

  This prints `TOKEN_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY_VERSION`,
  `OAUTH_STATE_SECRET`, `AUTH_SECRET`, `INTERNAL_JWT_PRIVATE_KEY` and
  `INTERNAL_JWT_PUBLIC_KEY`. Keep the output somewhere for the next ten minutes; you will
  paste different halves of it into different places.

**The keypair is the part to get right.** The web app signs the internal JWT and the API
verifies it, so the *private* key belongs only to Vercel and the *public* key only to
Render. Putting the private key on the API does nothing useful and turns one leak into
two. The tables below are split accordingly: no secret appears in both.

---

## 1. Render: Postgres and Redis

Create these before the service, so you have their connection strings.

1. **Postgres.** A new Render Postgres instance. Copy its **internal** connection string
   for the API, and its **external** one for Vercel — Vercel is outside Render's network
   and cannot use the internal host.
2. **Redis / Key Value.** A new instance, and then check two things:
   - **`maxmemory-policy` must be `noeviction`.** BullMQ keys are not a cache. An evicted
     job key is a scheduled email that never goes out, and nothing logs it.
   - **Persistence.** If the plan has none, treat Redis as disposable. The design already
     assumes this — the `ScheduledEmail` row is the source of truth and the per-minute
     sweeper re-enqueues anything overdue — but it means a Redis restart loses in-flight
     backfill progress and pending enrichment, which the half-hourly sweep then finds
     again.

Free Postgres plans are commonly time-limited and deleted when they expire. Check the
expiry before you connect a real mailbox to it.

## 2. Render: the API service

A **Web Service**, Node runtime, root directory the repository root.

**Build command:**

```bash
corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm turbo run build --filter=@inbox-copilot/api && pnpm --filter @inbox-copilot/db db:deploy
```

**Start command:**

```bash
node apps/api/dist/index.js
```

**Health check path:** `/health` — it reports Postgres and Redis separately, so a failed
check tells you which one.

Four things in that build command are load-bearing:

- **`--prod=false`.** `NODE_ENV=production` is set on this service, and pnpm honours it by
  skipping `devDependencies` — which is where `typescript` lives. Without this flag the
  install succeeds and the build then fails with `tsc: not found`.
- **`turbo run build --filter=@inbox-copilot/api`** builds the workspace dependencies
  first: `packages/shared`, and `packages/db` — whose build script *is* `prisma generate
  && tsc`, which is why there is no separate generate step. Building only `apps/api` would
  produce a `dist` that imports two packages that were never compiled.
- **`db:deploy`** is `prisma migrate deploy`. It runs here because the free tier has no
  pre-deploy hook. That is fine for one instance and wrong for several: two instances
  building at once would race on the migration table. If you scale past one, move it out.
- **The API runs from `dist`, never `tsx`.** `tsx` is a devDependency and a compiler in the
  request path; `pnpm build` exists so production does not need one. `apps/api/tsconfig.build.json`
  is what `build` uses, and it excludes tests, fixtures and the dev AI stub — otherwise 65
  compiled test files ship to production importing a devDependency that was just pruned.

### Environment variables (Render)

| Variable | Value | Why |
|---|---|---|
| `NODE_ENV` | `production` | Turns on the config guards below, and refuses the AI stub. |
| `WORKER_IN_PROCESS` | `true` | **Required on a single-service deployment.** Hosts the nine queue consumers inside this process. Without it nothing consumes any queue: mail syncs never run, enrichment never runs, scheduled sends never go out — and nothing errors, because producing a job succeeds either way. |
| `DATABASE_URL` | Render Postgres **internal** URL | |
| `REDIS_URL` | Render Redis internal URL | `rediss://` is fine; ioredis handles TLS from the scheme. |
| `API_PUBLIC_URL` | `https://<api>.onrender.com` | Becomes the OAuth `redirect_uri` and the Pub/Sub push endpoint. Refused at boot if it is localhost or http. |
| `WEB_APP_URL` | `https://<app>.vercel.app` | Where the browser is sent after a mailbox is connected. Same refusal. |
| `TOKEN_ENCRYPTION_KEY` | generated | AES-256-GCM key for the OAuth token vault. |
| `TOKEN_ENCRYPTION_KEY_VERSION` | `1` | |
| `OAUTH_STATE_SECRET` | generated | HMAC for the mailbox-connect `state`. |
| `INTERNAL_JWT_PUBLIC_KEY` | generated (**public** half) | Verifies the BFF's token. |
| `INTERNAL_JWT_ISSUER` | `inbox-copilot-web` | Must match Vercel exactly. |
| `INTERNAL_JWT_AUDIENCE` | `inbox-copilot-api` | Must match Vercel exactly. |
| `GOOGLE_CLIENT_ID` | **mailbox** client id | Not the login client. |
| `GOOGLE_CLIENT_SECRET` | **mailbox** client secret | |
| `AI_PROVIDER` | `gemini` | Or `anthropic`. `stub` is refused in production. |
| `GEMINI_API_KEY` | your key | |
| `LOG_LEVEL` | `info` | |

Optional, and everything keeps working without them:

| Variable | What it turns on |
|---|---|
| `GMAIL_PUBSUB_TOPIC`, `GMAIL_PUBSUB_AUDIENCE`, `GMAIL_PUBSUB_SERVICE_ACCOUNT` | Real-time push sync — see [docs/gmail-push-setup.md](gmail-push-setup.md). Without them mail arrives on the keeper's schedule. |
| `RESEND_API_KEY`, `DIGEST_FROM_ADDRESS` | The opt-in follow-up digest. Reminders work, resolve and display without it. |

**Do not set on Render:** `INTERNAL_JWT_PRIVATE_KEY` (Vercel only), any `AUTH_*` variable
(they are the web app's), `AI_STUB_PORT`, `GMAIL_WEBHOOK_DEV_TOKEN` (ignored in production
anyway), or `PORT` — Render provides it.

### Optional: a separate worker service

If you can afford two services, drop `WORKER_IN_PROCESS` and add a **Background Worker**
with the same repository, the same build command, the same environment, and:

```bash
node apps/api/dist/worker.js
```

This is the shape `ARCHITECTURE.md` §1 asks for — a 90-day backfill should not share an
event loop with request handling — and it is strictly better: the worker does not sleep
when the web service does. The consumers are the same code either way
(`apps/api/src/queueWorkers.ts`), which is enforced by a source-reading test rather than
by intention.

## 3. Vercel: the web app

- **Root directory:** `apps/web`
- **Install command:** `pnpm install --frozen-lockfile --prod=false`
- **Build command:** `cd ../.. && pnpm turbo run build --filter=@inbox-copilot/web`
- **Framework preset:** Next.js

The `cd ../..` is there for the same reason as the filter on Render: `apps/web` imports
`@inbox-copilot/db` and `@inbox-copilot/shared` from their compiled output, and running
`next build` alone would not build them.

Two Vercel project settings beyond those four:

- **"Include source files outside of the Root Directory"** must be **on**. Without it the
  build command's `cd ../..` has nothing to find. (If your build is succeeding, it is
  already on.)
- **"Skip deployments when there are no changes to the Root Directory"** should be **off**,
  or a change confined to `packages/db` will not redeploy the web app that depends on it.

**Root directory stays `apps/web`** — see
[the Prisma section](#prisma-on-vercel-the-query-engine-error) for why moving it to the
repo root is not the fix for the engine error, even though it looks like it should be.

### Environment variables (Vercel)

| Variable | Value | Why |
|---|---|---|
| `AUTH_SECRET` | generated | Auth.js session cookie secret. |
| `AUTH_URL` | `https://<app>.vercel.app` | Auth.js builds the sign-in `redirect_uri` from it. Refused on first read if it is localhost or http. |
| `AUTH_GOOGLE_ID` | **login** client id | Not the mailbox client. |
| `AUTH_GOOGLE_SECRET` | **login** client secret | |
| `API_BASE_URL` | `https://<api>.onrender.com` | Server-side only; the browser never calls the API directly. |
| `INTERNAL_JWT_PRIVATE_KEY` | generated (**private** half) | Signs the 60-second internal token. |
| `INTERNAL_JWT_ISSUER` | `inbox-copilot-web` | Must match Render. |
| `INTERNAL_JWT_AUDIENCE` | `inbox-copilot-api` | Must match Render. |
| `DATABASE_URL` | Render Postgres **external** URL | Easy to miss: Auth.js uses the Prisma adapter, so the web app writes users and sessions to the same database. Without it sign-in fails. |

`AUTH_MICROSOFT_ENTRA_ID_ID` / `_SECRET` are optional. Leave them out and the provider is
not registered and its button is not rendered — which is the honest state, since Outlook
mail sync is not implemented.

Two things worth knowing about this database connection:

- **It is a serverless function talking to a small Postgres.** Every cold function can open
  a connection, and a free instance's connection ceiling is low. Add
  `?connection_limit=1` to the Vercel `DATABASE_URL`, and reach for a pooler before you
  reach for a bigger plan.
- **It needs TLS.** Append `?sslmode=require` (alongside the connection limit:
  `?connection_limit=1&sslmode=require`) if Render's external string does not already say so.

### Prisma on Vercel: the Query Engine error

The web app needs Prisma at runtime — Auth.js stores users and sessions through the Prisma
adapter — and this is the one part of deploying it that does not work out of the box. The
symptom is a clean build, a working `next start` locally, and then, on the first request in
production:

```
PrismaClientInitializationError: Prisma Client could not locate the Query Engine
The following locations have been searched:
  /var/task/apps/web/generated/client
  /var/task/apps/web/.next/server
  /vercel/path0/packages/db/generated/client
  /var/task/apps/web/.prisma/client
  /tmp/prisma-engines
```

**Nothing is wrong with the database connection when you see this, and shipping the engine is
not enough on its own.** Read the list: `/vercel/path0` is the *build* machine's path, gone by
the time the function runs, and every live path it tries is under `/var/task/apps/web`. The
engine that `prisma generate` produced is at `/var/task/packages/db/generated/client` — which
can be deployed perfectly and still never be looked at. That is the trap, and it is worth
being precise about because the obvious fix does not work.

#### Why it looks under `apps/web` at all

From the generated client's own source, `packages/db/generated/client/index.js`:

```js
config.dirname = __dirname
if (!fs.existsSync(path.join(__dirname, 'schema.prisma'))) {
  const alternativePaths = ["generated/client", "client"]
  const alternativePath = alternativePaths.find((altPath) =>
    fs.existsSync(path.join(process.cwd(), altPath, 'schema.prisma'))
  ) ?? alternativePaths[0]
  config.dirname = path.join(process.cwd(), alternativePath)
  config.isBundled = true
}
```

Two branches. If `schema.prisma` sits beside the code, Prisma loads the engine from there. If
it does not — which is what "bundled" means — Prisma looks under **`process.cwd()`**, and in a
Vercel function the working directory is the project directory: `/var/task/apps/web`.

Next.js *does* bundle it. `serverExternalPackages` matches package specifiers, and
`packages/db` reaches its client by a relative path (`../generated/client/index.js`), which is
not one. Webpack inlines it into a server chunk and replaces `__dirname` with a build-time
string literal — which is why `/vercel/path0/packages/db/generated/client` appears in the
searched list at all, and why the first branch can never win in a deployed function.

So the engine has to be at `apps/web/generated/client`, and no amount of tracing from
`packages/db` will put it there.

#### The five settings

| Where | Setting | What it does |
|---|---|---|
| `packages/db/prisma/schema.prisma` | `output = "../generated/client"` | Generates into `packages/db/generated/client` — a path a config file can name, rather than a content-hashed `node_modules/.pnpm/@prisma+client@…` directory. Also collapses the two pnpm instances of `@prisma/client` this workspace resolves (peer-split by TypeScript version) into one client imported by relative path. |
| same | `binaryTargets = ["native", "rhel-openssl-3.0.x"]` | `rhel-openssl-3.0.x` is Vercel's Node runtime; `native` keeps a laptop working. |
| `scripts/copy-prisma-engine.mjs`, run by `apps/web`'s `build` | copies `schema.prisma` + the engines into `apps/web/generated/client` | **The one that actually fixes the error above.** It puts the two files Prisma reads at the path a bundled client resolves to. |
| `apps/web/next.config.mjs` | `outputFileTracingIncludes` | `generated/client/**` — project-relative, so it deploys to `/var/task/apps/web/generated/client`. The `../../packages/db/**` entries stay as the other half of the pair, for the case where Next does *not* bundle the client and `__dirname` is real. |
| `turbo.json` | `generated/**` in `tasks.build.outputs` | `packages/db`'s build is `prisma generate && tsc`. Without this a cache *hit* restores `dist/` and omits the client, so the deploy that breaks is the second one with no change to explain it. |

`prisma generate` already runs on Vercel — it is the first half of `packages/db`'s build
script, and the build command's `--filter` builds that package first. It was never the missing
piece.

**Root directory is not the fix either.** Moving Vercel's root directory to the repo root
looks like it should help, since the engine lives under the repo root — but it would move
`process.cwd()` too, and Prisma would then look under the repo root instead. The paths it
searches are derived from cwd, not from where the files happen to be. Root directory stays
`apps/web`, which is also what lets Vercel detect Next.js.

#### Checking it without deploying

```bash
pnpm verify:prisma      # after a web build
```

This checks the two things that matter in the order the runtime needs them: the copy exists at
`apps/web/generated/client` with both `schema.prisma` and the Linux engine, and that path is in
Next's file trace so it is deployed rather than merely built. It also checks the
`packages/db` copy, for the not-bundled case.

`apps/web/lib/prismaDeploy.test.ts` guards the settings in the fast suite, so deleting one
fails `pnpm test` rather than a deploy.

#### Reproducing it locally

Worth knowing how, because the first attempt at this fix passed a check that only asserted the
engine was in the trace — it was, and the deploy failed anyway. The deployed layout can be
rebuilt from the build's own trace manifests:

1. build the web app, then copy every file named in `apps/web/.next/**/*.nft.json` to
   `<tmp>/<path relative to the repo root>`, and copy `.next` itself;
2. put a copy of `packages/db/generated/client` into `<tmp>/apps/web/.next/server/chunks/` with
   `schema.prisma` and the `*.node` engines **deleted** — that is what a bundled client looks
   like;
3. move `packages/db/generated/client/schema.prisma` and its engine aside, so the build-time
   path is as absent as `/vercel/path0` is at runtime (move them back afterwards);
4. `chdir` to `<tmp>/apps/web`, `require` the bundle copy, and run a query.

With the copy in place that query succeeds. With `<tmp>/apps/web/generated` removed it fails
with the same message and the same three-path structure as production. That is the only check
that distinguishes "deployed" from "findable".

## 4. Google Cloud OAuth clients

**Two clients, because signing in and reading mail are separate grants.** You *can* use one
client for both, but then one secret sits in both services, and the whole point of the
split — that signing in never asks for access to your mail — stops being visible to the
person clicking Allow. Two clients, and the redirect URIs make it obvious which is which.

In **APIs & Services → Credentials**, for each client add these **Authorized redirect
URIs** (no Authorized JavaScript origins are needed; both flows are server-side
authorization-code flows):

**Login client** → the values in `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`:

```
http://localhost:3000/api/auth/callback/google
https://<app>.vercel.app/api/auth/callback/google
```

**Mailbox client** → the values in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`:

```
http://localhost:4000/oauth/google/callback
https://<api>.onrender.com/oauth/google/callback
```

If you also want Microsoft sign-in, the login client's list gains
`.../api/auth/callback/microsoft-entra-id` at both hosts, in Entra rather than Google.

Three things that catch people here:

- **Byte-for-byte.** Google compares the whole string. A trailing slash, `http` where the
  deployment is `https`, or Render's `.onrender.com` host spelled differently is
  `redirect_uri_mismatch` — which is the error you get, and it names nothing.
- **Vercel preview deployments cannot sign in.** Each preview has its own hostname and
  Google will not accept an unregistered one. Test sign-in on the production domain, or
  register a stable preview alias.
- **Testing mode expires refresh tokens.** Gmail's read/modify and send scopes are
  sensitive, so until the consent screen is verified the app stays in Testing — which
  limits it to listed test users and expires their refresh tokens after about a week. The
  app handles that correctly rather than silently: the mailbox goes to `needsReconnect`
  and `/settings/accounts` says so. It still means reconnecting weekly until you either
  verify the app or accept that.

## 5. First run, in order

1. Deploy the API. `GET https://<api>.onrender.com/health` should report `postgres: up`
   and `redis: up`. If either is down, stop here — nothing below will work.
2. Check the startup log for `"queue workers listening"` and nine queues. If it says
   `api listening` with `workerInProcess: false` and nothing else, `WORKER_IN_PROCESS` is
   not set and the app will look fine for about a minute.
3. Deploy the web app. Sign in with Google. A failure here is almost always `AUTH_URL`,
   the login client's redirect URI, or a missing `DATABASE_URL` — and if it is
   `PrismaClientInitializationError`, it is
   [the Query Engine section](#prisma-on-vercel-the-query-engine-error), not your database.
4. **Settings → Connected mailboxes → Connect Gmail.** A failure here is almost always
   `API_PUBLIC_URL` or the mailbox client's redirect URI.
5. Watch the backfill progress on that page. Then open a thread: a summary and a category
   mean the queue workers and the AI provider are both working.

### If something is wrong, it usually fails loudly

The API refuses to start, rather than starting and misbehaving, when:

- `DATABASE_URL`, `REDIS_URL`, `TOKEN_ENCRYPTION_KEY`, `OAUTH_STATE_SECRET` or
  `INTERNAL_JWT_PUBLIC_KEY` is missing or malformed — including a `TOKEN_ENCRYPTION_KEY`
  that is not exactly 32 bytes, and a JWT key that is not a base64 PEM block;
- `API_PUBLIC_URL` or `WEB_APP_URL` is still localhost, or is `http`, while
  `NODE_ENV=production`;
- `AI_PROVIDER=stub`, or `ANTHROPIC_BASE_URL` points at this machine — canned answers in
  production are refused on purpose, not left to be noticed;
- `WORKER_IN_PROCESS` is anything but `true`/`false`/`1`/`0`.

The web app applies the same rules to `AUTH_URL` and `API_BASE_URL`, at the first request
rather than at boot — `next build` has to run without runtime secrets, so validation is
lazy by design.

Three failures are **quiet**, and worth knowing:

- **`WORKER_IN_PROCESS` unset on a one-service deployment.** Producing a job succeeds with
  no consumer. The symptom is a mailbox that connects and never syncs.
- **A missing AI key** fails at the first AI call, not at boot, because the API must be
  able to start and serve `/health` on a host with no AI configured.
- **A mismatched `INTERNAL_JWT_ISSUER` / `AUDIENCE`** is a 401 on every API call from the
  web app — correct behaviour, unhelpful message.

### There is no CORS configuration, and that is not an oversight

Worth stating plainly, because "web and API are on different domains" sounds like it
should need some:

- **The browser never calls the API.** Every browser-side request goes to
  `/api/proxy/*` on the Vercel origin, and that route handler calls Render *server-side*
  with the internal JWT. Same-origin, so no preflight and no CORS headers.
- **The OAuth hops are navigations, not fetches.** The browser is *redirected* to the API's
  callback and redirected back. CORS does not apply to navigation.
- **The Gmail webhook is Google calling Render directly**, authenticated by a signed OIDC
  token.

So the cross-origin check that does exist is between the *browser* and the *web app* —
both on Vercel — and the API being on Render does not touch it. It refuses a write whose
`Origin` is neither the request's own origin nor the configured `AUTH_URL`. `AUTH_URL` is
the second of those because the first depends on how the platform reconstructs the request
URL behind its proxy, and if that comes back `http://` where the browser said `https://`
then *every write* 403s in production while reads keep working. Notably it does **not**
read `x-forwarded-host`: trusting a header to say what our own origin is would hand the
check to the sender, and what is behind it sends mail from the user's own address.

---

## What degrades on a sleeping service

A free Render web service spins down after about 15 minutes with no inbound traffic and
cold-starts on the next request. With `WORKER_IN_PROCESS=true`, the workers sleep with it —
so every timer in this application stops, and that is worth being precise about rather than
hand-waving.

**Measured, not assumed.** Running the worker, stopping it, and restarting it after a gap
of about six minutes — six missed ticks of the one-minute sweeper — produced exactly **one**
catch-up run, not six, and then resumed on schedule. BullMQ's job scheduler does not
backfill missed iterations; it runs the one iteration that was next due and carries on. So
a wake gives you one of each keeper whose next tick has already passed, which after a
15-minute sleep means the send sweeper and the follow-up check always, the AI sweep usually,
and the watch keeper only if the sleep ran past the hour.

| What | While asleep | On wake | Net effect |
|---|---|---|---|
| **Scheduled send** (sweeper, 1 min) | Nothing fires. The delayed job stays delayed and the `ScheduledEmail` row stays `SCHEDULED`. | The delayed job is promoted, and the sweeper runs its one catch-up tick and re-enqueues anything overdue from the row alone. | **Correct but late.** A 9am send goes out when somebody next opens the app. Nothing is lost — this is exactly the case the row-is-truth design is for — but "at a time the user chose" stops being true. This is the one to document. |
| **Follow-up check** (15 min) | No reminder becomes due; no digest goes out. | One catch-up run. | **Harmless, arguably better.** The check resolves before it triggers, so a late run has had more time to notice the reply. Reminders appear when you open the app. |
| **AI sweep** (30 min) | Unenriched messages stay unenriched. | One catch-up run if due. | **Harmless.** This job exists to be late; it is the recovery path for a spent cap or a dead worker. |
| **Watch keeper** (hourly) | Gmail watches are not renewed and no catch-up delta is queued. | One catch-up run if the sleep crossed the hour. | **Real-time sync effectively stops.** Renewal has two days of slack, so a watch only lapses if nobody opens the app for days — but the keeper's *other* job, noticing a mailbox that has not synced in an hour, is exactly what a sleeping service cannot do. Sync becomes "when you open the app". |
| **Gmail push** | Pub/Sub posts to a service that is cold. The request times out before the cold start finishes. | Pub/Sub retries with backoff, and the retry lands on a warm service. | **Slow, not lost.** Safe because the push is a trigger and never data: the history id is discarded, so a retried or duplicated notification is a no-op. |
| **Delta debounce** (2s delayed job) | Stays delayed. | Promoted and run. | Harmless. |
| **In-flight work at spin-down** | `SIGTERM` → the shutdown waits up to 25 seconds for jobs to unwind, then exits. | Retried. | Harmless for sync and enrichment: every write is idempotent on `(mailAccountId, providerMessageId)` and a backfill resumes from its checkpoint. |
| **A send interrupted mid-flight** | The row is left in `SENDING`. | **Nothing.** By design. | The unknown-outcome case. The provider may have accepted the message before the process died, so no retry: a guess either way risks sending somebody's mail twice. `/scheduled` lists it, which is where the user finds out. |

### What to do about it

Pick one, honestly:

1. **Accept it, and say so in the product.** Everything recovers; only the timing suffers.
   Scheduled send becomes "sends when the app is next opened, at the earliest the time you
   chose", which for a personal inbox assistant may be fine.
2. **Run the worker as its own Render service** (above). Background workers do not sleep on
   inbound traffic, so every timer keeps its cadence and the web service sleeping costs
   only the first request's latency. This is the real fix and it is the architecture's own
   preferred shape.
3. **Keep the web service awake** with an external pinger every few minutes against
   `/health`. It works, it is against the spirit of the free tier, and it makes your
   scheduled-send guarantee depend on a cron job you will forget you own.

What does **not** help is making anything retry harder. The sweepers already find every
piece of dropped work from the database alone; the gap is that nothing is running to sweep.
