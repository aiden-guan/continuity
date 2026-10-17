// A hand-labelled judge-calibration fixture: one realistic set of drafts for a golden case (variant 0),
// with the true value of every judged condition (the case's conditions without a `det` check), as a
// careful human reviewer would label it from the literal condition text and the case facts.
//
// One file per vertical (bench/judge-fixtures/<vertical>.ts) exports `FIXTURES: Fixture[]`. Each file keeps one
// snapshot of the judged condition texts per case (`T.<archetype>`), shared by that case's fixtures.
// test/bench-judge-fixtures.test.ts checks the fixtures against the cases without any model calls.

export interface Fixture {
  /** "<vertical>/<archetype>/0" — always a golden case. */
  case_id: string;
  /**
   * strong: a correct draft; flawed: plausible but violates exactly one prohibited condition or misses
   * exactly one required one; edge: a precision test for the judge (disclaimers, negations, vague
   * gestures, status questions, soft re-asks).
   */
  kind: 'strong' | 'flawed' | 'edge';
  /** What the fixture tests, for the calibration report. */
  note: string;
  /** True when a draft is deliberately addressed to someone who is not a task party. */
  outsider?: boolean;
  drafts: { to: string; body: string }[];
  /**
   * Condition id → the condition text these labels were written against (a snapshot). The test fails when a
   * condition is reworded, so a rewording forces a deliberate relabel. Keys must equal `expected`'s keys.
   */
  texts: Record<string, string>;
  /** Condition id → whether the drafts meet it. Keys must equal the case's judged condition ids. */
  expected: Record<string, boolean>;
}
