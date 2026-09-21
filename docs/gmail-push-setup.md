# Gmail push notifications: Google Cloud setup

What Gmail real-time sync needs on Google's side, and how to exercise the webhook from a
laptop that Google cannot reach.

Gmail does not call your server. It publishes to a **Pub/Sub topic** you own, and a
**push subscription** on that topic calls your webhook with a Google-signed OIDC token.
So there are three grants to get right: Gmail may publish to your topic, the
subscription may call your URL, and your API must be able to tell that the caller really
is that subscription.

---

## 1. Pick the project

Use the **same Google Cloud project** as the OAuth client in `GOOGLE_CLIENT_ID`. A watch
request is authorized as your app, and Gmail refuses a topic in a project your app has
no relationship with.

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable pubsub.googleapis.com gmail.googleapis.com
```

Console equivalent: **APIs & Services → Library**, enable *Cloud Pub/Sub API* and *Gmail
API*.

## 2. Create the topic

```bash
gcloud pubsub topics create gmail-push
```

Console: **Pub/Sub → Topics → Create topic**, id `gmail-push`, defaults otherwise. Leave
"Add a default subscription" unchecked — you want a push subscription, configured below.

The full name is what goes in the env file:

```
GMAIL_PUBSUB_TOPIC=projects/YOUR_PROJECT_ID/topics/gmail-push
```

## 3. Let Gmail publish to it

This is the step everyone misses, and its symptom is a confusing 403 from
`users.watch` rather than anything about permissions. Gmail publishes as one fixed
service account, the same for every project:

```bash
gcloud pubsub topics add-iam-policy-binding gmail-push \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

Console: **Pub/Sub → Topics → gmail-push → Permissions → Grant access**, principal
`gmail-api-push@system.gserviceaccount.com`, role *Pub/Sub Publisher*.

## 4. Create the service account the push will authenticate as

The subscription signs its calls as a service account of yours. Your API checks the
token's `email` claim against it, which is what stops anybody else with a Google service
account from minting a valid token for your URL.

```bash
gcloud iam service-accounts create gmail-push-caller \
  --display-name="Gmail push → Inbox Copilot webhook"
```

Its address is `gmail-push-caller@YOUR_PROJECT_ID.iam.gserviceaccount.com`, and it goes
in the env file:

```
GMAIL_PUBSUB_SERVICE_ACCOUNT=gmail-push-caller@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

Pub/Sub needs permission to mint tokens as it:

```bash
PROJECT_NUMBER=$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding \
  gmail-push-caller@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --member="serviceAccount:service-$PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

## 5. Create the push subscription

```bash
gcloud pubsub subscriptions create gmail-push-webhook \
  --topic=gmail-push \
  --push-endpoint="https://api.your-domain.example/webhooks/gmail" \
  --push-auth-service-account="gmail-push-caller@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --push-auth-token-audience="https://api.your-domain.example/webhooks/gmail" \
  --ack-deadline=30 \
  --message-retention-duration=1h \
  --max-delivery-attempts=5 \
  --dead-letter-topic=gmail-push-dead
```

Console: **Pub/Sub → Subscriptions → Create subscription**, delivery type *Push*, then
tick *Enable authentication* and choose the service account; set the audience to the same
URL.

Notes on those flags, because two of them matter more than they look:

- **`--push-auth-token-audience`** must equal `GMAIL_PUBSUB_AUDIENCE` in your env, or —
  if you leave that empty — `API_PUBLIC_URL` + `/webhooks/gmail`, which is what the API
  requires by default.
- **`--message-retention-duration=1h`**. A notification is a trigger: it says a mailbox
  changed, and the sync reads from our own cursor. A day-old trigger tells us nothing the
  next one won't, so retaining a backlog only means a thundering herd after an outage.
- **Dead-letter topic** (create it first with `gcloud pubsub topics create
  gmail-push-dead`). Optional but worth it: without it, a message your endpoint keeps
  rejecting is retried for the whole retention window.

## 6. Point the app at it

```ini
GMAIL_PUBSUB_TOPIC=projects/YOUR_PROJECT_ID/topics/gmail-push
GMAIL_PUBSUB_AUDIENCE=https://api.your-domain.example/webhooks/gmail
GMAIL_PUBSUB_SERVICE_ACCOUNT=gmail-push-caller@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

Restart the API and the worker. The worker's hourly keeper starts a watch for every
Gmail mailbox that has finished a backfill; a mailbox that connects later gets one as
soon as its backfill completes.

## 7. Check it works

```bash
# Is the watch live? (run against your database)
select "emailAddress", "watchResourceId", "watchExpiresAt" from "MailAccount";

