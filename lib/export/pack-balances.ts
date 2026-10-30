import { packBalanceCsv } from "../domain/pack-balance-export";
import { getRepository } from "../store";

export function exportPackBalances(workspaceId: string, repository = getRepository()): string {
  const { state } = repository.requireReadyWorkspace(workspaceId);
  // Cancelled classes leave the live schedule; their durable plan snapshots retain the class details.
  const sessions = new Map(repository.listPlans(workspaceId).flatMap((plan) => plan.basis?.sessions ?? []).map((session) => [session.id, session]));
  for (const session of state.sessions) sessions.set(session.id, session);
  return packBalanceCsv({ ...state, sessions: [...sessions.values()] }, repository.listLedger(workspaceId));
}
