import { AppError } from "../errors/AppError.js";

/** `{ from: [allowed next states] }`. A state missing from the table is terminal. */
export type TransitionTable<S extends string> = { [K in S]: readonly S[] };

export interface StateMachine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  canTransition(from: S, to: S): boolean;
  /** Throws 409 naming both states when the move is not allowed. */
  assertTransition(from: S, to: S): void;
  /** Every state that may move to `to`: the `$in` list for a guarded atomic update. */
  allowedFrom(to: S): S[];
  toMermaid(): string;
}

/** One typed table per entity is the single source of truth for what status changes are legal. */
export function defineMachine<S extends string>(name: string, table: TransitionTable<S>): StateMachine<S> {
  const states = Object.keys(table) as S[];
  const canTransition = (from: S, to: S) => table[from]?.includes(to) ?? false;
  return {
    name,
    states,
    canTransition,
    assertTransition(from, to) {
      if (!canTransition(from, to)) throw AppError.conflict(`${name} cannot change from ${from} to ${to}`);
    },
    allowedFrom: (to) => states.filter((from) => canTransition(from, to)),
    toMermaid: () =>
      ["stateDiagram-v2", ...states.flatMap((from) => table[from].map((to) => `  ${from} --> ${to}`))].join("\n"),
  };
}
