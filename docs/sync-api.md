# Booking system sync

Rebook sits beside the booking system. Import its studio week first, then connect a script, Zapier, Make, or vendor-specific middleware to this API. No vendor connector is bundled. Inbound events never capture, refund, or otherwise move money. The workspace covers one studio week and expires with the demo.

## Authentication and limits

The owner console’s **Booking system sync** panel reveals a private, per-workspace 43-character key and endpoint URLs. Send `Authorization: Bearer <key>` over HTTPS. The key is an HMAC of the server secret in the `sync:<workspaceId>` domain. Customer, instructor, waitlist, credit, public booking, and other workspace keys are not accepted. This is bearer authentication, not an additional per-payload signature.

All three server-to-server endpoints below share 60 requests/minute per workspace + client IP. They accept cross-origin server requests; no browser CORS access is provided. Missing/bad keys return 401, unknown/expired workspaces 404, invalid JSON/schema 400, oversized bodies 413, and rate limits 429 with `Retry-After`. Responses use `Cache-Control: no-store`. A busy workspace can return 409; retry with the same event ids.

Use `Content-Type: application/json` for POSTs. Times are ISO instants with offsets; amounts are USD decimal strings such as `"22.00"`. IDs below are illustrative.

## Pull → apply → acknowledge

`GET /api/workspaces/<workspaceId>/sync/changes`

```json
{ "changes": [{ "id": "plan:p:session:s1", "occurredAt": "2026-11-05T12:00:00Z", "type": "session.cancelled", "session": { "id": "s1", "title": "Dance Flow", "start": "2026-11-09T23:00:00Z", "end": "2026-11-10T00:00:00Z", "instructor": "Maya", "room": "Studio" } }], "pending": 1 }
```

Returns unacknowledged Rebook changes, oldest first (timestamp, then stable id), at most 200. `pending` counts all remaining changes. IDs identify durable operations and remain stable across reads/restarts. Store applied IDs in your connector too: delivery is at least once, and a failed acknowledgement must not apply a move or return twice. Tied timestamps do not imply dependencies; apply session changes before matching booking changes when your vendor requires it. Reads derive the feed from approved plan snapshots, money/visit ledger, latest choice outcomes, claimed offers and confirmed checkouts; imported rows and inbound writes are not echoed.

After applying a batch in the booking system:

`POST /api/workspaces/<workspaceId>/sync/ack`

```json
{ "ids": ["plan:p:session:s1"] }
```

```json
{ "acknowledged": 1, "pending": 0 }
```

Up to 500 IDs per request, body at most 200 KiB. Unknown IDs are ignored; repeat acknowledgements return `acknowledged: 0`. Acknowledge only changes successfully applied, then pull again until `pending` is zero. Acknowledgements persist until workspace reset/deletion. They do not change money or erase audit history.

### Outbound types

Every change has `id`, `occurredAt`, and `type`. Session objects include `{ id, title, start, end, instructor, room }`; customer objects include `{ id, name, email? }`. Match by IDs after the first mapping, using the human fields to establish vendor record mappings.

`session.moved` includes the whole before/after placement, including substitute instructors and room changes. Corrections and owner-adjusted approved plans produce their own changes.

```json
{ "id": "plan:p:session:s1", "occurredAt": "2026-11-05T12:00:00Z", "type": "session.moved", "session": { "id": "s1", "title": "Dance Flow", "start": "2026-11-10T23:00:00Z", "end": "2026-11-11T00:00:00Z", "instructor": "Maya", "room": "Studio" }, "before": { "id": "s1", "title": "Dance Flow", "start": "2026-11-09T23:00:00Z", "end": "2026-11-10T00:00:00Z", "instructor": "Maya", "room": "Studio" }, "after": { "id": "s1", "title": "Dance Flow", "start": "2026-11-10T23:00:00Z", "end": "2026-11-11T00:00:00Z", "instructor": "Maya", "room": "Studio" } }
```

`session.cancelled` retains the removed class’s details.

```json
{ "id": "plan:q:session:s1", "occurredAt": "2026-11-05T12:01:00Z", "type": "session.cancelled", "session": { "id": "s1", "title": "Dance Flow", "start": "2026-11-10T23:00:00Z", "end": "2026-11-11T00:00:00Z", "instructor": "Maya", "room": "Studio" } }
```

