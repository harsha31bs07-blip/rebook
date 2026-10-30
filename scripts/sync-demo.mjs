const [baseUrl, workspaceId, key] = process.argv.slice(2);
if (!baseUrl || !workspaceId || !key) {
  console.error("Usage: node scripts/sync-demo.mjs <baseUrl> <workspaceId> <key>");
  process.exit(1);
}
const base = `${baseUrl.replace(/\/$/, "")}/api/workspaces/${encodeURIComponent(workspaceId)}`;
async function call(path, body) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
  return result;
}
try {
  let feed;
  do {
    feed = await call("/sync/changes");
    console.log("Outbound changes:", JSON.stringify(feed, null, 2));
    if (feed.changes.length) console.log("Acknowledged:", await call("/sync/ack", { ids: feed.changes.map((change) => change.id) }));
  } while (feed.pending > feed.changes.length);
  const { state, plans } = await call("");
  if (plans.some((plan) => plan.status === "proposed")) throw new Error("Approve or discard the recovery preview before running this demo.");
  const booking = state.bookings.find((row) => ["confirmed", "moved"].includes(row.status)
    && state.sessions.some((session) => session.id === row.sessionId && Date.parse(session.start) > Date.now()));
  if (!booking) throw new Error("No upcoming active booking to demonstrate. Start a fresh demo workspace.");
  const person = state.customers.find((row) => row.id === booking.customerId);
  const reference = { session: { id: booking.sessionId }, customer: { name: person.name, email: person.email } };
  const operation = `sync-demo:${crypto.randomUUID()}`;
  const cancellation = { eventId: `${operation}:cancel`, type: "booking.cancelled", ...reference };
  const joined = { eventId: `${operation}:join`, type: "waitlist.joined", ...reference, ...(booking.entitlement ? { entitlement: booking.entitlement } : {}) };
  console.log("Inbound results:", JSON.stringify(await call("/sync/events", { events: [cancellation, joined, cancellation] }), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
