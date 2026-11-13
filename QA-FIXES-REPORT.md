# QA fix report — qa-fixes-nov26

Work against the 13 November 2026 QA audit. Branch `qa-fixes-nov26` on both
`backend/` and `gnanrudh-admin/`; one commit per issue ID.

> This file is a living summary. Phases 2, 3 and 4 append below as they land.

---

## Phase 1 — done

All 13 Phase 1 issue IDs have shipped as separate commits. Admin `vite build`
and backend `node --check` are clean on every file touched.

| ID | Status | Backend commits | Admin commits | Script |
|---|---|---|---|---|
| SEC-01 | fixed | `7240cff` | — | — |
| SEC-02 | fixed | `e73b730` | — | — |
| SEC-05 | fixed | — | `483a964` | — |
| LOGIC-01 | fixed | `28a3e60` | `e0e08d5` | — |
| LOGIC-02 | fixed | `75841c1` | `1e5fde5` | — |
| VAL-01 | fixed | `9d221a5` | `3196e99` | — |
| TAX-03 | fixed | `1c12d7a` | — | `scripts/report-out-of-sequence-invoices.js` |
| TAX-02 | fixed | `3741fff` | `d001f1f` | — |
| TAX-01 | fixed — needs seller details | `91e6a93` | `33041ff` | — |
| SEC-03/04 | fixed — needs role mapping | `65e468e` | `1ca49d0` | `scripts/migrate-user-roles.js` |
| LEGAL-01 | fixed — needs policy text | `5a24217` | `fcf6244` | — |
| CPN-01/02 | fixed | `131c621` | — | `scripts/report-coupon-violations.js` |
| RET-01/02/03 | fixed — forward-only | `097b921` | `4debd25` | `scripts/backfill-deliveredAt.js` |

### You still owe me

Everything below is content, not code. Until these are supplied, tax invoices,
policy pages, and some login paths behave as described in the "Status" column.

1. **Real seller details (TAX-01)** — tax invoices are blocked while any of
   these look like the seeded placeholders. Supply via `Settings → Business`:
   - business name (`store.name`)
   - GSTIN (`gst.gstin`) — regex `^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$`
   - business phone (`store.phone`) — anything containing `x` is rejected
   - full business address (`store.address`) — ≥20 chars, not the exact
     "Bengaluru, Karnataka 560001" placeholder
   - After Settings is saved, re-hit `POST /orders/:id/invoice` for any order
     stuck without a number.

2. **Policy page bodies (LEGAL-01)** — all 7 pages (Our house, Contact, Shipping
   policy, Returns policy, Privacy policy, Terms of use, GST policy) have TODO
   stubs. Each shows a "Stub body" badge on *Storefront → Pages* while under 800
   characters. Supply the full text in the admin page editor; markdown is
   supported (`# heading`, `**bold**`, `- list`, `[link](url)`). Returns Policy
   can use these tokens — they substitute from Settings at render time so you
   never edit this page when the policy changes:
   - `{{returnWindow}}`
   - `{{returnConditions}}`
   - `{{reverseShippingRule}}`

3. **Role mapping (SEC-03)** — the old enum was `admin|staff`. New enum is
   `owner|manager|packer|support`. Existing users still hold the old values and
   will fail validation on their next save. Run the dry-run first:
   ```
   MONGO_URI=... node scripts/migrate-user-roles.js --dry-run
   # review the plan
   MONGO_URI=... node scripts/migrate-user-roles.js --apply --owner-email=you@houseofgnanrudh.com
   ```

4. **Historical `deliveredAt` backfill (RET-01)** — forward-only by default.
   Existing delivered orders have `deliveredAt: null`; their return eligibility
   is therefore "not delivered yet" and requests go to *Not eligible*. Run:
   ```
   MONGO_URI=... node scripts/backfill-deliveredAt.js            # dry-run
   MONGO_URI=... node scripts/backfill-deliveredAt.js --apply
   ```

5. **Vercel env vars** — set on the **backend** project (`gnanrudh-backend`):
   - `JWT_SECRET` must be a strong random string (≥32 bytes). SEC-01 requires
     HS256 so the secret length matters.
   - `MONGO_URI` must point to the Atlas cluster. Already set.
   - `CORS_ORIGIN` should list the current admin URL plus any custom domain.
   On the **admin** project (`gnanrudh-admin`):
   - `VITE_API_URL` currently baked at build time — if the backend URL ever
     changes, rebuild.

6. **Rotate the leaked `.env`** — the admin `.env` was committed to GitHub
   history before `.gitignore` arrived. Every secret in that file is public.
   Rotate: Razorpay keys, Shiprocket keys, any session tokens. Call me if you
   want help rewriting history to purge it.

### Dry-run reports to run against staging

Each one is read-only unless `--apply` is passed.

- `scripts/report-out-of-sequence-invoices.js` — flags invoices whose FY or
  sequence number regresses (TAX-03).
- `scripts/report-coupon-violations.js` — flags existing orders that break
  their coupon's rules, plus `uses`-counter drift (CPN-01/02).
- `scripts/backfill-deliveredAt.js` — reports or applies `deliveredAt` from
  historical `ShipEvent type: 'Delivered'` records (RET-01).
- `scripts/migrate-user-roles.js` — reports or applies the admin/staff →
  owner/manager/packer/support mapping (SEC-03).

### QA suite verification (not yet run)

The QA brief's acceptance tests live in `gnanrudh-qa/tests/api/`. Per the
brief's rule 3 (never point at production data), these must run against a
staging backend with a dedicated Mongo. No staging URL exists today; the
options are:

- Spin up a `gnanrudh-backend-staging` Vercel project against a fresh Atlas
  database, seed via `backend/src/seed.js`, point `gnanrudh-qa/.env` at it.
- Run the backend locally with a local Mongo (`npm run dev`), point Playwright
  at `http://localhost:4000`, seed a fresh DB.

Say the word and I'll set either up.

### Not touched intentionally

- Razorpay / Shiprocket live keys (brief rule 5).
- Any `.env` file content (brief rule 5).
- Vercel project settings beyond the admin `vercel.json` (brief rule 5). SEC-03
  env var additions listed in "You still owe me".
- Existing commit history. One commit per issue ID, no squashing.

---

## Phase 2, 3, 4

Pending. Will append here as each lands.
