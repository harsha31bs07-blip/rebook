import { api, jsonBody } from "../../../../lib/api/http";
import { clientIp } from "../../../../lib/api/client-ip";
import { limits } from "../../../../lib/api/limits";
import { isSameOrigin } from "../../../../lib/api/same-origin";
import { ImportBodySchema, previewImport } from "../../../../lib/import/service";
import { StoreError } from "../../../../lib/store";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  return api(async () => {
    if (!isSameOrigin(request)) throw new StoreError(403, "Please use the import page.");
    const client = clientIp(request);
    limits.take([{ key: `import-preview:${client}`, max: 40, ms: 10 * 60_000 }]);
    return previewImport(await jsonBody(request, ImportBodySchema, 700_000), { client, workspace: "import" });
  });
}
