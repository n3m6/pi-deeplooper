// ---------------------------------------------------------------------------
// Generic enum guards
// ---------------------------------------------------------------------------

/**
 * Returns `value` cast to `T` if it is present in `allowed`, otherwise `fallback`.
 *
 * Replaces long chains of `value === "A" || value === "B" || ...` patterns used
 * throughout the pi adapter.
 */
export function coerceEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/**
 * Returns `value` cast to `T` if it is present in `allowed`, otherwise `undefined`.
 *
 * Use when `undefined` is a valid "not matched" result (e.g. optional frontmatter
 * fields where the absence is meaningful).
 */
export function matchEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : undefined;
}

// ---------------------------------------------------------------------------
// Literal sets — single source of truth for enum values used by the adapter
// ---------------------------------------------------------------------------

export const STAGE_STATUSES = ["PASS", "FAIL", "PARTIAL", "SKIP"] as const;
export const BACKWARD_LOOP_CLASSIFICATIONS = ["LOCAL_SLICE", "LOOP_DESIGN", "LOOP_GOALS", "NO_LOOP"] as const;
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export const INTERACTION_MODES = ["interactive", "automated"] as const;
export const FAILURE_POLICIES = ["fail-closed", "best-effort"] as const;
export const REVIEW_DEPTHS = ["thorough", "fast"] as const;
export const INTERVIEW_SOURCES = [
  "user-answer",
  "repo-finding",
  "user-confirmed-finding",
  "automation-default",
  "automation-fallback",
] as const;
