# Mindbody sandbox connector

Rebook maps Mindbody Public API v6 to the [sync API](sync-api.md). The connector is restricted to the free, shared sandbox studio (SiteId `-99`). Unit tests use trimmed, anonymised responses recorded from that sandbox on October 30, 2026, and make no network requests. The full loop was also verified live against the sandbox (`MINDBODY_LIVE=1 npx vitest run test/mindbody-live.test.ts`): import, an instructor swap, a class moved to a new time with its customers, an on-time removal returning a pack visit, and a booking made in Mindbody arriving in Rebook without echoing Rebook's own writes.

## Run locally

Use Node 24 or later, install dependencies with `npm ci`, and copy `.env.example` to `.env.local`. Obtain your own free sandbox API key from the [Mindbody developer portal](https://developers.mindbodyonline.com/). Set this server variable:

```dotenv
MINDBODY_API_KEY=your-own-sandbox-key
```

Run `npm run dev`, open `/import`, and select **Import from Mindbody (sandbox)**. Review the summary and warnings, then open the workspace. Only an enabled boolean reaches the browser; the API key and staff access token stay on the server. Removing the key disables the option and all three connector routes return 404.

For sandbox staff calls, the default public credentials are `mindbodysandboxsite@gmail.com` / `Apitest1234`. Override them with `MINDBODY_STAFF_USERNAME` and `MINDBODY_STAFF_PASSWORD` if needed. These defaults apply only to SiteId `-99`; there is no live-site environment switch. Tokens are cached in memory and refreshed once on a 401. No payment settings change: PayPal remains sandbox only.

The shared sandbox resets nightly at **12:00 AM PST**. Reimport after a reset if classes or clients disappear. Other developers can modify the same records. The connector does not run a background polling job; the owner explicitly sends and checks changes.

## What is mapped

- Import reads the next Monday on or after today in the site's timezone, through Sunday. `POST /api/import/mindbody` accepts `{ "weekStart": "2026-11-02" }` to choose another Monday. The import function also supports `locationId`; by default it chooses the location with the most noncancelled classes that week.
- Sessions, instructors, rooms, clients and visits have stable `mb-class-`, `mb-staff-`, `mb-room-`, `mb-client-` and `mb-visit-` IDs. Classes without a resource are spread over numbered location spaces so they never collide. Mindbody allows an instructor or resource to be double-booked; Rebook needs a feasible week, so the later class of such a clash is left out with a warning. Room capacity is the highest class capacity seen in that room.
- Class names map to yoga, pilates, spin, dance, hiit or barre. Unsupported activities, such as swimming, assessments, kids and semi-private appointments, are omitted with a warning. Cancelled classes and late-cancelled visits are excluded.
- Local API timestamps are converted in the site's IANA timezone, including daylight saving transitions. Ambiguous clocks use the earlier instant, matching CSV import conversion.
- Instructor skills come from classes they teach that week. Unknown instructor availability, customer availability and opening hours use the CSV import assumptions. Mindbody provides no per-class price, so cash bookings use the same **$20.00** default. Imported payments and later inbound cash bookings are simulated. Mindbody imports do not authorize customer email delivery.
- A visit's matching client service supplies its pack balance and expiration. Unlimited and membership names map to membership seats. Other visits use simulated cash. Rebook currently has one balance baseline per customer; clients using several packs receive a warning, and the last imported pack is tracked. Service IDs are retained for moving existing bookings.
- Pull compares roster visit IDs, waitlist entry IDs, capacity and tracked service balances with the persisted snapshot. It feeds bookings, cancellations, waitlist joins/leaves, capacity and pack balances through `receiveEvents`. Successful and duplicate events advance the snapshot; rejected events remain for the next check. Event IDs are deterministic; a recurring capacity or balance value gains a transition suffix to avoid confusing it with an earlier event.
- An externally cancelled class produces booking cancellation events. The sync API has no inbound session cancellation event, so it does not remove that session from Rebook's schedule.

## Sending a recovery

In **Booking system sync**, choose **Send changes to Mindbody**. Changes run oldest first, with parent class changes before their dependent booking changes. Only successful changes are acknowledged. Failed changes keep their Mindbody error message and remain pending. Same-origin checks, per-client limits, a persistent connector lease and the workspace write lock guard these operations.

An instructor-only change calls `substituteclassteacher`. Mindbody has no move-single-instance endpoint. A time or room change therefore:

1. Creates a one-day schedule with the same description, location and capacity at the replacement time, room and instructor.
2. Uses the new instance id from the response (`ClassInstanceIds`); if the response was lost, discovers it through `class/classes`, matching date, description, staff, resource and start time, excluding instances that existed before the request. Start and end times are sent as `1900-01-01THH:MM:SS`: Mindbody reads only the time and rejects a bare clock.
3. Adds active Rebook customers, retaining their original client service when known, with `RequirePayment: false` and `SendEmail: false`.
4. Cancels the original instance with both client and staff email flags false, then persists the session's new ClassId.

Mindbody refuses to create classes whose class description is inactive (about half of the sandbox's class types). The import lists them in a warning, and a time or room move of such a class fails with a plain message to move it in Mindbody by hand; instructor swaps and booking changes for it still sync.

The progress journal survives retries, including a lost creation response. A schedule whose creation outcome is uncertain is discovered before any further creation attempt. If no replacement can be discovered, the change stays pending for review; it is not automatically recreated. Schedule creation and client creation are not blindly retried after a server error. Other calls retry 429/5xx once with bounded backoff. Each import, push or pull has a 300-call budget.

Customer moves remove the original booking on time and add it to the target's current ClassId. Cancellations use `LateCancel: false`, which returns a pack visit within Mindbody. The pack-return change confirms that balance where available. New customers are resolved by their Mindbody ID or exact email, then created if missing. Ambiguous email matches fail for review. “Already in class”, “not in class”, and “already cancelled” responses are safe retries.

Own roster changes and expected pack effects are recorded so the next pull does not echo them. **Check Mindbody for changes** displays applied and rejected inbound results. The generic API and pack CSV controls remain available.

## Boundaries and live checks

Mindbody payments/refunds, membership billing, purchases, descriptions, staff availability, new remote classes and arbitrary schedule edits are not synced. Cash refunds for these imported bookings remain simulated in Rebook; the connector never refunds money in Mindbody. A capacity increase above the imported room maximum is rejected by the existing sync API until the room constraint is reviewed. An open recovery preview also rejects inbound events until approved or discarded. No rejected snapshot change is discarded.

Waitlist reads depend on API permission. Import reports a warning if unavailable; pull fails and retains its snapshot instead of interpreting the error as an empty waitlist. Only classes with current or previously observed bookings need roster calls. Clients and services are fetched in batches or once per distinct client, respectively.

All write bodies live in `lib/connectors/mindbody/requests.ts` for live correction. In particular, the exact `addclassschedule` response is unverified and intentionally unused. Confirm one-day schedule fields, default staff pay rate `1`, resource matching, service reuse and all no-email flags against the live sandbox before a pilot. Cross-system class moves are multi-step and can be partially applied; retries resume them, but there is no distributed rollback. Cancellation requires both schedule management and cancellation permissions according to [Mindbody's release notes](https://developers.mindbodyonline.com/Resources/ApiReleaseNotes).

```sh
npx vitest run --pool=threads
npx tsc --noEmit
npx eslint .
```

Fixtures in `test/fixtures/mindbody` retain sandbox IDs and shapes with invented names and emails. `waitlist-error.json` is the recorded error shape; the successful empty waitlist fixture and test-only joins are constructed from the documented field list.
