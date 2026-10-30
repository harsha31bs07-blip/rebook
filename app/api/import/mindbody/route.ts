import { api, jsonBody } from "../../../../lib/api/http";
import { clientIp } from "../../../../lib/api/client-ip";
import { limits } from "../../../../lib/api/limits";
import { createMindbodyWorkspace, MindbodyImportSchema } from "../../../../lib/connectors/mindbody/import";
import { requireMindbodyRequest } from "../../../../lib/connectors/mindbody/http";

export async function POST(request: Request): Promise<Response> {
  return api(async () => {
    requireMindbodyRequest(request);
    limits.take([{ key: `import-create:${clientIp(request)}`, max: 6, ms: 10 * 60_000 }]);
    return createMindbodyWorkspace(await jsonBody(request, MindbodyImportSchema));
  });
}
