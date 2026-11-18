/**
 * Tests must not reach the network, the real `claude` CLI or the host: every such dependency is
 * injected. Code that would fall back to the real one calls this first; under vitest (which sets
 * VITEST in the environment) it throws instead of silently using it.
 */
export function refuseRealInTests(what: string, env: Record<string, string | undefined> = process.env): void {
  if (env.VITEST) {
    throw new Error(
      `Refusing to use the real ${what} under vitest: inject it (tests must not reach the network or the claude CLI)`,
    );
  }
}