`booking.moved` comes from a plan or customer move. A class moving in time keeps its Rebook session ID; a customer picking a different class has different `from.id`/`to.id`.

```json
{ "id": "plan:p:booking:b1", "occurredAt": "2026-11-05T12:00:00Z", "type": "booking.moved", "bookingId": "b1", "customer": { "id": "c1", "name": "Avery", "email": "avery@example.com" }, "from": { "id": "s1", "title": "Dance Flow", "start": "2026-11-09T23:00:00Z", "end": "2026-11-10T00:00:00Z", "instructor": "Maya", "room": "Studio" }, "to": { "id": "s1", "title": "Dance Flow", "start": "2026-11-10T23:00:00Z", "end": "2026-11-11T00:00:00Z", "instructor": "Maya", "room": "Studio" } }
```

`booking.cancelled` reasons are `refunded`, `credited`, or `cancelled` (pack/membership). Cash/credit amounts are included. Refund cancellation appears once the refund is completed, simulated, or accepted as pending; a pending refund is not proof of settlement. Never issue another refund in response to the feed.

```json
{ "id": "refund:p:b1", "occurredAt": "2026-11-05T12:00:00Z", "type": "booking.cancelled", "bookingId": "b1", "customer": { "id": "c1", "name": "Avery" }, "session": { "id": "s1", "title": "Dance Flow", "start": "2026-11-09T23:00:00Z", "end": "2026-11-10T00:00:00Z", "instructor": "Maya", "room": "Studio" }, "reason": "refunded", "amount": "22.00" }
```

`pack.visit_returned` is one return per booking, with `visitsLeftAfter` only when the imported/synced baseline is known. Apply the return exactly once; the balance is a convenience snapshot, not an additional increment.

```json
{ "id": "pack:ledger1", "occurredAt": "2026-11-05T12:00:00Z", "type": "pack.visit_returned", "bookingId": "b2", "customer": { "id": "c1", "name": "Avery" }, "visitsLeftAfter": 4 }
```

`booking.created` sources are `waitlist` and `checkout`. A paid waitlist checkout appears once with source `waitlist`; entitlement claims include `entitlement` and zero amount. A studio credit checkout is also included.

```json
{ "id": "created:b3", "occurredAt": "2026-11-05T12:10:00Z", "type": "booking.created", "bookingId": "b3", "source": "waitlist", "customer": { "id": "c1", "name": "Avery" }, "session": { "id": "s1", "title": "Dance Flow", "start": "2026-11-10T23:00:00Z", "end": "2026-11-11T00:00:00Z", "instructor": "Maya", "room": "Studio" }, "amount": "0.00", "entitlement": { "kind": "pack", "name": "Ten classes", "visitsLeft": 4 } }
```

## Push booking-system events

`POST /api/workspaces/<workspaceId>/sync/events`

```json
{ "events": [{ "eventId": "vendor-cancel-123", "type": "booking.cancelled", "session": { "id": "s1" }, "customer": { "name": "Avery", "email": "avery@example.com" } }] }
```

```json
{ "results": [{ "eventId": "vendor-cancel-123", "status": "applied" }] }
```

Send 1–100 events, at most 200 KiB. Choose a stable nonempty `eventId` (max 100 characters) per vendor operation. Events run in input order inside the workspace lock; each event is atomic. Mixed applied/rejected batches return 200. A later event can depend on an earlier applied event. Replaying an applied event returns status `duplicate` and changes nothing. A rejected event is not final: retry it with the same event ID once its cause is fixed (for example after the owner approves or discards an open recovery preview). Do not reuse an ID for different payloads or event types. Persisting a result and its mutation is atomic.

Session references are either `{ "id": "s1" }` or `{ "title": "Dance Flow", "start": "2026-11-10T23:00:00Z" }`. Titles match case-insensitively, times match the exact instant. Ambiguous matches reject. Customer references require `name` and optionally `email`: email matches first case-insensitively, then exact name. Ambiguous names reject; use email. New customers are created only for `booking.created` and `waitlist.joined`. Missing email does not become a deliverable address.

