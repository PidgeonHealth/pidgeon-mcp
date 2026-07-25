// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { errorResult, withSuccessEnvelope } from "./format.js";

const inputSchema = z.object({
  jobId: z
    .string()
    .describe("The population job id returned by generate_population."),
});

export function createPopulationStatusTool(): ToolDefinition {
  return {
    name: "population_status",
    requiredTier: "pro",
    annotations: { readOnlyHint: true, openWorldHint: false },
    // Poll half of the Flock async pair (H-5/H-26). Idempotent: while status is not
    // completed, the jobId envelope feeds the next poll; when ready, it carries the
    // download ref — the terminal artifact of the seed step.
    outputEnvelope: {
      keys: [
        { key: "jobId", description: "The job id polled, echoed back — feed it into the next population_status poll while status is not completed." },
        { key: "status", description: "Job status (running | completed | failed)." },
        { key: "progressPercent", description: "Whole-percent progress (0-100)." },
        { key: "generatedCount", description: "Patients generated so far." },
        { key: "totalCount", description: "Patients requested for the job." },
        { key: "ready", description: "True once the population is complete and downloadable." },
        { key: "downloadRef", description: "Bridge path to export the finished population (present when ready): GET /api/flock/generate/{id}/download." },
        { key: "error", description: "Failure reason when status is failed (absent otherwise)." },
      ],
      feeds: ["population_status"],
    },
    description:
      "Check the progress of a Flock population job started by generate_population. " +
      "Returns job status, generated count, and percent complete. Safe to poll: " +
      "reading status never changes the job. Bridge mode only (the CLI generates " +
      "populations synchronously, so there is no job to poll).",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      let job;
      try {
        job = await transport.getPopulationJob(parsed.jobId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Error reading population job '${parsed.jobId}': ${message}`);
      }

      const lines: string[] = [];
      lines.push(`Population job ${job.id}`);
      lines.push("─".repeat(45));
      lines.push(`Status: ${job.status}`);
      lines.push(`Progress: ${job.generatedCount}/${job.totalCount} (${Math.round(job.progressPercent)}%)`);
      if (job.startedAt) lines.push(`Started: ${job.startedAt}`);
      if (job.completedAt) lines.push(`Completed: ${job.completedAt}`);
      if (job.validationErrorCount !== undefined && job.validationErrorCount > 0) {
        lines.push(`Validation errors during generation: ${job.validationErrorCount}`);
      }
      if (job.error) {
        lines.push("");
        lines.push(`Job error: ${job.error}`);
      }

      lines.push("");
      const status = job.status.toLowerCase();
      const ready = status === "completed";
      if (ready) {
        lines.push(
          "The population is ready. Export it from the Flock app, or via " +
            "GET /api/flock/generate/{id}/download on the Bridge."
        );
      } else if (status === "failed") {
        lines.push("The job failed — start a new one with generate_population (safe to retry).");
      } else {
        lines.push("Still running — poll population_status again to track progress.");
      }

      // Machine envelope (H-16/H-26): the agent branches on `ready`/`status` rather
      // than the prose. `downloadRef` is the terminal artifact of the seed step;
      // while not ready, `jobId` feeds the next idempotent poll.
      const payload: Record<string, unknown> = {
        jobId: job.id,
        status: job.status,
        progressPercent: Math.round(job.progressPercent),
        generatedCount: job.generatedCount,
        totalCount: job.totalCount,
        ready,
      };
      if (ready) payload["downloadRef"] = `/api/flock/generate/${job.id}/download`;
      if (job.error) payload["error"] = job.error;

      return withSuccessEnvelope(lines.join("\n").trimEnd(), payload);
    },
  };
}
