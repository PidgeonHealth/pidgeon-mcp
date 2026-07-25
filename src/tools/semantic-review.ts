// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { TierError, ThrottleError, SemanticReviewResult } from "../transport/index.js";
import { ToolDefinition } from "./types.js";

const inputSchema = z.object({
  message: z
    .string()
    .describe(
      "The raw HL7 v2 message to review for clinical-sense problems. Paste the pipe-delimited message."
    ),
  contentIsSynthetic: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Attest the message carries no PHI. Only this lets a non-local (cloud) model see the content; " +
        "false (the default) keeps real content on-device."
    ),
  families: z
    .array(z.string())
    .optional()
    .describe(
      "Optional subset of check families to run (e.g. 'DosePlausibility', 'MedDxPlausibility', " +
        "'NarrativeConsistency'). Omit to run them all."
    ),
  maxLatencyMs: z
    .number()
    .optional()
    .describe(
      "Optional wall-clock budget in milliseconds; families not reached within the budget are reported as skipped."
    ),
});

function formatFindings(result: SemanticReviewResult): string {
  const lines: string[] = [
    "Semantic review (advisory — never changes whether the message is valid):",
  ];

  if (result.findings.length === 0) {
    lines.push("No clinical-sense concerns flagged.");
  } else {
    lines.push(`${result.findings.length} advisory finding${result.findings.length === 1 ? "" : "s"}:`);
    for (const f of result.findings) {
      const evidence = f.evidenceFields.length > 0 ? ` @ ${f.evidenceFields.join(", ")}` : "";
      const pct = Math.round(f.confidence * 100);
      lines.push(`  [${f.faultClass}] ${f.title} — ${f.finding} (source: ${f.source}, ${pct}% confidence)${evidence}`);
    }
  }

  if (result.skippedFamilies.length > 0) {
    lines.push("");
    lines.push(`Skipped under the latency budget: ${result.skippedFamilies.join(", ")}.`);
  }

  return lines.join("\n");
}

export function createSemanticReviewTool(): ToolDefinition {
  return {
    name: "semantic_review",
    requiredTier: "free",
    // Read-only advisory judge. openWorldHint:false reflects the default
    // on-device posture (no PHI leaves the machine); off-device inference is
    // gated separately by the contentIsSynthetic attestation + egress policy.
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Advisory clinical-sense review of an HL7 v2 message by the on-device LLM judge. " +
      "Flags clinically implausible content in a structurally-valid message — a 10x dose, a sex-conflicting " +
      "procedure, a note that contradicts the coded result — that spec validation cannot see. " +
      "Advisory only: findings never change whether a message is valid and never block a pipeline. " +
      "Runs on-device by default; an unconfigured judge degrades to a note rather than an error. " +
      "Last rung of the triage ladder: run clinical_check first for the free deterministic rules, and use " +
      "explain_error for spec/structure findings — reach for this LLM judge only for plausibility the rules miss.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);
      try {
        const result = await transport.semanticReview(parsed.message, {
          contentIsSynthetic: parsed.contentIsSynthetic,
          families: parsed.families,
          maxLatencyMs: parsed.maxLatencyMs,
        });
        return { content: [{ type: "text", text: formatFindings(result) }] };
      } catch (err) {
        // Tier/throttle envelopes are owned by server.ts — let them propagate so
        // an agent reads the typed code and degrades, never crashes its loop.
        if (err instanceof TierError || err instanceof ThrottleError) throw err;
        // Judge unavailable (no on-device model, PHI-guard refusal, or CLI mode) →
        // advisory degrade, never a crash. The agent keeps its message unchanged.
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text:
                `Semantic review unavailable: ${message}\n\n` +
                "This is advisory only — your message is unchanged. Configure an on-device model " +
                "(pidgeon ai setup) or run in Bridge mode to enable clinical-sense review.",
            },
          ],
        };
      }
    },
  };
}
