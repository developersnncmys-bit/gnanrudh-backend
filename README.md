# House of GnanRudh — Backend

Express + Mongoose REST API for the admin.

## Setup

```sh
cd backend
npm install
cp .env.example .env         # edit MONGO_URI / PORT / CORS_ORIGIN as needed
npm run seed                 # populates MongoDB with fixture data
npm run dev                  # http://localhost:4000
```

Requires a running MongoDB (default: `mongodb://127.0.0.1:27017/house_of_gnanrudh`).

## Endpoints

Every resource below exposes standard REST:

```
GET    /api/<resource>           ?q=&sort=&dir=&limit=&skip=&<filter>=
GET    /api/<resource>/:id
POST   /api/<resource>
PATCH  /api/<resource>/:id
PUT    /api/<resource>/:id
DELETE /api/<resource>/:id
```

| Resource    | Path                | Filters                              |
| ----------- | ------------------- | ------------------------------------ |
| Categories  | `/api/categories`   | `visible`, `saree`                   |
| Products    | `/api/products`     | `cat`, `status`, `zari`, `occasion`  |
| Customers   | `/api/customers`    | `segment`, `city`, `state`           |
| Orders      | `/api/orders`       | `status`, `payment.status`, `cid`    |
| Returns     | `/api/returns`      | `status`, `cid`, `oid`               |
| Shipping    | `/api/shipping`     | `oid`, `courier`, `webhook`, `type`  |
| Coupons     | `/api/coupons`      | `on`, `kind`                         |
| Reviews     | `/api/reviews`      | `status`, `pid`, `cid`, `rating`     |
| Journal     | `/api/journal`      | `status`, `type`                     |

### Action endpoints (beyond CRUD)

**Orders**
- `POST /api/orders/:id/confirm-payment` — marks paid, generates invoice + AWB, logs a ship event
- `POST /api/orders/:id/cancel`
- `POST /api/orders/:id/ndr` — `{ action: 'reattempt' | 'address' | 'rto', pin?, address?, phone? }`
- `POST /api/orders/:id/refund` — `{ amount }`
- `GET  /api/orders/stats/counts`

**Returns**
- `POST /api/returns/:id/approve` — schedules reverse pickup
- `POST /api/returns/:id/picked`
- `POST /api/returns/:id/received`
- `POST /api/returns/:id/refund` — issues credit note, restores stock
- `POST /api/returns/:id/reject`

**Products**
- `PATCH /api/products/bulk` — `{ ids: [...], status }`

**Customers**
- `POST /api/customers/:id/notes` — `{ text, at? }`
- `POST /api/customers/notes` — bulk: `{ ids, text }`

**Reviews**
- `POST /api/reviews/:id/approve | /reject | /reply`
- `POST /api/reviews/bulk/approve | /reject` — `{ ids }`

**Coupons**
- `POST /api/coupons/:id/toggle`

**Shipping**
- `POST /api/shipping/:id/sync`

### Singletons / content

- `GET /api/featured` → `{ ids: [...] }` — homepage featured products
- `PUT /api/featured` — replace the list
- `GET /api/scenes` / `PUT /api/scenes` — homepage scenes (array)
- `GET /api/pages` / `GET /api/pages/:name` / `PUT /api/pages/:name` — CMS pages
- `GET /api/settings` — merged settings + CRM + policy
- `PATCH /api/settings/:section` — section ∈ `store | pay | ship | gst | account | crm | policy`

### Stats

- `GET /api/stats/queue` — dashboard badge counts
- `GET /api/stats/dashboard?range=7` — revenue KPIs
- `GET /api/stats/sales-by-category?days=30`
- `GET /api/stats/revenue-series?days=30`

### Health

- `GET /api/health`
