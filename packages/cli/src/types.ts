// Shared types for the Fuzzloom CLI.

export type Backend = "sonatina" | "native";

/** Fe integer and bool types a property argument may have. */
export type FeType =
  | "u8" | "u16" | "u32" | "u64" | "u128" | "u256"
  | "i8" | "i16" | "i32" | "i64" | "i128" | "i256"
  | "bool";

export const FE_TYPES: readonly FeType[] = [
  "u8", "u16", "u32", "u64", "u128", "u256",
  "i8", "i16", "i32", "i64", "i128", "i256",
  "bool",
];

/**
 * An effect a target declares (`uses (name: mut T)`), provided per
 * evaluation by a fixture function from the user's ingot.
 */
export type Effect = { type: string; mut: boolean; fixture: string };

/** A `prop_*` or `diff_*` function found in a user ingot. */
export type Target = {
  kind: "property" | "differential" | "sequence";
  name: string;
  /**
   * `label` is how the argument is passed when Fuzzloom calls the function
   * directly (effectful targets): null for positional (`_ x`), else the
   * label (the parameter name unless one is given).
   */
  args: { name: string; type: FeType; label?: string | null }[];
  /** Fe paths the harness imports for this target (the function, effect types, fixtures). Defaults to `<ingot>::<name>`. */
  imports?: string[];
  /** Effects, each with the fixture that builds a fresh value per evaluation. */
  effects?: Effect[];
  /** Word ranges from `fuzzloom: <arg> in <lo>..=<hi>` annotations, sorted by argument. */
  bounds?: { arg: number; lo: bigint; hi: bigint }[];
  /** Return type for differential targets. */
  returns?: FeType;
  file: string;
  line: number;
};

/** Three input words, as Fuzzloom payloads carry them. */
export type Words = [bigint, bigint, bigint];
export const MAX_SEQUENCE_STEPS = 8;

/** What one `fe test` run of a harness produced. */
export type Outcome =
  | { kind: "counterexample"; seed: bigint; iteration: bigint; arity: number; original: Words; shrunk: Words; shrinkAttempts: bigint; shrinkComplete: boolean }
  | { kind: "passed"; seed: bigint; runs: bigint; arity: number; edgeArgs: bigint; correlated: bigint; extremes: bigint }
  | { kind: "replayed"; arity: number; input: Words; failed: boolean }
  | { kind: "generated"; seed: bigint; iteration: bigint; arity: number; input: Words }
  | { kind: "digest"; seed: bigint; runs: bigint; arity: number; acc: bigint }
  /** accs[j] is the digest after first + j * step runs. */
  | { kind: "checkpoints"; seed: bigint; first: bigint; step: bigint; arity: number; accs: bigint[] }
  | { kind: "evaluated"; arity: number; input: Words; output: bigint }
  | { kind: "sequence-passed"; runs: bigint }
  | { kind: "sequence-failed"; arity: number; iteration: bigint; originalSteps: number; shrinkAttempts: bigint; shrinkComplete: boolean; steps: Words[] }
  | { kind: "sequence-replayed"; failedStep: bigint }
  | { kind: "panic"; code: bigint; reason: string }
  | { kind: "revert"; message: string }
  | { kind: "infra"; reason: InfraReason; detail: string };

export type InfraReason =
  | "compile"            // the harness or user ingot failed to compile
  | "out-of-gas"         // fe test's per-test gas cap on the EVM backend
  | "timeout"            // native wall-clock limit or our own process timeout
  | "backend-unavailable"
  | "unparsed";          // fe test output we could not interpret
