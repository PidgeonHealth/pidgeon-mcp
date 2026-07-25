// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { TierError, ThrottleError, SemanticFinding } from "../transport/index.js";
import { ToolDefinition } from "./types.js";

const inputSchema = z.object({
  message: z
    .string()
    .describe(
      "The raw HL7 v2 message to run the deterministic clinical checks over. Paste the pipe-delimited message."
    ),
});

function formatFindings(findings: SemanticFinding[]): string {
  const lines: string[] = [
    "Clinical checks (advisory, deterministic — never changes whether the message is valid):",
  ];

  if (findings.length === 0) {
    lines.push("No clinical-sense concerns flagged.");
  } else {
    lines.push(`${findings.length} advisory finding${findings.length === 1 ? "" : "s"}:`);
    for (const f of findings) {
      const evidence = f.evidenceFields.length > 0 ? ` @ ${f.evidenceFields.join(", ")}` : "";
      lines.push(`  [${f.faultClass}] ${f.title} — ${f.finding} (source: ${f.source})${evidence}`);
    }
  }

  return lines.join("\n");
}

export function createClinicalCheckTool(): ToolDefinition {
  return {
    name: "clinical_check",
    requiredTier: "free",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Deterministic clinical-sense checks on an HL7 v2 message — free, offline, dataset-fed rules that flag " +
      "clinically implausible content in a structurally-valid message (a 10x dose, a sex-conflicting procedure, " +
      "a specimen/test mismatch) that spec validation cannot see. Advisory only: findings never change whether a " +
      "message is valid. The middle rung of the triage ladder — deterministic clinical rules, above explain_error " +
      "(spec/structure findings) and below semantic_review (the on-device LLM judge); use those for spec errors and " +
      "LLM-judged plausibility respectively, not clinical_check.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);
      try {
        const findings = await transport.clinicalCheck(parsed.message);
        return { content: [{ type: "text", text: formatFindings(findings) }] };
      } catch (err) {
        // Tier/throttle envelopes are owned by server.ts — let them propagate.
        if (err instanceof TierError || err instanceof ThrottleError) throw err;
        // CLI mode or a transport failure → advisory degrade, never a crash.
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text:
                `Clinical checks unavailable: ${message}\n\n` +
                "This is advisory only — your message is unchanged.",
            },
          ],
        };
      }
    },
  };
}
