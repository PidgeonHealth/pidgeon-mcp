// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { errorResult, withSuccessEnvelope } from "./format.js";
import { ConformResult } from "../transport/index.js";

/**
 * conform — probe a live FHIR endpoint against its Implementation Guides
 * (US Core, Da Vinci PAS/CRD/DTR) and return a pass/fail scorecard. This is the
 * CMS-0057-F conformance wedge surfaced as an agent tool: an agent orchestrating
 * the "stand up a conformant interface" workflow (PI-B W1) calls this as the
 * gate before delivering. Pro tier — conform-at-volume is paid (NORTH_STAR
 * wedge 1); the free CLI `pidgeon conform` remains for single manual probes.
 *
 * Drives the existing `pidgeon conform` command via the CLI transport today; in
 * Bridge mode it calls the conform endpoint once CONFORM-GUI S0 wires it, and
 * degrades to a clear "use CLI mode" message until then.
 */

const inputSchema = z.object({
  endpoint: z
    .string()
    .describe("FHIR base URL, e.g. https://api.payer.example/fhir."),
  resource: z
    .string()
    .optional()
    .describe("Single-probe target 'ResourceType/id' (e.g. Patient/example). Required unless `walk` is true."),
  profile: z
    .string()
    .optional()
    .describe("IG profile short name (e.g. us-core-patient) or canonical URL. Required unless `walk` is true."),
  walk: z
    .boolean()
    .optional()
    .describe("Walk every resource×profile in the endpoint's CapabilityStatement instead of one probe."),
  ig: z
    .string()
    .optional()
    .describe("Walk only: restrict to this IG base URL, e.g. http://hl7.org/fhir/us/core/."),
  onlyResources: z
    .array(z.string())
    .optional()
    .describe("Walk only: limit to these resource types, e.g. ['Patient','Coverage']."),
  auth: z
    .string()
    .optional()
    .describe("Bearer token for an authenticated endpoint. Omit for staging."),
  ci: z
    .boolean()
    .optional()
    .describe("CI mode: must-support gaps count as failures (CMS-0057-F audit policy)."),
});

export function createConformTool(): ToolDefinition {
  return {
    name: "conform",
    requiredTier: "pro",
    annotations: { readOnlyHint: true, openWorldHint: true },
    outputEnvelope: {
      keys: [
        { key: "passed", description: "true when the endpoint passed the profile (CI gate exit 0)." },
        { key: "mode", description: "'single' for one resource×profile probe, 'walk' for a full-endpoint walk." },
        { key: "endpoint", description: "The FHIR base URL that was probed." },
        { key: "findings", description: "Conformance issues, each { ruleId, location, message, severity } — feed verbatim to explain_error.findings." },
      ],
      feeds: ["explain_error"],
    },
    description:
      "Probe a live FHIR endpoint for IG conformance (US Core, Da Vinci PAS/CRD/DTR) and return a " +
      "pass/fail scorecard graded against the published spec — the CMS-0057-F readiness check. " +
      "Probe one resource (`resource` + `profile`) or walk the whole endpoint (`walk: true`). " +
      "Use `ci: true` to treat must-support gaps as hard failures.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      if (!parsed.walk && (!parsed.resource || !parsed.profile)) {
        return errorResult(
          "conform needs either `walk: true`, or both `resource` (ResourceType/id) and `profile`.",
          "TOOL_ERROR"
        );
      }

      let result: ConformResult;
      try {
        result = await transport.conform(parsed.endpoint, {
          resource: parsed.resource,
          profile: parsed.profile,
          walk: parsed.walk,
          ig: parsed.ig,
          onlyResources: parsed.onlyResources,
          auth: parsed.auth,
          ci: parsed.ci,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Conformance probe failed: ${message}`);
      }

      const lines: string[] = [];
      lines.push(result.passed ? "Conformance: PASSED" : "Conformance: FAILED");
      lines.push(`Endpoint: ${result.endpoint}`);

      if (result.mode === "walk") {
        lines.push(
          `Resources passed: ${result.resourcesPassed ?? 0}/${result.resourcesTotal ?? 0}` +
            `  (${result.totalErrors ?? 0} errors, ${result.totalWarnings ?? 0} warnings)`
        );
      } else {
        const target = [result.resourceType, result.resourceId].filter(Boolean).join("/");
        if (target) lines.push(`Resource: ${target}`);
        if (result.profileRequested) lines.push(`Profile: ${result.profileRequested}`);
        if (result.httpStatusCode) lines.push(`HTTP: ${result.httpStatusCode}`);
      }

      if (parsed.ci) {
        lines.push(`CI gate: ${result.passed ? "exit 0" : "exit 1"} (must-support gaps count as failures).`);
      }

      if (result.issues.length > 0) {
        lines.push("");
        lines.push(`Issues (${result.issues.length}):`);
        const ordered = [...result.issues].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
        for (const issue of ordered.slice(0, 50)) {
          const tag = issue.severity === "error" ? "[Error]  " : issue.severity === "warning" ? "[Warning]" : "[Info]   ";
          const where = [issue.ruleId, issue.location].filter(Boolean).join(" ");
          lines.push(`  ${tag} ${where}`.trimEnd());
          lines.push(`           ${issue.message}`);
          if (issue.suggestion) lines.push(`           -> ${issue.suggestion}`);
        }
        if (result.issues.length > 50) lines.push(`  …and ${result.issues.length - 50} more.`);
      } else {
        lines.push("No issues — clean against the profile.");
      }

      // Machine envelope: the findings shaped for a verbatim hand-off to
      // explain_error (which reads ruleId/message/severity; extra keys are
      // ignored), so an agent chains conform -> explain_error (H-16).
      const findings = result.issues.map((issue) => ({
        ruleId: issue.ruleId,
        location: issue.location,
        message: issue.message,
        severity: issue.severity,
      }));
      return withSuccessEnvelope(lines.join("\n").trimEnd(), {
        passed: result.passed,
        mode: result.mode,
        endpoint: result.endpoint,
        findings,
      });
    },
  };
}

function severityRank(s: ConformResult["issues"][number]["severity"]): number {
  return s === "error" ? 2 : s === "warning" ? 1 : 0;
}
