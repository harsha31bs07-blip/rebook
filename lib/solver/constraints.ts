import type { Disruption, State } from "../domain/types";
import { DisruptionSchema } from "../domain/schemas";

// Kept with the persisted scheduling state so every solver entry point sees them.
export type ConstrainedState = State & { activeConstraints?: Disruption[] };
export function activeConstraints(state: State): Disruption[] {
  return (state as ConstrainedState).activeConstraints ?? [];
}
export function preserveConstraints(state: State, parsed: State): ConstrainedState {
  const constraints = activeConstraints(state);
  return (state as ConstrainedState).activeConstraints !== undefined
    ? { ...parsed, activeConstraints: constraints.map((item) => DisruptionSchema.parse(item)) } : parsed;
}
export function deactivateConstraint(state: State, disruption: Disruption): ConstrainedState {
  return { ...state, activeConstraints: activeConstraints(state).filter((item) => JSON.stringify(item) !== JSON.stringify(disruption)) };
}
export function activateConstraint(state: State, disruption: Disruption): ConstrainedState {
  const constraints = activeConstraints(state);
  return { ...state, activeConstraints: constraints.some((item) => JSON.stringify(item) === JSON.stringify(disruption))
    ? constraints : [...constraints, structuredClone(disruption)] };
}
