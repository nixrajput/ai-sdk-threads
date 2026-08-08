import { CURRENT_SDK_MAJOR } from "./types.js";

/** The `ai` majors whose stored parts this version knows how to read. */
export const MIGRATABLE_SDK_MAJORS = [5, 6, 7] as const;

/**
 * Brings stored `parts` up to the current `ai` major. A pass-through for 5 and 6 because their
 * payloads are byte-identical to 7's - measured, see `test/fixtures/parts-v*`. Older majors throw.
 */
export function migrateParts(parts: unknown[], fromVersion: number): unknown[] {
  if (fromVersion >= CURRENT_SDK_MAJOR) return parts;
  if (!MIGRATABLE_SDK_MAJORS.includes(fromVersion as (typeof MIGRATABLE_SDK_MAJORS)[number])) {
    throw new Error(
      `ai-sdk-threads: cannot migrate parts written by ai major ${fromVersion}; ` +
        `supported majors are ${MIGRATABLE_SDK_MAJORS.join(", ")}`,
    );
  }
  return parts;
}
