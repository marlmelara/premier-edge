# Premier Edge — AI-Assisted Land Acquisition Platform + In-House CRM

**Owner:** Marlon Melara (Premier Equity Co. LLC)
**Ships:** Sun Aug 31, 2026 (copilot mode) · Autonomy graduates through September
**Capacity assumption:** 8–10 focused hrs/day; LeetCode floor of 2 problems/day runs alongside.
**Purpose:** Single source of truth handed to Claude Code as build context AND Marlon's standing reference. Build drifts from doc → either build is wrong or doc gets deliberately amended. Never silent drift.

---

## 1. What this is

Premier Edge is the operating system for Premier Equity's land wholesaling business — **including its own CRM**. Sendivo is demoted to transport: it delivers and receives SMS. Everything else — contacts, conversations, property intelligence, offers, contracts, pipeline — lives in Premier Edge's database and UI. We never depend on Sendivo's CRM screens again.

The loop it runs:

**SMS blast (Sendivo transport) → seller replies → agent qualifies & negotiates within code-enforced bounds → parcel verified (county GIS + FEMA flood + NWI wetlands) → accepted → owner cross-checked on county appraiser → PSA via SignWell → assignment to matched builder → both signed → auto-routed to title company** — with Marlon working from one screen the whole time.

**Scope guardrails (v1):** Land only, permanently — no ARV/repairs/comps ever. Florida counties **St. Lucie, Lee, Charlotte** at launch behind a pluggable county-adapter registry; other states later are *additive* (new adapters, new title defaults) with zero architectural change. Two users. Not SaaS.

**Reference tool lessons kept:** orchestration-hub pattern, county-prefilled contracts, one-line title email with both PDFs, compliance tiles, SMS daily briefing. **Improvements over reference:** SignWell API instead of Playwright-driven DocuSign; our own CRM instead of living inside the texting platform's.

---

## 2. The CRM (first-class pillar — this is where Marlon lives)

Design principle: **every screen answers "who is this seller, what is this land, do we want it, and what will we pay" in under 5 seconds.** No bouncing between tabs. The three surfaces:

### 2.1 Deal Room (the conversation workspace — the most important screen in the product)
Three panes:
- **Left:** conversation list (filter: campaign, state, needs-approval, escalated, unread; sort by last activity). Badge counts for the approval queue.
- **Center:** SMS thread + composer. Agent drafts appear inline as pending cards → approve / edit / reject (reason captured). Marlon can type directly; his sends go through the same guardrail checks (opt-out, quiet hours) minus approval.
- **Right rail — the Property Context Card** (the feature Marlon asked for, verbatim):
  - Address, county, parcel ID, acreage/sqft, owner of record
  - **Eligibility badges:** Flood zone (e.g. `X ✅` / `AE ❌`), Wetlands (`clear ✅` / `intersects ❌`), Size (`12,4xx sqft ✅`), each click-expandable to the raw check detail + checked-at date
  - **Verdict strip:** ALL BOXES CHECKED ✅ / FAILED: wetlands ❌
  - **The numbers:** Max offer · Anchor (start-at) · current offer state (last offered $, seller counter $, room left — computed, never typed)
  - **Map snapshot:** embedded mini-map (Leaflet + OSM tiles, parcel polygon drawn from county geometry) so the land's location reads at a glance; expands to full map
  - Owner-match status (XCHECK score), contract status chips (PSA/assignment), quick links: county appraiser page, FEMA MSC, NWI mapper pre-centered on the parcel
- The same context card component renders anywhere a conversation appears — Deal Room, Seller 360, approval queue — one component, one truth.

### 2.1a Negotiation policy — DOC AMENDMENT (Marlon, Aug 14 2026)
The original doc specified *which* number (max → anchor → ladder) but never *when*. This is the sequence, and it is code-owned like every other money decision (§6):

