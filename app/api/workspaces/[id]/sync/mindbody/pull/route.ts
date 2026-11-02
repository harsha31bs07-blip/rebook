import { mindbodySyncRequest } from "../../../../../../../lib/connectors/mindbody/http";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return mindbodySyncRequest(request, context, "pull");
}
