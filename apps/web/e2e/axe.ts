import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

type AxeViolation = {
  id: string;
  impact?: string | null;
  help: string;
  nodes: { target: unknown[] }[];
};

/**
 * Serious and critical axe findings fail the spec. Moderate and minor
 * stay visible in the trace but do not fail CI (G.3.3 / #480).
 */
export async function expectNoBlockingAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(
    (violation) =>
      violation.impact === "serious" || violation.impact === "critical",
  );
  const summary = blocking.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.slice(0, 5).map((node) => node.target),
  }));
  expect(summary, formatViolations(blocking)).toEqual([]);
}

function formatViolations(violations: AxeViolation[]): string {
  if (violations.length === 0) {
    return "";
  }
  return violations
    .map((violation) => {
      const targets = violation.nodes
        .slice(0, 5)
        .map((node) => JSON.stringify(node.target))
        .join(", ");
      return `${violation.impact} ${violation.id}: ${violation.help} [${targets}]`;
    })
    .join("\n");
}
