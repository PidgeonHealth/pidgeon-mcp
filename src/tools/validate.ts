// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ValidationError } from "../transport/index.js";
import { ToolDefinition } from "./types.js";
import { withSuccessEnvelope } from "./format.js";

/** A finding shaped for verbatim hand-off to explain_error's `findings` input. */
function toFinding(issue: ValidationError, severity: "error" | "warning"): Record<string, unknown> {
  return {
    segment: issue.segment,
    field: issue.field,
    ruleId: issue.ruleId,
    message: issue.message,
    severity,
  };
}

const inputSchema = z.object({
  message: z
    .string()
    .describe(
      "The raw message text to validate. For HL7, paste the pipe-delimited message. " +
        "For FHIR, paste the JSON. For NCPDP, paste the XML."
    ),
  standard: z
    .enum(["hl7", "fhir", "ncpdp"])
    .optional()
    .describe("Standard to validate against. Auto-detected from message format if not specified."),
  mode: z
    .enum(["strict", "compatibility"])
    .optional()
    .default("compatibility")
    .describe(
      "strict: enforces full spec compliance. compatibility: accepts common real-world deviations."
    ),
  vendorProfile: z
    .string()
    .optional()
    .describe(
      "Named vendor profile to validate against (e.g., 'epic_er', 'cerner_pharmacy')."
    ),
});

function formatIssues(issues: ValidationError[], label: string): string {
  if (issues.length === 0) return "";

  const lines: string[] = [`${label} (${issues.length}):`];
  for (const issue of issues) {
    const location = [issue.segment, issue.field].filter(Boolean).join(".");
    const prefix = location ? `  [${location}] ` : "  ";
    const ruleTag = issue.ruleId ? ` (${issue.ruleId})` : "";
    lines.push(`${prefix}${issue.message}${ruleTag}`);
  }
  return lines.join("\n");
}

export function createValidateTool(): ToolDefinition {
  return {
    name: "validate_message",
    requiredTier: "free",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputEnvelope: {
      keys: [
        { key: "isValid", description: "true when the message passed with no errors." },
        { key: "conformanceScore", description: "0-1 conformance score against the spec (and vendor profile)." },
        { key: "findings", description: "Errors + warnings, each { segment, field, ruleId, message, severity } — feed verbatim to explain_error.findings." },
      ],
      feeds: ["explain_error"],
    },
    description:
      "Validate an HL7 v2, FHIR R4, or NCPDP SCRIPT message against the specification. " +
      "Returns a structured list of errors and warnings with field paths, severity levels, and a conformance score. " +
      "Use 'compatibility' mode for real-world messages that may have minor spec deviations; " +
      "use 'strict' mode for compliance testing.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      let result;
      try {
        result = await transport.validate(parsed.message, {
          standard: parsed.standard,
          mode: parsed.mode,
          vendorProfile: parsed.vendorProfile,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error validating message: ${message}`,
            },
          ],
        };
      }

      const lines: string[] = [];

      // Result header
      lines.push(result.isValid ? "✓ VALID" : "✗ INVALID");

      // Metadata
      if (result.standard) lines.push(`Standard: ${result.standard.toUpperCase()}`);
      if (result.messageType) lines.push(`Message Type: ${result.messageType}`);
      if (result.conformanceScore !== undefined) {
        const pct = Math.round(result.conformanceScore * 100);
        lines.push(`Conformance Score: ${pct}%`);
      }
      if (parsed.mode) lines.push(`Validation Mode: ${parsed.mode}`);

      lines.push("");

      // Errors
      const errorSection = formatIssues(result.errors, "Errors");
      if (errorSection) {
        lines.push(errorSection);
        lines.push("");
      }

      // Warnings
      const warningSection = formatIssues(result.warnings, "Warnings");
      if (warningSection) {
        lines.push(warningSection);
        lines.push("");
      }

      // Summary
      if (result.summary) {
        lines.push(result.summary);
      } else {
        const errorCount = result.errors.length;
        const warnCount = result.warnings.length;
        const parts: string[] = [];
        if (errorCount > 0) parts.push(`${errorCount} error${errorCount !== 1 ? "s" : ""}`);
        if (warnCount > 0) parts.push(`${warnCount} warning${warnCount !== 1 ? "s" : ""}`);
        if (parts.length === 0) {
          lines.push("No issues found.");
        } else {
          lines.push(`Found ${parts.join(", ")}.`);
        }
      }

      // Append a machine-parseable envelope carrying the findings shaped for a
      // verbatim hand-off to explain_error (`findings`), so an agent chains
      // validate -> explain_error without re-parsing this prose. This is the
      // composition linchpin of the reproduce-and-fix journey.
      const findings = [
        ...result.errors.map((e) => toFinding(e, "error")),
        ...result.warnings.map((w) => toFinding(w, "warning")),
      ];
      return withSuccessEnvelope(lines.join("\n").trimEnd(), {
        isValid: result.isValid,
        conformanceScore: result.conformanceScore,
        findings,
      });
    },
  };
}
