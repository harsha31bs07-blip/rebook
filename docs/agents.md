# Agent-ready studio

Every Rebook studio has a remote [MCP](https://modelcontextprotocol.io) server, so a customer's own AI assistant (any compatible Streamable HTTP MCP client) can find a class, book it, join a waitlist, or answer the private rebooking link the studio sent after a disruption.

```
https://rebook-by9u.onrender.com/api/mcp/<bookingId>
```

`<bookingId>` is the same public capability as the studio's booking page (`/b/<bookingId>`): it can read classes and start checkout, never reach the owner console. The booking page and the owner console's **Studio tools → AI agents** show the full address with a copy button.

## The money rule

The agent prepares; the person decides.

- **Booking:** `book_class` holds the seat for 10 minutes and creates a PayPal order (Orders v2) whose `experience_context` returns to the studio. The tool returns PayPal's `payer-action` link. The person opens it, approves on PayPal's own page, and lands on `/b/<bookingId>/paid`, which captures through the same verified checkout path as the booking page (idempotent capture; the server rechecks availability before capture and reconciles uncertain capture outcomes). The agent never sees card details and cannot approve.
- **Money going back:** an assistant can't send it. A non-entitled `refund`, or a `move` to a cheaper class, doesn't apply: `answer_rebooking` returns `needs_person` with the amount, the destination and a `reviewUrl`, the person's own private page, where they confirm it themselves. There is no confirm flag, because a value an assistant supplies proves nothing. Keeping, a move with no price difference, studio credit (no money leaves) and returning a pack or membership visit apply directly.
- Prices, refund amounts and seat counts always come from the server.

## Tools

| Tool | Does |
|---|---|
| `list_classes` | Upcoming classes: studio-local day and time, instructor, room, price, seats left, `open` / `full - join_waitlist` / `paused`. Filters: `day` (YYYY-MM-DD or weekday), `classType`, `query`. |
| `book_class` | `classId`, `name`, `email` → seat held, `approvalUrl`, `holdExpiresAt`. Retries for the same person and class return the same link until the hold ends, even for the last seat; while a payment is being confirmed the answer says so and no new order is made. A full class suggests `join_waitlist`. |
| `join_waitlist` | Only for full classes; one place per email. Freed seats are offered in order with a private link. |
| `get_rebooking_options` | `link` (the person's `/c/...` link or token) → what changed and the options: keep, move (classIds), studio credit, refund amount. |
| `answer_rebooking` | `link`, `option` (`keep`, `move` + `classId`, `credit`, `refund`). Anything that sends money out returns `needs_person` with `reviewUrl` instead of being applied. |

## Protocol

Streamable HTTP, stateless: each POST carries one JSON-RPC 2.0 message and gets a JSON response (`initialize`, `ping`, `tools/list`, `tools/call`; notifications get 202). Protocol versions 2025-06-18 and 2025-03-26. GET and DELETE return 405 (no server stream). Browser requests from other sites are refused; agents call from servers. 60 requests a minute per studio and client, 64 KB bodies.

```bash
curl -s https://rebook-by9u.onrender.com/api/mcp/<bookingId> -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_classes","arguments":{"classType":"yoga"}}}'
```

Add it to Claude Code with `claude mcp add --transport http rebook-studio https://rebook-by9u.onrender.com/api/mcp/<bookingId>`, or open it in the MCP Inspector (`npx @modelcontextprotocol/inspector`, transport "Streamable HTTP").

Code: [lib/agents/mcp.ts](../lib/agents/mcp.ts), [route](../app/api/mcp/%5BbookingId%5D/route.ts), [PayPal return page](../components/booking/paypal-return.tsx). Tests: [test/agents-mcp.test.tsx](../test/agents-mcp.test.tsx).
