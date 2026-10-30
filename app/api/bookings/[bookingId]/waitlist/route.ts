import { z } from "zod";
import { api, jsonBody } from "../../../../../lib/api/http";
import { publicCheckoutWorkspace } from "../../../../../lib/checkout/http";
import { joinWaitlist } from "../../../../../lib/waitlist/service";

export const runtime = "nodejs";
const JoinSchema = z.strictObject({ sessionId: z.string().min(1).max(100), name: z.string().trim().min(1).max(100), email: z.string().trim().pipe(z.email().max(254)) });

/** A full class on the public booking page: join its waitlist; a freed seat is offered in order by private link. */
export async function POST(request: Request, context: { params: Promise<{ bookingId: string }> }): Promise<Response> {
  return api(async () => {
    const id = publicCheckoutWorkspace(request, (await context.params).bookingId);
    const input = await jsonBody(request, JoinSchema, 4096);
    return joinWaitlist(id, input.sessionId, { name: input.name, email: input.email });
  });
}