All mutations reject while a recovery preview is open: `A recovery preview is open; approve or discard it first.` Missing/cancelled classes and classes that have started reject. No money is touched, and no inbound event is echoed in the outbound feed (a later Rebook recovery or claimed waitlist offer is a new Rebook operation).

### Inbound types (each object belongs in `events`)

Create an active booking. Seat checks include active bookings, held checkouts and open waitlist offers. Full classes reject with `Class is full`; already-booked customers reject. `amount` defaults to the class price, or zero for an entitlement. No payment is created. Entitlements accept `kind: "pack" | "membership"`, optional `name`, `visitsLeft` (pack only), and date-only `expires`.

```json
{ "eventId": "vendor-book-124", "type": "booking.created", "session": { "id": "s1" }, "customer": { "name": "Avery", "email": "avery@example.com" }, "entitlement": { "kind": "pack", "name": "Ten classes", "visitsLeft": 4, "expires": "2026-12-01" }, "amount": "0.00" }
```

Cancel an active booking, then offer the freed seat to the waitlist. Cancellation does not refund or return visits; send a separate baseline event if the vendor changes the pack balance.

```json
{ "eventId": "vendor-cancel-125", "type": "booking.cancelled", "session": { "id": "s1" }, "customer": { "name": "Avery", "email": "avery@example.com" } }
```

Set the customer’s pack baseline (nonnegative integer), optionally updating its expiry. Displayed balance = baseline + returned visits whose outbound changes have not been acknowledged. Acknowledged returns are assumed included in the vendor baseline. Workspaces without this event retain imported minimum-balance arithmetic. This generic event represents one customer-level pack balance; connectors for multiple independent packs must consolidate/map them before posting. Acknowledging pending returns removes their provisional addition; send the vendor’s new baseline as it changes.

```json
{ "eventId": "vendor-balance-126", "type": "pack.balance", "customer": { "name": "Avery", "email": "avery@example.com" }, "visitsLeft": 4, "expires": "2026-12-01" }
```

Join the waitlist (existing entries remain in FIFO order), then fill free seats with offers.

```json
{ "eventId": "vendor-wait-127", "type": "waitlist.joined", "session": { "id": "s1" }, "customer": { "name": "Avery", "email": "avery@example.com" }, "entitlement": { "kind": "membership", "name": "Unlimited" } }
```

Leave the waitlist and withdraw that customer’s open offer, then advance the queue. A pending offer checkout is failed; a capture being reconciled rejects the event so its payment can settle first.

```json
{ "eventId": "vendor-left-128", "type": "waitlist.left", "session": { "id": "s1" }, "customer": { "name": "Avery", "email": "avery@example.com" } }
```

Change class capacity (integer 1 through the current room’s capacity), then fill available seats. Cannot reduce below active bookings + held seats.

```json
{ "eventId": "vendor-capacity-129", "type": "session.capacity", "session": { "title": "Dance Flow", "start": "2026-11-10T23:00:00Z" }, "capacity": 20 }
```

## Owner tools and CSV

The private owner workspace GET includes `sync: { key, pending, recentChanges, recentEvents }`; the panel shows the latest ten pending changes and last ten processed inbound outcomes. `POST /api/workspaces/<workspaceId>/sync/ack-all` with `{}` uses the owner workspace capability and same-origin checks, not the sync key. It marks every currently derived change applied. Use it only after manually applying them.

`GET /api/workspaces/<workspaceId>/pack-balances?pending=1` exports unacknowledged pack-return rows. The default CSV stays cumulative. Both require the owner workspace capability and retain formula-injection escaping. Downloading does not acknowledge rows. The pending CSV and JSON feed share acknowledgements.

## Demo script

With Node 22+ (no dependencies):

```sh
node scripts/sync-demo.mjs https://your-rebook.example WORKSPACE_ID SYNC_KEY
```

Use a disposable demo: the script pulls, prints and acknowledges outbound changes, reads the owner state to pick an upcoming active booking, then posts a cancellation, joins that customer to its waitlist, and replays the cancellation ID. It changes booking records but never calls a payment endpoint. A vendor connector would apply outbound changes through the vendor API before acknowledging, and obtain inbound data from vendor webhooks/polling instead of the owner state.