1. **The opener never carries a price.** We ask whether they'd sell. They say yes, no, insult us, or name a number.
2. **Ask before we tell.** When they engage without naming a price, the agent asks what they want for it — up to twice (`MAX_PROBES`). Rationale, verbatim: *"if we start the offer at 100k but they only wanted 80k, then we are shooting ourselves in the foot."*
3. **If they won't budge and want our number, we open at the anchor** (`anchor_pct` × max offer, default .78 — "something respectable").
4. **Their number caps ours.** Every offer is `min(ladder rung, seller's stated price)`, floored at whatever we already put in writing so we never retrade ourselves. An outrageous asking price is answered cordially at our rung, never argued with.
5. **Silence gets chased, not abandoned.** ~4h after an unanswered offer: a check-in restating the *same* number. ~48h after that: *"we spoke with our partners"* and a raise to the next rung (default .9 × max). Then we stop — a third unanswered chase is harassment.
6. **A counter above our rung walks up the ladder**, ending at max offer. The ceiling rung is flagged and never auto-sends.

Everything above produces *drafts*. Copilot rules are unchanged: nothing reaches a seller without approval in the Deal Room.

Consequences: `concession_steps` changes meaning (§5); the follow-up sweep is a new scheduled job (§11c).

### 2.2 Seller 360
One page per contact: identity (name/phone/email, Sendivo enrichment merged with ours), every conversation across campaigns, every linked parcel with mini eligibility badges, offer history (immutable snapshots), contracts, full `agent_actions` timeline, labels/stage. Answers "have we ever talked to this person, about what land, and how did it end."

### 2.3 Pipeline & lists
- Pipeline table: one row per deal — address, seller, stage, eligibility verdict, max offer, last offer, last activity, next deadline. Filters + saved views (e.g. "PSL live · needs approval", "under contract · closing <14d").
- Campaign dashboard: per-campaign delivery/reply/opt-out tiles (Sendivo metrics API) + agent stats (drafts, approval rate, edit rate — the autonomy-graduation evidence).

### 2.4 Sync posture
- **Premier Edge Postgres is the system of record.** Sendivo contact enrichment is pulled on first inbound (`GET /contacts`) and merged; after that, ours wins.
- Optional one-way push back to Sendivo (deal-status, labels) so its dashboard isn't lying — nice-to-have, cut-able, never depended on.

---

## 3. Tech stack

Core unchanged: TypeScript strict · Next.js 14+ App Router · PostgreSQL (Neon) · Drizzle · Zod · Auth.js · Tailwind + shadcn/ui · Upstash Redis · Vitest + Playwright (1 E2E) · GitHub Actions · Docker Compose · Vercel. Interview-defense table in Appendix A.

CRM-specific additions:
| Need | Choice | Why |
|---|---|---|
| Mini-maps | **Leaflet + OpenStreetMap tiles**, parcel GeoJSON overlay | No API key, no cost, parcel geometry already comes from county adapters. Static-image fallback later if perf demands. |
| Thread updates | Poll-with-revalidate (5–10s) on active Deal Room | SSE/websockets are overkill for 2 users; say so proudly in interviews. |
| Search | Postgres `ILIKE`/trigram on contacts+parcels | Right-sized; FTS/pgvector later if ever needed. |

Integration layer (unchanged from prior rev): Sendivo REST + webhooks · FEMA NFHL ArcGIS REST · USFWS NWI ArcGIS REST · county adapters · SignWell API · Anthropic API (language only) · Resend/SMTP for title emails.

---

## 4. Architecture

