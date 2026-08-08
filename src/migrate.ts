import { CURRENT_SDK_MAJOR } from "./types.js";

/** The `ai` majors whose stored parts this version knows how to read. */
export const MIGRATABLE_SDK_MAJORS = [5, 6, 7] as const;

/**
 * Brings a stored `parts` array from the `ai` major that wrote it up to the current one.
 *
 * For 5 and 6 this is a pass-through, and that is a measured result rather than an assumption:
 * real payloads captured from ai@5.0.228 and ai@6.0.246 (see `test/fixtures/parts-v*`) are
 * byte-identical to ai@7's and are accepted unchanged by its own validator. The dispatch exists so
 * that code migrating lazily on read today keeps working unchanged when a future major does
 * diverge - at which point the transform lands here and `test/compat.test.ts` is what catches it.
 *
 * Rows written by a major older than 5 are refused rather than guessed at.
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