# Is anything arriving? Unacked messages piling up means the push is failing.
gcloud pubsub subscriptions describe gmail-push-webhook
gcloud monitoring time-series list --filter='metric.type="pubsub.googleapis.com/subscription/num_undelivered_messages"'
```

Then send yourself an email and watch the API log for `gmail push accepted`, followed by
`delta sync complete` in the worker.

### When it does not work

| Symptom | Cause |
|---|---|
| `users.watch` → 403 "User not authorized to perform this action" | Step 3 missing: `gmail-api-push@system.gserviceaccount.com` has no publish rights on the topic. |
| `users.watch` → 400 "Invalid topicName" | Topic name is not the full `projects/…/topics/…` form, or it lives in another project. |
| Webhook logs `rejected a push token` | Audience mismatch (step 5 vs `GMAIL_PUBSUB_AUDIENCE`), or the subscription's service account is not the one in `GMAIL_PUBSUB_SERVICE_ACCOUNT`. |
| Webhook returns 204 but nothing syncs | The address in the notification matches no `MailAccount`, or the mailbox is `REVOKED`. Check the log line's `mailboxes: 0`. |
| Nothing arrives at all, watch looks healthy | The subscription was deleted or its endpoint is wrong. Nothing in our own data says so — an inbox with no new mail looks exactly like a working one — so the watch keeper runs hourly and queues a catch-up delta for any mailbox that has not synced in an hour, whatever its `watchExpiresAt` says. Mail still arrives; it stops being real time. |

---

## Testing the webhook locally

Google cannot reach `localhost`, so there are three options, in increasing fidelity.

### A. The development token (fastest, no Google involved)

`GMAIL_WEBHOOK_DEV_TOKEN` accepts a shared secret in place of an OIDC token. It is
**ignored when `NODE_ENV=production`**, whatever it is set to, and every request that
uses it logs a warning.

```ini
# .env
GMAIL_WEBHOOK_DEV_TOKEN=local-dev-push-token
```

```bash
# Build a real Pub/Sub envelope: Gmail's payload is base64 inside message.data.
DATA=$(printf '{"emailAddress":"you@gmail.com","historyId":1}' | base64 -w0)

curl -i -X POST http://localhost:4000/webhooks/gmail \
  -H "authorization: Bearer local-dev-push-token" \
  -H "content-type: application/json" \
  -d "{\"message\":{\"data\":\"$DATA\",\"messageId\":\"local-1\"}}"
# → 204, then `gmail push accepted` in the api log and `delta sync complete` in the worker
```

This exercises everything except token verification: envelope decoding, mailbox lookup,
debounced enqueue, the delta itself, and the recovery paths. Send it five times in a row
and you should see one delta — that is the dedup key working.

### B. A real Google-signed token against your local server (verifies auth too)

You can mint the same kind of token Pub/Sub sends, if you have permission to impersonate
the service account:

```bash
gcloud iam service-accounts add-iam-policy-binding \
  gmail-push-caller@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --member="user:you@example.com" --role="roles/iam.serviceAccountTokenCreator"

TOKEN=$(gcloud auth print-identity-token \
  --impersonate-service-account=gmail-push-caller@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --audiences=http://localhost:4000/webhooks/gmail)

curl -i -X POST http://localhost:4000/webhooks/gmail \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d "{\"message\":{\"data\":\"$DATA\"}}"
```

With `GMAIL_PUBSUB_AUDIENCE=http://localhost:4000/webhooks/gmail` this goes through the
real verifier — signature, issuer, audience, service account — with no tunnel and no
Gmail. Unset `GMAIL_WEBHOOK_DEV_TOKEN` while doing this, so you are certain which path
accepted the request.

### C. A tunnel, for the genuine end-to-end path

```bash
cloudflared tunnel --url http://localhost:4000      # or: ngrok http 4000
# → https://random-words.trycloudflare.com
```

Point the subscription and the audience at it, and set `API_PUBLIC_URL` to match:

```bash
gcloud pubsub subscriptions update gmail-push-webhook \
  --push-endpoint="https://random-words.trycloudflare.com/webhooks/gmail" \
  --push-auth-token-audience="https://random-words.trycloudflare.com/webhooks/gmail"
```

```ini
GMAIL_PUBSUB_AUDIENCE=https://random-words.trycloudflare.com/webhooks/gmail
GMAIL_WEBHOOK_DEV_TOKEN=
```

Restart, re-run the watch (the keeper will, or restart the worker), then email yourself.
Real Gmail → real Pub/Sub → your laptop. Two caveats: a free tunnel URL changes every
restart, so the subscription and the audience have to be updated together each time; and
**the OAuth redirect URI is registered against the old host**, so connect your mailbox
before switching `API_PUBLIC_URL`, or add the tunnel URL to the OAuth client too.

### What the Pub/Sub emulator cannot do

`gcloud beta emulators pubsub` is useful for publish/subscribe plumbing but it does not
mint OIDC tokens, so the push it sends carries no `Authorization` header and the webhook
answers 401. Option A is the same test with less setup.
