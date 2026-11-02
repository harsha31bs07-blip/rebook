import { api, readBody } from "../../../../lib/api/http";
import { clientIp } from "../../../../lib/api/client-ip";
import { limits } from "../../../../lib/api/limits";
import { isSameOrigin, publicOrigin } from "../../../../lib/api/same-origin";
import { BookingIdSchema } from "../../../../lib/checkout/http";
import { handleMcp } from "../../../../lib/agents/mcp";
import { getRepository, StoreError } from "../../../../lib/store";

export const runtime = "nodejs";
/** Streamable HTTP MCP, stateless: one JSON-RPC message per POST, JSON responses, no server-sent stream. */
export async function POST(request: Request, context: { params: Promise<{ bookingId: string }> }): Promise<Response> {
  return api(async () => {
    const bookingId = BookingIdSchema.parse((await context.params).bookingId);
    // Agents call from servers (no Origin); a browser page on another site must not drive a customer's booking.
    if (!isSameOrigin(request)) throw new StoreError(403, "Cross-origin browser requests are not allowed.");
    limits.take([{ key: `mcp:${bookingId}:${clientIp(request)}`, max: 60, ms: 60_000 }]);
    const workspace = getRepository().requireBookingWorkspace(bookingId);
    let message: unknown;
    try { message = JSON.parse(await readBody(request, 65_536)); }
    catch (error) {
      if (error instanceof StoreError) throw error;
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }, { status: 400 });
    }
    const response = await handleMcp(message, { workspaceId: workspace.id, bookingId, origin: publicOrigin(request), ip: clientIp(request) });
    return response ? Response.json(response, { headers: { "Cache-Control": "no-store" } }) : new Response(null, { status: 202 });
  });
}
const notAllowed = () => new Response(null, { status: 405, headers: { Allow: "POST" } });
export { notAllowed as GET, notAllowed as DELETE };
