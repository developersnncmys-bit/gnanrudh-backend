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

## Phase 2 — done

Every Phase 2 issue ID has shipped. Admin build and backend syntax are clean.

| ID | Status | Backend commits | Admin commits | Script |
|---|---|---|---|---|
| INV-01 / AUD-01 | fixed | `f177b92` (joint) | — | — |
| INV-02 | fixed | `99bb920` | `6a1e5f7` | — |
| CUS-03 | fixed | — | `1ecf227` | — |
| CAT-05 | fixed | `28d7dae` | `0531312` | — |
| CAT-06 | fixed | — | `7ef4115` | — |
| CAT-04 | fixed | `cdf336a` | `e8803dc` | — |
| CAT-01/02/03/07 | fixed | — | `3284aea` | — |
| CONT-01 | fixed | `3dca5cf` | `f2a59cc` | — |
| DATA-04 / CUS-01 | fixed | `1a28942` | — | `scripts/recompute-crm.js` |
| DATA-03 / REV-01 | fixed | `b06390a` | `18642da` | — |
| IMG-01 | fixed — needs CLOUDINARY_URL env | `1e48276` | — | — |

### What Phase 2 changes operationally

1. **Orders never oversell.** Payment confirm now reserves pieces atomically
   (`findOneAndUpdate`). If a variant is sold out, the request fails 409 and
   the payment is not marked paid — the brief's "200 racers on last piece,
   exactly 1 winner" invariant now holds.
2. **Stock is single-sourced.** `variant.stock` is derived from Piece rows.
   The admin form shows it read-only; incoming writes have the field stripped
   server-side. New stock enters only through "Receive stock" on each variant,
   which calls `/api/pieces/receive` and creates barcoded pieces.
3. **Admin never crashes on stale references.** Order, return and customer
   drawers render soft "not found" panels when a referenced product, customer
   or order was deleted, instead of throwing.
4. **CRM figures are live.** `recomputeCustomer(cid)` runs after every event
   that changes payment state — confirm-payment, cancel, refund, return-refund.
   LTV uses the Paid / COD-collected rule from LOGIC-01.
5. **Reviews require a delivered purchase.** New reviews must carry `oid`,
   that order must belong to the reviewer and be in status `Delivered`, and
   the product must appear in its items. The old 12 drive-by reviews stay as
   `verified: false` and are flagged in the moderation UI.
6. **Uploads go to Cloudinary in production.** When `CLOUDINARY_URL` is set,
   `/api/uploads` streams the file to Cloudinary and returns the `secure_url`.
   No env var → disk (dev). `imageUrls` schema validator blocks any non-https
   URL from being saved, so stale `http://localhost:4000/uploads/...` values
   cannot land.

### Extra things you still owe me (adds to Phase 1 list)

7. **Cloudinary account + env var (IMG-01)** — sign up at cloudinary.com,
   copy the Environment variable string (`CLOUDINARY_URL=cloudinary://...`),
   set it on the backend Vercel project. Rebuild. Existing broken images
   remain broken — they were `localhost:4000/...` URLs that never resolved.
   Upload fresh ones through the product form once CLOUDINARY_URL is live.
8. **Recompute historical CRM (DATA-04)** — one dry-run, then one apply:
   ```
   MONGO_URI=... node scripts/recompute-crm.js
   MONGO_URI=... node scripts/recompute-crm.js --apply
   ```

### Dry-run scripts added in Phase 2

- `scripts/recompute-crm.js` — scans and optionally rewrites every customer's
  LTV / orderCount / lastOrder / segment using the new rule.

### Known gaps carried into Phase 3

- **Storefront "hide empty categories"** (CAT-05) is only flagged in the admin
  today. The storefront repo isn't in this workspace — add the same filter in
  its category index query when you have it.
- **Journal "views"** (CONT-01) currently come from a seed field and no code
  increments them. Phase 3 (DATA-01/02) will wire real analytics or hide the
  number.

---

## Phase 3, 4

Pending. Will append here as each lands.
