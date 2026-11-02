import { packBalanceCsv } from "../domain/pack-balance-export";
import { getRepository } from "../store";
import { packChangeId } from "../domain/pack-balances";

export function exportPackBalances(workspaceId: string, repository = getRepository(), pending = false): string {
  const { state } = repository.requireReadyWorkspace(workspaceId);
  // Cancelled classes leave the live schedule; their durable plan snapshots retain the class details.
  const sessions = new Map(repository.listPlans(workspaceId).flatMap((plan) => plan.basis?.sessions ?? []).map((session) => [session.id, session]));
  for (const session of state.sessions) sessions.set(session.id, session);
  const acks = repository.syncAcks(workspaceId);
  return packBalanceCsv({ ...state, sessions: [...sessions.values()] }, repository.listLedger(workspaceId), (event) => !pending || !acks.has(packChangeId(event)));
}