```
 Sendivo (transport only)          ┌───────────────────────────────────┐
   ─inbound webhook──────────────► │ /api/webhooks/sendivo             │
   ◄─POST /conversations (takeover)│                                   │
   ◄─POST /sms (Marlon briefings)  │        Next.js on Vercel          │
                                   │  ┌─────────── CRM UI ───────────┐ │
 SignWell ◄─template create────────│  │ Deal Room · Seller 360 ·     │ │
          ─signed webhook────────► │  │ Pipeline · Campaigns          │ │
                                   │  └───────────┬──────────────────┘ │
 FEMA NFHL ◄─query─────────────────│  Agent Orchestrator (state machine│
 NWI       ◄─query─────────────────│   + guardrails + LLM classify/draft)
 County GIS◄─adapter registry──────│              │                    │
 Title Co  ◄─email + PDFs──────────│  Drizzle ─► Postgres (Neon)       │
                                   │  Upstash Redis · Vercel Cron      │
                                   └───────────────────────────────────┘
```

One monolith, one DB, everything auditable in `agent_actions`.

---

## 5. Data model

Money `numeric(12,2)`, IDs `uuid`, all tables timestamped. (Δ = changed/new for CRM rev.)

```
Δ contacts       id, phone (unique), name, email, alt_phones text[],
                 mailing_address fields, source ('blast'|'inbound'|'manual'),
                 sendivo_contact_id, stage, labels text[], notes, opted_out bool
Δ contact_parcels contact_id FK, parcel_id FK, relationship ('owner'|'claimed'|'unknown')
  parcels        id, county, parcel_id, address, legal_description, owner_name_raw,
                 acreage, sqft, geometry jsonb (GeoJSON), source_adapter, raw_payload jsonb,
                 appraiser_url, assessed_value
  checks         id, parcel_id FK, kind ('county'|'fema'|'nwi'|'sqft'),
                 result ('pass'|'fail'|'error'), detail jsonb, checked_at
Δ deals          id, contact_id FK, parcel_id FK, campaign_id FK, stage
                 ('lead'|'qualifying'|'verified'|'offer'|'negotiating'|'accepted'|
                  'under_contract'|'closed'|'dead'), verdict ('pass'|'fail'|'pending'),
                 max_offer, anchor, last_offer, seller_counter, dead_reason
                 -- the CRM pipeline row; numbers denormalized here for list speed,
                 -- recomputed from criteria+offers on write, never hand-edited
  campaigns      id, name, market, status ('draft'|'ready'|'live'|'paused'|'done'),
                 sendivo_campaign_id, sendivo_blast_ids int[], criteria_id FK,
                 builder_id FK, title_company_id FK nullable, autonomy jsonb
  criteria_sets  id, min_sqft, allowed_flood_zones text[] (default ['X']),
                 wetlands_allowed bool (default false), builder_buy_price,
                 min_assignment_fee, max_offer GENERATED, anchor_pct (default .78),
                 concession_steps jsonb  -- AMENDED Aug 14 2026: fractions of
                 -- MAX OFFER (default [.9, 1]), not of the anchor→max gap.
                 -- Same unit as anchor_pct, so the ladder reads in one scale:
                 -- .78 → .9 → 1.0. Marlon reasons in ".9 of our max"; the gap
                 -- form silently drifts when anchor_pct changes.
  conversations  id, deal_id FK, sendivo_conversation_id, state (§7),
                 owned_by_edge bool, last_inbound_at, last_outbound_at,
                 escalated bool, escalation_reason
  messages       id, conversation_id FK, direction, body, sendivo_message_id,
                 status, classified_as, sent_by ('agent'|'marlon')
  agent_actions  id, conversation_id FK, type, input jsonb, output jsonb,
                 approved_by nullable, created_at        -- APPEND-ONLY
  offers         id, deal_id FK, version, amount, state_at_offer, assumptions jsonb
  builders       id, name, entity_name, email, phone, markets text[],
                 buy_criteria jsonb, preferred_title_company_id FK, notes
  title_companies id, name, contact_name, emails text[], state, is_default_fl bool
  contracts      id, deal_id FK, kind ('psa'|'assignment'), signwell_document_id,
                 template_used, sellers jsonb (1..n), price, status, signed_pdf_url
  opt_outs       phone PK, opted_out_at, source   -- checked before EVERY send
```

