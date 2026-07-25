// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { PromptDefinition } from "./debug.js";
import { TOOL_CATALOG } from "../catalog.js";

import { createDebugPrompt } from "./debug.js";
import { createGoLivePrompt } from "./go-live.js";
import { createOnboardPrompt } from "./onboard.js";
import { createStandUpInterfacePrompt } from "./stand-up-interface.js";
import { createReproduceAndFixPrompt } from "./reproduce-and-fix.js";
import { createSeedValidateMonitorPrompt } from "./seed-validate-monitor.js";

/**
 * The single source of truth for the Pidgeon MCP prompt (guided-workflow) roster.
 * Prompt registration (server.ts), the self-description resource
 * (resources/system.ts), and the generated manifest (scripts/manifest.ts) all
 * read this one list instead of re-declaring the prompt set in three places.
 *
 * Each entry also records the tools the workflow chains. The free/Pro split is
 * NOT hand-maintained here — `promptTierBreakdown` derives it from TOOL_CATALOG,
 * so a prompt's advertised entitlement can never drift from the tools that gate
 * it. `freePaidNote` is the human-readable "how far does free carry this" line.
 */
export interface PromptCatalogEntry {
  name: string;
  factory: () => PromptDefinition;
  /** Tools this workflow chains, in rough execution order (verified against the prompt body). */
  tools: string[];
  /** One-line entitlement summary an agent reads to know where the Pro line falls in this workflow. */
  freePaidNote: string;
}

export const PROMPT_CATALOG: PromptCatalogEntry[] = [
  {
    name: "debug_hl7_error",
    factory: createDebugPrompt,
    tools: ["validate_message", "explain_error", "generate_message"],
    freePaidNote: "Fully free — validate, explain each error, and generate a corrected example need no subscription.",
  },
  {
    name: "go_live_prep",
    factory: createGoLivePrompt,
    tools: ["generate_message", "validate_message"],
    freePaidNote:
      "Generate + validate are free; production-volume go-live suites are bounded by the free-tier volume cap, " +
      "and vendor-profile persistence (analyze_vendor_pattern) is Pro.",
  },
  {
    name: "onboard_vendor_interface",
    factory: createOnboardPrompt,
    tools: ["generate_message", "validate_message"],
    freePaidNote:
      "Generating and validating sample traffic is free; saving and reusing the inferred vendor profile " +
      "(analyze_vendor_pattern) is Pro.",
  },
  {
    name: "stand_up_interface",
    factory: createStandUpInterfacePrompt,
    tools: ["generate_message", "validate_message", "conform", "refine_hl7_segment", "send_message"],
    freePaidNote:
      "Generate + validate are free; the conform gate (CMS-0057-F), in-place refine, and delivery (send) are Pro.",
  },
  {
    name: "reproduce_and_fix",
    factory: createReproduceAndFixPrompt,
    tools: ["explain_message", "validate_message", "explain_error", "refine_hl7_segment", "diff_messages", "send_message"],
    freePaidNote:
      "The full diagnosis — explain, validate, and triage each finding — is free; the fix-and-deliver steps " +
      "(refine, diff, re-send) are Pro. A free agent loop still gets the complete diagnosis, never a hard stop.",
  },
  {
    name: "seed_validate_monitor",
    factory: createSeedValidateMonitorPrompt,
    tools: ["generate_population", "run_workflow", "validate_message", "loft_status"],
    freePaidNote:
      "Batch validation is free; population seeding (Flock) and live-interface monitoring (Loft) are Pro.",
  },
];

/** Split a prompt's chained tools into free vs Pro by reading TOOL_CATALOG — never hand-maintained. */
export function promptTierBreakdown(entry: PromptCatalogEntry): { free: string[]; pro: string[] } {
  const tierOf = (name: string): string =>
    TOOL_CATALOG.find((t) => t.name === name)?.requiredTier ?? "free";
  return {
    free: entry.tools.filter((t) => tierOf(t) === "free"),
    pro: entry.tools.filter((t) => tierOf(t) !== "free"),
  };
}
