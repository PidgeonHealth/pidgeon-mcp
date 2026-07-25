// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { PromptDefinition } from "./debug.js";

/**
 * W3 — Seed + validate + monitor a cohort.
 * Spans Flock → Post → Loft in one orchestration — the clearest demonstration of
 * the shared-engine story (three products, one agent-driven job) without implying
 * a purchasing motion. Chains generate_population → run_workflow →
 * validate_message (across the batch) → loft_status.
 */
const argsSchema = z.object({
  schema: z
    .string()
    .optional()
    .describe("Path to a DB schema (DDL) to shape the synthetic cohort so it looks like your production database."),
  population: z
    .string()
    .optional()
    .describe("How many patients to generate (e.g. '500')."),
  scenario: z
    .string()
    .optional()
    .describe("Clinical scenario for the per-patient message stream, e.g. 'admission-with-labs'."),
  watchPath: z
    .string()
    .optional()
    .describe("Interface pickup/drop directory to begin monitoring once the cohort flows through it."),
});

export function createSeedValidateMonitorPrompt(): PromptDefinition {
  return {
    name: "seed_validate_monitor",
    description:
      "Seed a UAT environment with a realistic, FK-safe synthetic cohort, prove every generated message " +
      "validates, and start watching the interface they flow through — Flock → Post → Loft in one job.",
    argsSchema,
    handler: (args) => {
      const { schema, population, scenario, watchPath } = args;

      const userContent = [
        "Populate my UAT environment with a realistic patient cohort, prove every message validates, and start monitoring the interface.",
        ...(schema ? [`Schema to match: ${schema}.`] : []),
        ...(population ? [`Population size: ${population}.`] : []),
        ...(scenario ? [`Per-patient scenario: ${scenario}.`] : []),
        ...(watchPath ? [`Interface to monitor: ${watchPath}.`] : []),
      ].join("\n");

      const assistantContent = [
        "I'll seed, validate, and monitor in one orchestration — no PHI ever exists in this data, so there's no BAA or security review.",
        "",
        "**Step 1: Generate the cohort (Flock)**",
        "`generate_population`" +
          (schema ? ` shaped by ${schema}` : "") +
          (population ? ` at ${population} patients` : "") +
          " — FK-safe synthetic records that look like your production database.",
        "",
        "**Step 2: Coherent per-patient message stream**",
        "`run_workflow`" +
          (scenario ? ` for the '${scenario}' scenario` : " for an admission-with-labs scenario") +
          ", sharing identifiers across each patient's messages so the sequence is clinically coherent.",
        "",
        "**Step 3: Prove acceptability**",
        "`validate_message` across the batch. Any failing slice I regenerate — you get a validation summary showing the batch is acceptable to the destination.",
        "",
        "**Step 4: Begin monitoring (Loft)**",
        watchPath
          ? `\`loft_status\` watching ${watchPath} for content-level failures the engine dashboards miss.`
          : "`loft_status` to begin semantic monitoring of the interface the cohort flows through (give me the pickup/drop path).",
        "",
        "The arc here is \"your staging data is a lie\" → \"now it isn't, and it's monitored.\" Generation and scenario streaming at volume are Pro; I'll surface that cleanly if you're on the free tier. Starting with the population...",
      ].join("\n");

      return {
        messages: [
          { role: "user", content: userContent },
          { role: "assistant", content: assistantContent },
        ],
      };
    },
  };
}