Key CRM invariant: **`deals` is the join-everything spine.** Deal Room, Seller 360, and Pipeline are three lenses on the same `deals` row — no screen has private state.

---

## 6–11. Eligibility pipeline · Sendivo integration · Agent · Contracts · Title routing · Compliance

Unchanged from the previous revision in substance; restated deltas only:

- **Eligibility (§ was 5):** `verifyParcel()` → county adapter → FEMA → NWI → size → persisted `checks` + Redis cache. Adapter registry: one interface, one file per county (`/adapters/{county}.ts` + fixture tests); **adding a county or a state = adding adapter files + a title default row. Nothing else changes** (Marlon's expansion requirement, by construction).
- **Sendivo (§ was 6):** transport only. First Edge reply into a thread uses the **takeover endpoint deliberately** (permanently kills Sendivo's native AI for that thread — we own every reply after; `owned_by_edge=true`). Native AI Responder disabled account-wide Day 1. `POST /sms` reserved for Marlon notifications. Contact enrichment on first inbound. Webhooks Zod-validated, deduped, secret-tokened. Metrics endpoints power campaign tiles.
- **Agent (§ was 7):** LLM = language only; code owns math, eligibility, ceilings. State machine NEW→…→TITLE_ROUTED with ESCALATED/DEAD/OPTED_OUT terminals. Dollar-validation on every draft (any $ in output must equal a code-supplied allowed value; 2 failures → escalate). Guardrails in code: opt-out gate, quiet hours 8a–9p seller-local, thread cap 3/day, campaign caps, ceiling regex, kill switch, Redis send-locks. **Copilot-first:** every send approved in the Deal Room composer; per-state auto-send graduates at <10% edit rate over 50–100 sends, per-campaign, reversible. Never auto: contracts, ceiling-priced offers, multi-seller, owner mismatches.
- **Contracts (§ was 8):** SignWell templates (exist, roles configured). Single-seller = fully templated; **2+ sellers = always human-approved** with dynamically added signer roles. Fields from county-verified `parcels` + accepted `offers` snapshot, never seller-typed data. Signed webhooks chain PSA → assignment → title.
- **Title routing (§ was 9):** builder preference → seller-specified → FL default (Marlon's contact, seeded). Email with both PDFs, CC builder + Marlon, logged; failures ping Marlon by SMS.
- **Campaign gating (§ was 10):** `ready→live` only when criteria + builder + title routing + Sendivo health + agent config all present. UI cannot launch incomplete campaigns.
- **Compliance (§ was 11):** 10DLC current · local opt-out enforcement · quiet hours · caps · full audit. Non-negotiable.

## 11b. Notifications to Marlon (two channels, both via `POST /sms` to Marlon's cell)

**Channel 1 — Daily briefing (cron, 9am CST; ship-time feature):** modeled on the reference screenshots. Contents, in priority order, skipping empty lines: ⏰ closings within N days (address + countdown) · ✍️ contracts awaiting signature (count) · 🚨 escalations pending (count) · ✅ approvals waiting in queue (count) · 💬 new replies since yesterday · 🚫 opt-outs/violations (compliance line). Greeting + date header like the reference ("Good morning Marlon — Premier Edge briefing, {day, date}"). One message, ≤3 segments.

**Channel 2 — Urgent alerts (real-time, event-driven; built in M3 with the agent):** fires immediately, not batched, for:
- Conversation ESCALATED (reason included: off-script, low confidence, owner mismatch, multi-seller, ceiling reached)
- Seller ACCEPTED an offer (time-sensitive — strike while hot)
- Contract signed (PSA or assignment) / SignWell webhook failure
- Title email delivery failure
- Kill switch triggered, or any guardrail block that indicates a bug (e.g. draft rejected twice)
- County adapter or Sendivo webhook hard-failing (system health)

**Anti-spam rules (code):** severity tiers — `urgent` sends instantly; `info` (e.g. individual new replies) never texts, it waits for the briefing. Per-type throttle (same alert type max 1/15min, coalesced: "3 new escalations"). Alerts always send regardless of hour — they're Marlon's own business events, not seller-facing marketing (quiet-hours rules protect sellers, not the owner). Every alert logged to `agent_actions`.

## 11c. Follow-up sweep — DOC AMENDMENT (Aug 14 2026)

`GET /api/cron/followups`, bearer-authed with `CRON_SECRET` like the briefing. Scans open threads with a standing offer and drafts the §2.1a chase moves (nudge, then partner raise). Drafts only — same copilot rules, same guardrails (kill switch, thread cap, opt-out, and no stacking a second card on a thread that already has one pending).

Every decision derives from elapsed time, so the endpoint is idempotent at any cadence. **Constraint:** Vercel Hobby caps crons at once per day and rejects sub-daily expressions at deploy time, so `vercel.json` runs it at 13:00 UTC and a GitHub Actions schedule pings it hourly through the seller-facing day. Moving to Vercel Pro makes the Actions workflow deletable.

---

## 11d. List ingestion & pre-qualification — DOC AMENDMENT (Aug 14 2026)

The original flow was **inbound-first**: blast the list from Sendivo, and learn about a lot only once its owner replied and Marlon typed the parcel id in by hand. That inverts the economics. A 7,325-contact Cape Coral list contains lots that are wetlands, AE zone, or under the size floor — we were paying to text every one of those owners, then spending attention qualifying replies that were dead before they arrived.

**Premier Edge now owns the list, and due diligence runs before the blast, not after the reply.**

- **Source.** Sendivo's API cannot list or page contacts (`GET /contacts` requires `phone_number` — verified live Aug 14 2026), so the list can't be pulled back out of it. The input is the same CSV that gets uploaded there. Headers are matched by alias, not position, because every provider names them differently; unrecognized columns are reported, kept in `sendivo_raw`, and never silently dropped.
- **Resolution.** A row with an APN is trusted. A row with only an address goes to the county adapter and must match **exactly** after USPS normalization. Near-misses and split lots go to an unresolved queue instead of being guessed — attaching the wrong parcel would run flood, wetlands, and a price against land the seller doesn't own, and every downstream check would pass on the wrong lot.
- **Storage.** `contact_parcels` finally carries its weight: it is the many-to-many that lets one seller own several lots, and it is what an inbound reply uses to find its own land.
- **Pre-qualification.** Every resolved lot is scored against the campaign's buy boxes. Passing lots become the blast list; failing lots stay in the land bank with their findings attached, which is the §10 amendment working as intended — the list *is* the inventory.
- **Auto-attach.** On first inbound, a deal with no parcel resolves itself from `contact_parcels` when the contact owns **exactly one** lot. More than one stays manual: "are you interested in selling?" doesn't say which lot, and picking for them would price the wrong land. Both outcomes are written to `agent_actions`, since this sets the deal's money.

Entry point: `scripts/import-list.ts`. Emits `<list>.blast-ready.csv` (upload that to Sendivo) and `<list>.unresolved.csv` (needs a parcel id by hand).

**Known limit:** fit is per-campaign buy box and isn't persisted per parcel, so the blast-ready set comes from the run that scored it. A `parcel_campaign_verdicts` table would make it queryable after the fact.

## 12. Milestones — ships Sun Aug 31 (8–10 hr days; CRM before agent, because the approval queue lives inside the Deal Room)

| Milestone | Dates | Definition of done |
|---|---|---|
| **M0 — Skeleton + Sendivo ingest** | Aug 12–14 | Scaffold/auth/CI/Docker/deploy · Sendivo key + webhooks live (Zod, dedupe) · native AI Responder disabled · contacts/conversations/messages persisting from real inbound. Explain-back #1. |
| **M1 — Eligibility + numbers** | Aug 15–18 | Adapter registry + St. Lucie/Lee/Charlotte adapters · FEMA + NWI clients · criteria sets + offer math (max/anchor/ladder) · `verifyParcel` E2E with cached checks · **Marlon-written unit tests** on offer math + zone/wetland logic. |
| **M2 — CRM core** | Aug 19–22 | Deal Room (3-pane, thread, composer, **Property Context Card** with badges/verdict/numbers/Leaflet map) · Seller 360 · Pipeline table with filters/saved views · campaign dashboard tiles. Explain-back #2. |
| **M3 — Agent in copilot** | Aug 23–26 | State machine · classify + draft with dollar-validation · pending-draft cards in Deal Room composer · guardrails + kill switch · `agent_actions` audit · edit-rate tracking · **urgent SMS alerts (escalations, acceptances, failures) live — §11b Channel 2**. |
| **M4 — Contracts + routing + gating** | Aug 27–29 | SignWell sends + signed-webhook chain (signed/failure alerts wired) · owner XCHECK · builders/title tables · title email · campaign gating. |
| **Ship** | Aug 30–31 | **Daily briefing cron (§11b Channel 1)** · 1 Playwright E2E (inbound → draft → approve → send) · README + Loom · **one real seller thread end-to-end in copilot** · Explain-back #3 (grill). Feature freeze. |
| **Sep (≤45 min/day)** | Sep 1–30 | Autonomy graduations · adapter/state additions · prompt tuning from rejection reasons · optional Sendivo push-sync. |

**Slip rule (pre-agreed cut order):** campaign dashboard tiles → Loom → **daily briefing cron** → saved views → multi-seller variant. **Never cut:** Property Context Card, guardrails, audit log, **urgent alerts (copilot mode is only safe if escalations reach Marlon's phone in real time)**, Marlon's tests, explain-backs, approval flow.

## 13. Working agreement with Claude Code

Unchanged: milestone order is law · explain-backs at every milestone (written, no peeking — 8-10 hr days generate more code, which raises the bar) · no magic patterns · **Marlon writes offer-math + eligibility tests** · small commits, PR per feature · grill sessions at ship + Sep (defend: takeover permanence, copilot ladder, CRM-as-system-of-record vs Sendivo, adapter registry, "add Texas," "what breaks at 10 live campaigns").

## 14. Resume bullets (only once true)

- Built and deployed the platform + in-house CRM running Premier Equity's live land-acquisition pipeline (Next.js/TypeScript, PostgreSQL, Redis): SMS negotiation agent with code-enforced offer ceilings and human-in-the-loop approvals, GIS eligibility engine (FEMA flood, USFWS wetlands, pluggable county-GIS adapters), automated SignWell contract chains, and title-company routing
- Designed a conversation workspace surfacing per-parcel intelligence (flood/wetland verdicts, computed max-offer/anchor, live map, owner verification) alongside every SMS thread — replacing a third-party CRM with a purpose-built system of record
- Deployed the agent copilot-first with full audit logging, then graduated per-state autonomy using measured edit rates across ~100 reviewed conversations; integrated 5 external systems behind typed, replayable adapter interfaces

## 15. Open items (Day 1 — unchanged + one)

1. Sendivo API key (sub-account scope) + webhook token decided.
2. SignWell API key + PSA/assignment template IDs + role names.
3. County GIS endpoint links for St. Lucie, Lee, Charlotte → `/adapters/README.md`.
4. Disable Sendivo native AI Responder account-wide.
5. **New:** confirm Leaflet/OSM is acceptable for maps (no key, free) — or provide a Mapbox token if you want nicer tiles.

---

## Appendix A — stack defense table

| Choice | Why | Tradeoff owned |
|---|---|---|
| Own CRM over Sendivo's | System of record + 5-second context; transport vendors are swappable, your data layer isn't | We maintain UI Sendivo gave "free" — worth it, and the core interview story |
| Monolith, App Router | One deployable; RSC fits read-heavy CRM screens; correct at 2 users | Not microservices — describe the seams (adapters, orchestrator) where it would split |
| Polling over websockets | 2 users; simplicity wins | "Stale by ≤10s" — acceptable, stated |
| Leaflet + OSM | Free, keyless, geometry already in hand | Less pretty than Mapbox — swappable behind one component |
| Drizzle / Postgres / copilot-first / takeover-as-ownership / LLM-language-only | As previously argued | As previously argued |

## 11e. Sendivo export import — DOC AMENDMENT (Aug 15 2026)

Sendivo's API cannot be read. Verified live: `/contacts` requires a phone number, `/conversations/{id}/messages` is POST-only (405), and there is no list endpoint for conversations, messages, contacts, or opt-outs (404). The webhook is the only programmatic path in, and it only carries traffic sent *after* it works.

That leaves everything already in Sendivo — weeks of live negotiations, and **every STOP anyone has ever sent** — invisible to Premier Edge. The opt-outs are the serious half: suppression reads this database, so a seller who opted out in Sendivo gets texted again the moment a blast runs from here.

`scripts/import-sendivo.ts` reads Sendivo's CSV exports:
- `optouts` → `opt_outs` ledger + `contacts.opted_out`, creating contact rows for numbers we've never seen so the suppression survives a later list import. **Run before any Premier Edge blast.**
- `history` → contacts, deals, conversations, messages. Threads land as history; the agent is deliberately *not* run, since these were already answered and drafting replies to month-old messages would fill the queue with stale offers.

Both idempotent. Rows missing a phone, body, or readable direction are reported, never guessed — an outbound logged as inbound would be classified as if the seller said it.

## 11f. Webhook health — DOC AMENDMENT (Aug 15 2026)

Webhook failure is silent by construction: the Deal Room just stays empty while Sendivo's inbox fills. It went unnoticed through the first three weeks of live campaigns.

Two changes make it loud. A rejected call now writes `sendivo_webhook_rejected` to `agent_actions` (shape only — token length, header vs query, UA, IP; never the body, which is unauthenticated; capped at 20/hour since the URL is public). And the campaigns page carries a status strip that distinguishes the two failure modes that look identical from the outside: **rejecting** (something is calling with the wrong token — the URL is missing its `?token=`) versus **quiet** (nothing is calling at all — Sendivo isn't configured to send).

## 11g. Sendivo SMS-log sync — DOC AMENDMENT (Aug 15 2026)

`GET /sms/logs` is the one readable message endpoint Sendivo exposes — 7-day windows, paginated to 1000. Verified live: it is **outbound only**. A six-week walk returned 10,153 rows, every one from one of our own numbers, zero inbound. Seller replies arrive solely by webhook, and no amount of polling changes that.

It is still the missing piece, because every number we have ever texted is a `to_number` in those logs. That reconstructs the blast audience the API refuses to enumerate any other way — 9,780 contacts on the first production run.

Design points:
- **Contacts for everyone, threads for almost nobody.** A blast recipient who never replied is a contact, not a conversation. Opening ~9,800 threads would bury the handful of real negotiations in the Deal Room list and the pipeline, neither of which filters them. Outbound messages are held until the contact has a thread; when the webhook creates one on their first reply, the next sync backfills everything we ever sent them into it.
- **Dedupe on `message_id`**, the same identifier the webhook carries, so the sync and the webhook can never double-insert.
- **Phone format is E.164 everywhere.** `normalizeListPhone` originally returned bare 10 digits while the webhook returned `+1…`. Since `contacts.phone` is unique and `opt_outs` is keyed by phone, that split one seller into two rows and — the real damage — let a STOP recorded by SMS fail to suppress a list import. A test now asserts the two normalizers agree.
- Scheduled from the GitHub Actions workflow rather than `vercel.json`, since Hobby caps that at 2 crons and both are taken.
