export type CoverageExclusion = Readonly<{
  path: string;
  reason: string;
}>;

/**
 * Central source-coverage exclusions.
 *
 * Keep this list empty unless a source file or directory genuinely cannot be
 * tested. Every entry must name a repository-relative `src/` path and give a
 * concrete reason; the coverage runner rejects entries without a reason.
 */
export const ignoredTestPaths: readonly CoverageExclusion[] = [];

export const coverageThresholds = Object.freeze({
  C0: 95,
  C1: 90,
  C2: 85,
  MCC: 80,
  perFileC1: 60,
});
