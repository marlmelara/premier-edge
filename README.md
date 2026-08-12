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

## Milestones

- [x] **M0 — Skeleton + Sendivo ingest** (scaffold, auth, CI, Docker, schema, webhook → contacts/conversations/messages persisting) — *pending: real Sendivo key + webhook shape confirmation, Vercel deploy, AI Responder disabled account-wide*
- [ ] M1 — Eligibility + numbers (county adapters, FEMA, NWI, offer math)
- [ ] M2 — CRM core (Deal Room, Property Context Card, Seller 360, Pipeline)
- [ ] M3 — Agent in copilot (state machine, guardrails, approval queue, urgent alerts)
- [ ] M4 — Contracts + routing + gating (SignWell, XCHECK, title email)
- [ ] Ship Aug 31 — briefing cron, E2E, real seller thread in copilot
