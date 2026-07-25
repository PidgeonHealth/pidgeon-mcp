// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { errorResult, withSuccessEnvelope } from "./format.js";

const inputSchema = z.object({
  population: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .describe("Number of patients to generate (1-10,000)."),
  location: z
    .string()
    .optional()
    .describe(
      "Geographic location for epidemiological grounding (e.g., 'MS' for Mississippi, 'IL' for Illinois). " +
      "Affects disease prevalence, demographics, and lab value distributions."
    ),
  format: z
    .enum(["sql", "csv", "hl7", "fhir"])
    .optional()
    .default("csv")
    .describe("Output format: sql (INSERT statements), csv, hl7 (message stream), or fhir (Bundle)."),
  seed: z
    .number()
    .int()
    .optional()
    .describe("Random seed for reproducible population output."),
});

export function createGeneratePopulationTool(): ToolDefinition {
  return {
    name: "generate_population",
    requiredTier: "pro",
    // Async job start — the start is the only mutation; polling is idempotent.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    // Cross-app journey handoff (H-26): the Flock seed step. Its jobId envelope is
    // population_status's argument — step N's envelope is step N+1's input.
    outputEnvelope: {
      keys: [
        { key: "jobId", description: "Async Flock job id (Bridge mode) — feed straight into population_status to poll progress and reach the download ref." },
        { key: "population", description: "Patients requested, echoed back." },
        { key: "format", description: "Output format requested (sql | csv | hl7 | fhir)." },
        { key: "patientCount", description: "Patients generated inline (CLI/synchronous mode, where there is no job to poll)." },
        { key: "output", description: "Where the completed population was written (synchronous mode)." },
      ],
      feeds: ["population_status"],
    },
    description:
      "Start generating a synthetic patient population with Pidgeon Flock. " +
      "Produces epidemiologically grounded patient records with realistic demographics, " +
      "diagnoses, medications, and lab values for a given geography. " +
      "In Bridge mode this starts an async job and returns a job id — starting is the only mutation, so a lost " +
      "start is safe to re-issue; poll it with population_status (polling is idempotent) until it completes. " +
      "Schema-aware (FK-safe DDL) generation runs via the CLI: pidgeon flock generate --schema <ddl-file>.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      let result;
      try {
        result = await transport.generatePopulation({
          population: parsed.population,
          location: parsed.location,
          format: parsed.format,
          seed: parsed.seed,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Error starting population generation: ${message}`);
      }

      const lines: string[] = [];

      if (result.jobId) {
        lines.push("Flock population job started");
        lines.push("─".repeat(45));
        lines.push(`Job ID: ${result.jobId}`);
        lines.push(`Patients requested: ${parsed.population}`);
        lines.push(`Output format: ${parsed.format}`);
        if (parsed.location) lines.push(`Location: ${parsed.location}`);
        if (parsed.seed !== undefined) lines.push(`Seed: ${parsed.seed}`);
        lines.push("");
        lines.push(
          `Next: poll progress with population_status {"jobId": "${result.jobId}"} — ` +
            "it reports generated count, percent complete, and when the output is ready."
        );

        // Machine envelope (H-16/H-26): the jobId is the cross-app handoff — an
        // agent reads it here and feeds it straight into population_status without
        // parsing the prose above.
        return withSuccessEnvelope(lines.join("\n").trimEnd(), {
          jobId: result.jobId,
          population: parsed.population,
          format: parsed.format,
        });
      }

      if (result.completed) {
        const done = result.completed;
        lines.push("Flock population generation complete");
        lines.push("─".repeat(45));
        lines.push(`Patients generated: ${done.patientCount}`);
        lines.push(`Output format: ${done.format}`);
        if (done.output) lines.push(`Output: ${done.output}`);
        lines.push("");
        lines.push(done.summary);

        // Synchronous (CLI) completion: no job to poll, so the envelope carries
        // the finished artifact directly instead of a jobId.
        const payload: Record<string, unknown> = {
          patientCount: done.patientCount,
          format: done.format,
        };
        if (done.output) payload["output"] = done.output;
        return withSuccessEnvelope(lines.join("\n").trimEnd(), payload);
      }

      return errorResult("Population generation returned neither a job id nor a completed result.");
    },
  };
}
