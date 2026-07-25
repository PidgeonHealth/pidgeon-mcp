// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Conformance-report normalization — projects the C# ConformanceReport (single
// probe) and EndpointConformanceReport (walk) JSON shapes into the
// transport-neutral ConformResult. Reads both PascalCase and camelCase keys and
// both int and string severities defensively. Consumed by the Bridge and CLI
// transports.

import { ConformResult, ConformIssue } from "./types.js";

/**
 * Normalize the raw JSON of a C# ConformanceReport (single probe) or
 * EndpointConformanceReport (walk) into the transport-neutral ConformResult.
 * The CLI emits PascalCase keys and serializes ValidationSeverity as an integer
 * (Error=0, Warning=1, Info=2); we read both int and string defensively so the
 * shape survives a future enum-string-converter change on the C# side.
 */
export function normalizeConformReport(raw: Record<string, unknown>, endpoint: string): ConformResult {
  const isWalk = Array.isArray((raw as { Reports?: unknown }).Reports ?? (raw as { reports?: unknown }).reports);
  const pick = <T>(obj: Record<string, unknown>, ...keys: string[]): T | undefined => {
    for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k] as T;
    return undefined;
  };

  const toSeverity = (v: unknown): ConformIssue["severity"] => {
    if (typeof v === "number") return v === 0 ? "error" : v === 1 ? "warning" : "info";
    const s = String(v).toLowerCase();
    if (s.startsWith("err")) return "error";
    if (s.startsWith("warn")) return "warning";
    return "info";
  };

  const toIssue = (i: Record<string, unknown>): ConformIssue => ({
    severity: toSeverity(pick(i, "Severity", "severity")),
    ruleId: pick<string>(i, "RuleId", "ruleId"),
    location: pick<string>(i, "Location", "location"),
    message: String(pick<string>(i, "Message", "message") ?? "Conformance issue"),
    suggestion: pick<string>(i, "Suggestion", "suggestion"),
  });

  const ep = String(pick<string>(raw, "Endpoint", "endpoint") ?? endpoint);
  const passed = Boolean(pick<boolean>(raw, "Passed", "passed") ?? false);

  if (isWalk) {
    const reports = (pick<Record<string, unknown>[]>(raw, "Reports", "reports") ?? []);
    const issues = reports.flatMap((r) => (pick<Record<string, unknown>[]>(r, "Issues", "issues") ?? []).map(toIssue));
    const total = reports.length;
    const resourcesPassed = Number(
      pick<number>(raw, "ResourcesPassed", "resourcesPassed") ?? reports.filter((r) => Boolean(pick<boolean>(r, "Passed", "passed"))).length
    );
    const totalErrors = Number(pick<number>(raw, "TotalErrors", "totalErrors") ?? issues.filter((i) => i.severity === "error").length);
    const totalWarnings = Number(pick<number>(raw, "TotalWarnings", "totalWarnings") ?? issues.filter((i) => i.severity === "warning").length);
    return {
      endpoint: ep,
      mode: "walk",
      passed,
      resourcesPassed,
      resourcesTotal: total,
      totalErrors,
      totalWarnings,
      issues,
      summary: `Endpoint walk ${passed ? "PASSED" : "FAILED"}: ${resourcesPassed}/${total} resources passed, ${totalErrors} errors, ${totalWarnings} warnings.`,
    };
  }

  const issues = (pick<Record<string, unknown>[]>(raw, "Issues", "issues") ?? []).map(toIssue);
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const resourceType = pick<string>(raw, "ResourceType", "resourceType");
  const resourceId = pick<string>(raw, "ResourceId", "resourceId");
  const profileRequested = pick<string>(raw, "ProfileRequested", "profileRequested");
  const target = resourceType && resourceId ? `${resourceType}/${resourceId}` : (resourceType ?? "resource");
  return {
    endpoint: ep,
    mode: "single",
    passed,
    profileRequested,
    resourceType,
    resourceId,
    httpStatusCode: pick<number>(raw, "HttpStatusCode", "httpStatusCode"),
    issues,
    summary: `${target} against ${profileRequested ?? "profile"}: ${passed ? "PASSED" : "FAILED"} (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}).`,
  };
}
