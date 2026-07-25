// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { withSuccessEnvelope } from "./format.js";

const inputSchema = z.object({
  leftMessage: z
    .string()
    .describe(
      "The baseline message (left side). Paste the full HL7 or FHIR message."
    ),
  rightMessage: z
    .string()
    .describe(
      "The candidate message (right side). Paste the full HL7 or FHIR message."
    ),
  standard: z
    .enum(["hl7", "fhir"])
    .optional()
    .describe("Message standard. Auto-detected if not specified."),
  ignoredFields: z
    .string()
    .optional()
    .describe(
      "Comma-separated field paths to ignore (e.g., 'MSH.7,PID.3'). " +
      "Use to suppress expected differences like timestamps or control IDs."
    ),
});

const SEVERITY_ICONS: Record<string, string> = {
  critical: "!!",
  major: "! ",
  minor: "~ ",
  cosmetic: "  ",
};

export function createDiffTool(): ToolDefinition {
  return {
    name: "diff_messages",
    requiredTier: "pro",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputEnvelope: {
      keys: [
        { key: "identical", description: "true when the two messages have no differences." },
        { key: "differenceCount", description: "Number of field-level differences found." },
        { key: "differences", description: "Each difference { path, leftValue, rightValue, severity, description } — the fields that changed, classified critical/major/minor/cosmetic." },
      ],
      feeds: ["explain_error"],
    },
    description:
      "Compare two HL7 or FHIR messages field by field. " +
      "Shows which fields changed, classifies changes by severity (critical/major/minor/cosmetic), " +
      "and identifies expected vs unexpected differences. " +
      "Use for comparing DEV vs UAT, pre-upgrade vs post-upgrade, or validating message transformation correctness.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      const ignoredFields = parsed.ignoredFields
        ? parsed.ignoredFields.split(",").map((f) => f.trim())
        : undefined;

      let result;
      try {
        result = await transport.diff(parsed.leftMessage, parsed.rightMessage, {
          standard: parsed.standard,
          ignoredFields,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error comparing messages: ${message}`,
            },
          ],
        };
      }

      const lines: string[] = [];

      lines.push("Message Diff Results");
      lines.push("─".repeat(60));

      if (result.leftSegmentCount !== undefined || result.rightSegmentCount !== undefined) {
        lines.push(
          `Left segments: ${result.leftSegmentCount ?? "?"} | Right segments: ${result.rightSegmentCount ?? "?"}`
        );
      }

      lines.push(`Differences found: ${result.differences.length}`);
      lines.push("");

      if (result.differences.length > 0) {
        // Summary counts by severity
        const counts: Record<string, number> = { critical: 0, major: 0, minor: 0, cosmetic: 0 };
        for (const diff of result.differences) {
          counts[diff.severity] = (counts[diff.severity] ?? 0) + 1;
        }
        const countParts = Object.entries(counts)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${v} ${k}`);
        lines.push(`Severity breakdown: ${countParts.join(", ")}`);
        lines.push("");

        // Difference table
        lines.push(
          `${"Sev".padEnd(4)} ${"Field Path".padEnd(20)} ${"Left".padEnd(20)} ${"Right".padEnd(20)}`
        );
        lines.push("─".repeat(68));

        for (const diff of result.differences) {
          const icon = SEVERITY_ICONS[diff.severity] ?? "  ";
          const path = (diff.path ?? "").substring(0, 20).padEnd(20);
          const left = (diff.leftValue ?? "(empty)").substring(0, 20).padEnd(20);
          const right = (diff.rightValue ?? "(empty)").substring(0, 20).padEnd(20);
          lines.push(`${icon}  ${path} ${left} ${right}`);
          if (diff.description) {
            lines.push(`      ${diff.description}`);
          }
        }
      } else {
        lines.push("Messages are identical.");
      }

      lines.push("");
      lines.push(result.summary);

      // Machine envelope: the classified differences, so an agent can branch on
      // the diff (e.g. hand critical/major changes to explain_error) without
      // parsing the aligned table above (H-16). Keys are stable API.
      return withSuccessEnvelope(lines.join("\n").trimEnd(), {
        identical: result.differences.length === 0,
        differenceCount: result.differences.length,
        differences: result.differences,
      });
    },
  };
}
