import { api, WorkspaceIdSchema } from "../../../../../lib/api/http";
import { limits } from "../../../../../lib/api/limits";
import { exportPackBalances } from "../../../../../lib/export/pack-balances";
import { localParts } from "../../../../../lib/domain/time";
import { getRepository } from "../../../../../lib/store";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return api(async () => {
    const id = WorkspaceIdSchema.parse((await context.params).id);
    limits.take([{ key: `pack-balances:${id}`, max: 10, ms: 60_000 }]);
    const repository = getRepository(), { state } = repository.requireReadyWorkspace(id);
    const date = localParts(new Date().toISOString(), state.studio.timezone).dateKey;
    return new Response(exportPackBalances(id, repository), { headers: {
      "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="pack-balances-${date}.csv"`, "Cache-Control": "no-store",
    } });
  });
}
