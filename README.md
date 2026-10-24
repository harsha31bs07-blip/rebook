# Rebook

**When your schedule breaks, rebook everyone in one click.**

Rebook is a recovery desk for small studios that sell classes through PayPal. When an instructor calls in sick,
a room floods or the studio has to close, the owner types what happened in plain words. Rebook works out a
recovery plan for the whole week, shows it on the schedule, and after the owner approves it, moves people and
refunds the rest through PayPal.

> Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com). Every payment and refund in the
> demo is a real PayPal **sandbox** transaction. No real money moves. The studio, people and bookings are fictional.

## Try it in 60 seconds

1. Open the live demo (link coming soon) and click **Open the live demo**. You get your own studio with next
   week's classes, already paid for through the PayPal sandbox.
2. In **What happened?**, pick *"Maya has the flu and can't teach Monday"* and click **Understand disruption**.
3. Click **Plan recovery**. The schedule shows the plan: Monday's yoga is covered by Alex, dance and barre move to
   Tuesday at the same time, and each customer is kept, moved or refunded based on their own preferences.
4. Click **Approve and refund**. Five refunds go out through PayPal; each receipt shows its PayPal refund id.
5. Open **Dashboard** and ask the Recovery analyst *"What did Monday's disruption cost us?"*.

## What happens under the hood

| Step | What Rebook does |
| --- | --- |
| Understand | Gemini turns the owner's sentence into a structured disruption (who or what, which day, which hours). Names and times are resolved by our code against the studio's real data, never trusted from the model. If the model is busy, a rules parser takes over and the UI says so. |
| Plan | A deterministic solver tries, for every affected class: a qualified substitute, another room, another time inside the same week, and only then cancellation. Each booking is then kept, moved (only if the new time fits that customer's availability) or refunded. A validator proves the plan has no double-booked instructor or room, no class over capacity and no class inside the disruption. |
| Review | The plan is drawn on a Bryntum Scheduler: the disrupted window is hatched, original classes stay as dashed ghosts, new placements are highlighted with arrows. Totals show revenue kept against refunds. |
| Execute | Refunds go to the original PayPal captures through the PayPal Server SDK. Every refund is written to a ledger before the API call and carries a stable `PayPal-Request-Id`, so a retry after a timeout can never refund twice. Unknown outcomes are reconciled against PayPal before retrying. |
| Explain | An AG Studio dashboard reads the workspace's real bookings, captures and refunds. Custom widgets show recovery impact and refund receipts; a Recovery analyst agent (AG Studio Agent Framework on Gemini) answers questions about cost and coverage. |

## Built with

- **PayPal**: Orders v2 (server-side capture for seeded bookings), Payments v2 refunds, Webhooks
  (signature verification), Transaction Search, through the APIMatic-generated
  [PayPal Server SDK](https://www.npmjs.com/package/@paypal/paypal-server-sdk).
- **Bryntum Scheduler** (React): owner-adjustable recovery previews, instructor/room views, constraint ranges,
  daily utilisation, keyboard moves and a trial fallback. See [Bryntum features used](docs/bryntum.md#bryntum-features-used).
- **AG Studio** (React): data model with relationships, custom widgets with forms, theming, saved report state,
  Agent Framework with a custom agent and custom tools.
- **Gemini** (free tier) for language understanding and the analyst, with model fallback and a rules fallback.
- Next.js 16, React 19, TypeScript, zod, Node's built-in `node:sqlite`, Vitest.

## Run it locally

Requires Node.js 24+ and a PayPal sandbox REST app (developer.paypal.com). A Gemini API key is optional: without
it, disruptions are parsed by the rules fallback and the analyst is unavailable.

```sh
npm install
cp .env.example .env.local   # fill in PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV=sandbox, GEMINI_API_KEY
npm run build && npm start   # http://localhost:3000
npm test                     # unit and integration tests (PayPal and Gemini are mocked)
```

Set `DEMO_REAL_CAPTURES=0` to run without calling PayPal (all payments are simulated and labelled as such).

## Honest limits

- The demo studio is fictional and lives in a per-visitor workspace. On the free hosting tier the server can
  restart at any time; demos then end and you can start a fresh one in one click. PayPal keeps every sandbox
  transaction regardless.
- Only bookings in the demo's disruption scenarios are paid with real sandbox captures; the rest of the week is
  simulated so a new demo is ready in seconds. Simulated payments are labelled everywhere.
- Bryntum and AG Studio run in trial mode, so their trial notices or watermarks may appear.

## Licence

MIT for this repository's code. Bryntum Scheduler and AG Studio are commercial products with their own licences.
