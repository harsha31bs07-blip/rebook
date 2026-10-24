import { api } from "../../../lib/api/http";
import { getRepository } from "../../../lib/store";

export const runtime = "nodejs";
export async function GET(): Promise<Response> {
  return api(() => ({ ok: true, uptimeSeconds: Math.floor(process.uptime()), pool: getRepository().poolStatus() }));
}
