# Voice AI Agent — Patient Registration System

A voice AI agent that answers a real US phone number, registers a new patient through natural
conversation, persists the record to a database, and exposes it over a REST API and a web dashboard.

> **Live demo**
>
> | | |
> |---|---|
> | 📞 **Phone number** | `+1 (XXX) XXX-XXXX` |
> | 🌐 **API base URL** | `https://<your-app>.koyeb.app` |
> | 📊 **Dashboard** | `https://<your-app>.koyeb.app/dashboard` |
> | ❤️ **Health check** | `https://<your-app>.koyeb.app/health` |
>
> No credentials are required to test the API — `GET`, `POST`, `PUT` and `DELETE` are all open
> for review. (An `API_KEY` gate is implemented and can be switched on with one env var; see
> [Security](#security).)

---

## What it does

Call the number and you get Avery, an intake coordinator. Avery collects the standard US minimum
demographic dataset conversationally, reads it back for confirmation, saves it, and offers to book
a first appointment. Call back from the same number and Avery recognises you and offers to update
your record instead of creating a duplicate.

**A representative call:**

> **Avery:** Thanks for calling Riverside Family Health, this is Avery on the patient intake line. Am I speaking with someone who'd like to get registered as a new patient?
> **Caller:** Yeah, hi — I'm Maria O'Brien.
> **Avery:** Great to meet you, Maria. Could you spell your last name for me?
> **Caller:** O-B-R-I-E-N.
> **Avery:** Perfect, O'Brien. And your date of birth?
> **Caller:** March 5th, 1985.
> *…address, phone, sex…*
> **Avery:** That's everything I need. I can also take your insurance, an emergency contact, and your preferred language if you'd like — want to add any of those, or should I get you registered as-is?
> **Caller:** Just insurance. Blue Cross, member ID XYZ4481.
> **Avery:** Got it. Let me read this back: Maria O'Brien, born March 5th, 1985. 42 Oak Street, apartment 3B, Springfield, Illinois 62704. Phone (217) 555-0148. Insurance Blue Cross, member ID XYZ4481. Did I get all of that right?
> **Caller:** Actually it's apartment 3C.
> **Avery:** Thanks for catching that — apartment 3C. Everything else correct?
> **Caller:** Yep.
> **Avery:** You're all set, Maria. Would you like me to get you on the schedule for a first visit?

---

## Architecture

```
   ┌──────────────┐        PSTN         ┌─────────────────────────────┐
   │   Caller     │◄───────────────────►│           Vapi              │
   │ (any phone)  │                     │  Deepgram STT ─ nova-3      │
   └──────────────┘                     │  Claude Sonnet 5 (LLM)      │
                                        │  Vapi TTS ─ "Savannah"      │
                                        └──────────────┬──────────────┘
                                                       │ HTTPS webhook
                                                       │ (tool calls,
                                                       │  end-of-call report)
                                                       ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │                    This service (Node 24 + Express)                   │
   │                                                                       │
   │   src/voice/          src/routes/            public/                  │
   │   ├─ prompt.js        ├─ patients.routes.js  └─ index.html            │
   │   ├─ tools.js         └─ meta.routes.js         (dashboard)           │
   │   ├─ assistant.config.js                                              │
   │   └─ vapi.webhook.js                                                  │
   │            │                    │                     │               │
   │            └────────────┬───────┴─────────────────────┘               │
   │                         ▼                                             │
   │            src/domain/  (validation + service layer)                  │
   │            ├─ normalize.js       speech-tolerant input cleaning        │
   │            ├─ patient.schema.js  Zod rules, one set for all callers    │
   │            └─ patient.service.js the only code that issues SQL         │
   │                         │                                             │
   │            src/db/  one async interface, two drivers                  │
   │            ├─ drivers/local.js   node:sqlite   (dev + tests)          │
   │            └─ drivers/turso.js   libSQL/HTTP   (production)           │
   └─────────────────────────┼─────────────────────────────────────────────┘
                             ▼
                   SQLite / libSQL
                   patients · calls · appointments
```

**Separation of concerns.** Telephony/STT/TTS is entirely Vapi's problem. `src/voice/` owns the
conversation — prompt, tool schemas, webhook parsing — and nothing else. `src/domain/` owns
validation and persistence and knows nothing about phones. `src/routes/` is a thin HTTP shell over
the same domain layer.

**The voice agent and the REST API share one service layer.** The brief permits the agent to call
the REST API *or* invoke the same service directly; this build does the latter. A record created
by phone and one created by `curl` go through byte-identical validation, and a live call never
depends on the service being able to make an HTTP request to itself.

**Storage sits behind a two-driver adapter.** `patient.service.js` is the only module that issues
SQL, and it talks to one small async interface. Locally that resolves to Node's built-in
`node:sqlite` — a real file, no accounts, no setup, fast tests. In production it resolves to Turso
(hosted libSQL). Both *are* SQLite, so `schema.sql` and every query are shared verbatim; only the
transport differs. Swapping the two required no changes to the routes, the voice tools, or a single
one of the 48 tests.

---

## Tech stack, and why

| Layer | Choice | Rationale |
|---|---|---|
| Telephony + STT/TTS | **Vapi** | Provisions a real US number in minutes and handles barge-in, endpointing and streaming audio. Building that pipeline by hand would have consumed the whole time budget and produced a worse call. |
| LLM | **Claude Sonnet 5** (via Vapi's built-in Anthropic integration) | Strong instruction-following on multi-step tool protocols — it reliably honours the two-phase save described below. Swappable with two env vars. |
| STT | **Deepgram nova-3, `language: multi`** | Mid-call code-switching is what makes the Spanish bonus work without the caller starting over. |
| Runtime | **Node 24 + Express** | Fast to write, and Express keeps the HTTP layer legible for a reviewer. |
| Database | **SQLite** — `node:sqlite` locally, **Turso** (hosted libSQL) in production | The brief blesses SQLite explicitly. Free hosting tiers have ephemeral filesystems, so production storage has to live off-box; Turso is SQLite with a network protocol, so the schema and queries are unchanged. `@libsql/client/web` is pure JavaScript over `fetch` and `node:sqlite` is built in, so the project has **zero native dependencies** — nothing compiles in the Docker image, nothing breaks on a Node upgrade. |
| Validation | **Zod** | One schema drives the API, the voice tools and the error messages read aloud to the caller. |
| Dashboard | **Vanilla HTML/CSS/JS** | No build step, no CDN, cannot break because a third-party script went down. |
| Tests | **`node:test`** | Built in; no test-framework dependency. |

Total production dependencies: **three** (`express`, `zod`, `@libsql/client`) — none of them native.

---

## The core design decision: two-phase save

The most interesting problem in this brief is *when* to validate. Validate too late and you get:

> "Let me read that all back… Maria O'Brien, born March 5th 2085, 42 Oak Street… okay, saving —
> sorry, that date of birth is invalid."

So `save_patient` takes a `confirmed` flag and runs in two phases:

1. **`confirmed: false`** — validate only, nothing is written. The server returns either
   field-specific errors (the agent fixes them conversationally, then dry-runs again) **or** a
   ready-to-speak `readback` string built from the *normalized* values.
2. **`confirmed: true`** — only after the caller says yes out loud. This is the write.

Two things fall out of this that matter:

- **The caller hears exactly what will be stored.** The read-back is generated server-side from
  the cleaned data, not from what the model thinks it heard. `"california"` is read back as
  Illinois-style `IL`, `"five five five…"` as `(217) 555-0148`.
- **Errors arrive before the read-back**, so a bad birthday is corrected mid-conversation instead
  of derailing the confirmation step.

Every tool response also carries an `instruction` field — a short imperative telling the model what
to *say* next. Delivering guidance at the moment it is needed is far more reliable than burying it
in a long system prompt.

---

## Prompt engineering

The full system prompt is [`src/voice/prompt.js`](src/voice/prompt.js), commented with the reasoning
behind each rule. The load-bearing ones:

| Rule | Why |
|---|---|
| One question per turn | Stacked questions are the #1 cause of a voice agent feeling robotic — callers answer the last one and the rest is lost. |
| Never spell words back letter by letter | "J-O-H-N, is that right?" is what an IVR does. A human says "John, got it." |
| Read back server-normalized values | The caller confirms the actual stored record, not the model's recollection. |
| Optional fields offered **once**, as a single opt-in | Matches the brief's guidance and avoids a 15-question interrogation. |
| Named recovery paths for corrections, spelling, "start over", silence, off-topic | These are the exact moments a scripted agent falls apart. |
| Never claim a save succeeded unless the tool returned success | A hallucinated "you're all set" is the worst possible failure for an intake system. |
| Never invent a value for any field | Fabricated demographics are worse than an incomplete record. |
| Switch language silently on request | Announcing the switch wastes a turn. |

---

## Edge cases

| Scenario | Behaviour |
|---|---|
| Invalid date of birth (future, impossible like 02/30, age > 120) | Rejected with a specific spoken reason; **only that field** is re-asked. |
| Short/invalid phone number | "I only caught nine digits — could you give me the full ten-digit number?" |
| Caller says "California" / "hablo español" / "j dot doe at gmail dot com" | Normalized server-side to `CA` / Spanish / `j.doe@gmail.com`. See [`normalize.js`](src/domain/normalize.js). |
| Caller corrects a field mid-read-back | Correction applied, only the changed item re-confirmed, interview not restarted. |
| Caller says "start over" | Collected data discarded, interview restarts from the first name. |
| Database write fails | Caller hears an apology and a callback promise — never a false confirmation. Failure is logged with the full payload so the record can be recovered. |
| Call drops mid-conversation | Nothing partial is written (the write only happens at `confirmed: true`). The `end-of-call-report` still archives the transcript with outcome `abandoned`. |
| Webhook handler throws | Returns HTTP 200 with a spoken recovery instruction. A 5xx here would become dead air on a live call. |
| Caller goes silent | Two idle nudges, then a graceful goodbye at the 30s silence timeout. |
| Returning caller | `lookup_patient` on caller ID → "It looks like we already have a record for…" → update instead of duplicate. |
| Two family members share a phone | Multiple matches are reported and the agent asks which family member is calling. |
| Malformed JSON to the API | `400 invalid_json`, not a 500. |
| Unknown/garbage tool name from the model | Handled, logged, call continues. |

---

## Running it locally

```bash
npm install
npm run seed     # optional: two demo patients
npm start        # http://localhost:3000
```

Then open <http://localhost:3000/dashboard>.

No database setup is needed locally. With `DATABASE_URL` unset the app uses a local SQLite file at
`./data/patients.sqlite` through Node's built-in driver — no account, no container, no migration
step. Set `DATABASE_URL` and it switches to Turso; nothing else changes.

Run the tests:

```bash
npm test
```

48 tests covering the CRUD lifecycle, soft delete, every validation rule, the speech normalizers,
the two-phase save, duplicate detection, transcript archiving, and all three Vapi webhook payload
shapes.

---

## Deployment

Deployed on free infrastructure: **Koyeb** for compute, **Turso** for storage. Compute and storage
are separated deliberately — free tiers give you an ephemeral filesystem, so the database cannot
live next to the app.

### 1. Create the database (Turso)

```bash
turso db create patient-registry
turso db show patient-registry --url        # -> DATABASE_URL
turso db tokens create patient-registry     # -> DATABASE_AUTH_TOKEN
```

Free plan: 5 GB, no credit card, no expiry. The schema is applied automatically on first boot —
`schema.sql` is written entirely with `IF NOT EXISTS`, so startup doubles as the migration.

### 2. Deploy the service (Koyeb)

Create a Web Service from this GitHub repo, Dockerfile builder, **Free** instance type, health
check path `/health`. Set the environment variables:

```
DATABASE_URL=libsql://patient-registry-<org>.turso.io
DATABASE_AUTH_TOKEN=<token from above>
PUBLIC_BASE_URL=https://<your-app>-<org>.koyeb.app
VAPI_API_KEY=<from Vapi → Settings → API Keys>
VAPI_SERVER_SECRET=<openssl rand -hex 32>
```

Koyeb injects `PORT` itself. Confirm `GET /health` returns `"status": "healthy"`, `"database": "ok"` and — the important one —
`"storage": "turso"` with `"persistent": true`. That endpoint runs a real query, so wrong Turso
credentials fail loudly instead of passing silently. If `DATABASE_URL` is missing, the app connects
happily to a local file and would otherwise look perfectly healthy right up until the container
restarts and takes every patient record with it; `/health` names the active driver and warns
outright when production storage is not durable.

> **Keepalive.** Koyeb's free instance scales to zero after 1 hour with no traffic, and the cold
> start (~5s) would land inside a caller's first turn. A free cron ping to `/health` every 15
> minutes (cron-job.org, UptimeRobot) prevents it from ever sleeping. This is a free-tier
> workaround, not an architectural choice — a paid instance would simply disable scale-to-zero.

### 3. Provision the voice agent

Buy a US number in the Vapi dashboard (**Phone Numbers → Buy Number**), then:

```bash
VAPI_PHONE_NUMBER_ID=<id> npm run provision:vapi
```

This creates the assistant from [`assistant.config.js`](src/voice/assistant.config.js), points its
tools at `PUBLIC_BASE_URL/vapi/webhook`, and attaches it to the number. It prints the new
`VAPI_ASSISTANT_ID` — set that variable so future runs update in place instead of creating
duplicates.

Keeping the assistant in code rather than in dashboard clicks means the prompt, tools and
turn-taking settings are all version-controlled and diffable. `GET /vapi/assistant` returns exactly
what this build would deploy.

### Local development against a real phone

```bash
ngrok http 3000
PUBLIC_BASE_URL=https://<subdomain>.ngrok-free.app npm run provision:vapi
```

---

## API reference

All responses use the envelope `{ "data": ..., "error": ... }`.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/patients` | List. Filters: `?last_name=` `?date_of_birth=` `?phone_number=` `?include_deleted=` `?limit=` `?offset=` |
| `GET` | `/patients/:id` | Fetch one by UUID |
| `POST` | `/patients` | Create → `201` with the created record |
| `PUT` / `PATCH` | `/patients/:id` | Partial update |
| `DELETE` | `/patients/:id` | **Soft** delete (sets `deleted_at`; the row is never removed) |
| `GET` | `/patients/:id/calls` | Call transcripts for this patient |
| `GET` | `/patients/:id/appointments` | Booked appointments |
| `GET` | `/health` `/stats` `/calls` | Health, counters, recent calls |
| `POST` | `/vapi/webhook` | Vapi server messages (tool calls, assistant requests, end-of-call reports) |

`/api/patients` is an alias for `/patients`, so either convention works.

**Status codes:** `200` OK · `201` created · `400` malformed JSON or non-UUID id · `401` bad API key
or webhook secret · `404` not found · `409` update to a deleted record · `422` validation failed ·
`429` rate limited · `500` unexpected.

### Examples

```bash
# Create
curl -X POST https://<base-url>/patients \
  -H 'Content-Type: application/json' \
  -d '{
    "first_name": "Maria",
    "last_name": "O'\''Brien",
    "date_of_birth": "03/05/1985",
    "sex": "Female",
    "phone_number": "(217) 555-0148",
    "address_line_1": "42 Oak Street",
    "address_line_2": "Apt 3C",
    "city": "Springfield",
    "state": "Illinois",
    "zip_code": "62704"
  }'
```

```bash
# Find a patient registered on a previous call
curl "https://<base-url>/patients?last_name=O'Brien"
curl "https://<base-url>/patients?phone_number=%2B12175550148"
```

```bash
# Validation is server-side — this returns 422 with per-field messages
curl -X POST https://<base-url>/patients \
  -H 'Content-Type: application/json' \
  -d '{"first_name":"Test","last_name":"User","date_of_birth":"01/01/2099","sex":"Male","phone_number":"555","address_line_1":"1 Main","city":"Austin","state":"ZZ","zip_code":"1"}'
```

Note that `"Illinois"` is stored as `IL`, `"(217) 555-0148"` as `2175550148`, and `"03/05/1985"` as
`1985-03-05` — the API applies the same normalizers as the voice agent.

---

## Data model

`patients` — the standard US minimum demographic dataset, with `patient_id` (UUID), `created_at`,
`updated_at` and `deleted_at`. Dates are stored ISO-8601 (`YYYY-MM-DD`) so string ordering equals
chronological ordering; phone numbers are stored as bare 10 digits so caller ID always matches.
The API returns both machine forms and display forms (`date_of_birth_us`, `phone_number_formatted`,
`age`).

Constraints are enforced **twice on purpose**: Zod produces friendly, speakable, field-specific
messages, and SQL `CHECK` constraints in [`schema.sql`](src/db/schema.sql) are the backstop that
guarantees nothing malformed reaches disk even if a future code path skips validation.

Two supporting tables: `calls` (transcript, summary, outcome, linked to the patient it produced) and
`appointments` (mock scheduling).

---

## Security

- **No secrets in source.** Every key is read in [`src/config.js`](src/config.js) and nowhere else.
  `.env` is gitignored; `.env.example` documents each variable.
- **Webhook authentication.** If `VAPI_SERVER_SECRET` is set, webhook requests without the matching
  `x-vapi-secret` header are rejected with 401.
- **Optional API key.** Setting `API_KEY` requires `Authorization: Bearer …` on POST/PUT/DELETE.
  Left unset for review so the API can be exercised without credentials. The voice agent is
  unaffected — it calls the service layer in-process.
- **Input sanitization.** Unknown fields are stripped rather than stored, body size is capped at
  256 kB, all SQL uses bound parameters, and a fixed-window rate limiter is applied.
- **Data minimization.** The agent is instructed never to collect card numbers or SSNs. Per the
  brief, this is not a HIPAA-compliant system and should not hold real patient data.

---

## Observability

One JSON object per line to stdout — the format Koyeb, Railway, Render and Fly all ingest natively.
Every request is logged with method, path, status and duration; every tool invocation with call id,
tool name and outcome; and, as the brief requires, **the full collected payload** is logged on every
successful registration, alongside the end-of-call transcript. The dashboard surfaces the same
transcripts per patient.

---

## Known limitations and trade-offs

1. **SQLite/libSQL rather than Postgres.** Correct for this scale and explicitly sanctioned by the
   brief. The service layer is the only code that issues SQL, so moving to Postgres would be a
   contained change — the Turso swap already exercised exactly that seam and touched no route, tool
   or test. **If `DATABASE_URL` is unset in production the app falls back to a local file,
   which an ephemeral filesystem will erase on restart** — so `/health` names the active driver and
   sets `persistent: false` with an explicit warning rather than letting that pass silently.
2. **The free instance sleeps.** Koyeb's free tier scales to zero after an hour idle, mitigated with
   a cron ping (above). If that ping is ever removed, the first call after an idle hour eats a ~5s
   cold start.
3. **Call state is in memory.** The map linking an in-flight call to the patient it created
   ([`call-state.js`](src/voice/call-state.js)) is lost on restart. Worst case, a transcript is
   archived without its patient link — no patient record is ever at risk.
4. **Appointment scheduling is mocked.** It returns the next matching weekday slot rather than
   consulting real availability.
5. **Duplicate detection is phone-only.** Two people sharing a number are surfaced to the agent to
   disambiguate, but there is no fuzzy name+DOB matching.
6. **No auth on the dashboard.** It is a read-only demo surface. Real deployment needs SSO and audit
   logging.
7. **Rate limiting is per-instance and in-memory.** Fine for one container; a real deployment would
   use a shared store.
8. **English and Spanish are what I actually tested.** The transcriber is configured for automatic
   multilingual detection, so other languages should work, but I haven't verified them.

## Next steps

- Postgres adapter behind the existing service interface, for horizontal scaling.
- Fuzzy duplicate detection on name + date of birth, not just phone number.
- Persist call state to the database so transcript-to-patient linking survives a restart.
- Real scheduling integration with availability lookup.
- Structured audit log of every field mutation (who/what/when) — the foundation of a HIPAA story.
- Automated evaluation of the agent: a suite of scripted caller personas (fast talker, corrector,
  heavy accent, mid-call hang-up) replayed against the assistant to catch conversational regressions
  the unit tests cannot.

---

## Repository layout

```
src/
├── config.js                 all environment access, one file
├── app.js / index.js         express wiring, listener, graceful shutdown
├── db/
│   ├── schema.sql            DDL with CHECK constraints
│   ├── index.js              driver selection, one async interface
│   ├── drivers/local.js      node:sqlite  (dev + tests)
│   ├── drivers/turso.js      libSQL/HTTP  (production)
│   └── seed.js               two demo patients
├── domain/
│   ├── normalize.js          speech-tolerant input cleaning
│   ├── patient.schema.js     Zod rules + API serialization
│   └── patient.service.js    the only code that touches the database
├── routes/                   thin HTTP layer
├── voice/
│   ├── prompt.js             system prompt, heavily commented
│   ├── tools.js              tool schemas + handlers
│   ├── assistant.config.js   the Vapi assistant, in code
│   ├── vapi.webhook.js       webhook parsing and dispatch
│   └── call-state.js         in-flight call → patient linking
├── middleware/               envelope, errors, security
public/index.html             dashboard
scripts/provision-vapi.js     push the assistant to Vapi
tests/                        48 tests
```
