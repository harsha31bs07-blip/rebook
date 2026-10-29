import { api, jsonBody } from "../../../lib/api/http";
import { clientIp } from "../../../lib/api/client-ip";
import { limits } from "../../../lib/api/limits";
import { isSameOrigin } from "../../../lib/api/same-origin";
import { createImportedWorkspace, ImportBodySchema } from "../../../lib/import/service";
import { StoreError } from "../../../lib/store";

export const runtime = "nodejs";
/** Creates a private studio from the mapping and class types the owner confirmed on the preview. */
export async function POST(request: Request): Promise<Response> {
  return api(async () => {
    if (!isSameOrigin(request)) throw new StoreError(403, "Please use the import page.");
    limits.take([{ key: `import-create:${clientIp(request)}`, max: 6, ms: 10 * 60_000 }]);
    const { csv, timezone, studioName, dateOrder, mapping = {}, classTypes = {} } = await jsonBody(request, ImportBodySchema, 700_000);
    return createImportedWorkspace(csv, { mapping, classTypes, timezone, studioName, dateOrder });
  });
}
