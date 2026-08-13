# Premier Edge

AI-assisted land acquisition platform + in-house CRM for Premier Equity Co. LLC.
**[Premier_Edge_Design_Doc.md](./Premier_Edge_Design_Doc.md) is the source of truth** — build drifts from doc → either build is wrong or doc gets deliberately amended. Never silent drift.

## Stack

TypeScript strict · Next.js (App Router) · PostgreSQL (Neon prod / Docker local) · Drizzle · Zod · Auth.js · Tailwind · Upstash Redis · Vitest · GitHub Actions · Vercel.

## Local setup

```bash
docker compose up -d          # local Postgres on :5432
cp .env.example .env.local    # then fill in values (see below)
npm install
npm run db:migrate            # apply drizzle/ migrations
npm run dev
```

`.env.local` needs at minimum:

- `DATABASE_URL` — the compose default is `postgres://premier:premier@localhost:5432/premier_edge`
- `AUTH_SECRET` — `openssl rand -base64 32`
- `AUTH_USERS` — JSON array of the two allowed users; hash a password with
  `node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" 'your-password'`
- `SENDIVO_WEBHOOK_TOKEN` — shared secret the webhook route requires

## Sendivo webhook (M0)

`POST /api/webhooks/sendivo` — secret-tokened (`x-webhook-token` header or `?token=`), Zod-validated, deduped on `sendivo_message_id`, enforces opt-out keywords (STOP et al.) at ingest. Test locally:

```bash
curl -s -X POST http://localhost:3000/api/webhooks/sendivo \
  -H 'content-type: application/json' \
  -H "x-webhook-token: $SENDIVO_WEBHOOK_TOKEN" \
  -d '{"event":"message.received","message":{"id":"sm_1","from":"(772) 555-0142","body":"Yes I own that lot"}}'
```

> ⚠️ The wire shape in `src/lib/sendivo/webhook-schema.ts` is an **assumption** pending the real Sendivo webhook docs (design doc open item #1). It is the single place the shape lives.

## Scripts

| Script | What |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` / `typecheck` / `test` | CI trio (also run on GitHub Actions) |
| `npm run db:generate` | Emit SQL migration from `src/db/schema.ts` |
| `npm run db:migrate` / `db:push` / `db:studio` | Apply / sync / inspect (reads `.env.local`) |
| `npm run seed:dev` | Dev fixtures: title company, builder, criteria set, live campaign |
| `npm run test:e2e` | Playwright E2E against a real local database |

Two suites are opt-in because they need live services:

```bash
RUN_DB=1 npx dotenv -e .env.local -- vitest run src/lib/agent
```

`RUN_LIVE=1` does the same for `verify-parcel.live.test.ts`, which hits the real county GIS, FEMA, and NWI endpoints.

## The agent (M3)

Copilot-only: every seller-facing message is approved by a human in the Deal Room composer. The guardrails live in code, not the prompt —

- **Dollar validation** — any dollar figure in a draft must equal an amount code supplied; two violations on a thread escalate ([dollar-validation.ts](src/lib/agent/dollar-validation.ts))
- **Escalation** — off-script, wrong-person, or low-confidence classifications never get a draft; they text Marlon instead
- **Caps and locks** — 3 outbound/thread/day, one agent run per conversation, global kill switch on the campaigns page
- **Opt-out + quiet hours** — enforced on *every* send, Marlon's included ([send.ts](src/lib/sendivo/send.ts))

The LLM only classifies inbound messages and writes wording; offers come from the concession ladder in [offer-math.ts](src/lib/eligibility/offer-math.ts).

## Contracts (M4)

PSA signed → assignment sent → assignment signed → title email, chained off SignWell's signed webhook ([route](src/app/api/webhooks/signwell/route.ts), HMAC-SHA256 over `"{type}@{time}"`). Contract fields come from the county-verified parcel and the immutable accepted-offer snapshot — never from anything the seller typed.

The [owner cross-check](src/lib/contracts/owner-xcheck.ts) runs before every send. A multi-owner parcel, an entity owner (LLC/trust), or a name mismatch produces a SignWell **draft** for Marlon instead of a send — the design doc's "never auto" list, enforced in code.


## Milestones

- [x] **M0 — Skeleton + Sendivo ingest** (scaffold, auth, CI, Docker, schema, webhook → contacts/conversations/messages persisting) — *pending: webhook URL configured in Sendivo + real webhook shape confirmation, Vercel deploy, AI Responder disabled account-wide*
- [x] **M1 — Eligibility + numbers** (county adapter registry with St. Lucie/Lee/Charlotte live, FEMA NFHL + NWI clients, offer math, `verifyParcel` persisting checks + optional Redis cache) — *pending: Marlon's unit tests on offer math + zone/wetland logic (working agreement §13)*
- [x] **M2 — CRM core** (Deal Room 3-pane, Property Context Card, Seller 360, Pipeline, campaign dashboard)
- [x] **M3 — Agent in copilot** (state machine, classify + draft with dollar-validation, guardrails + kill switch, approval queue in the composer, edit-rate tracking, urgent SMS alerts) — *pending: `ANTHROPIC_API_KEY` and `MARLON_PHONE` so it can run live*
- [x] **M4 — Contracts + routing + gating** (SignWell template sends + signed-webhook chain, owner XCHECK, title routing + email, campaign gate) — *pending: SignWell key + template/role ids, Resend key*
- [ ] Ship Aug 31 — briefing cron, E2E, real seller thread in copilot
