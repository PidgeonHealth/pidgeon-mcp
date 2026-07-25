// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ValidationResult, ValidationError, DiffResult, FieldDifference, LoftStatusResult } from "./types.js";
import { FieldSpecResult } from "./reference-types.js";

/**
 * Normalizers pinning the Bridge's ACTUAL response shapes to the transport
 * types the tools render. The transport types were originally hand-rolled and
 * drifted from the C# DTOs (AGENT_API_ERGONOMICS_AUDIT §2.2 / Appendix A) —
 * every Bridge response now passes through here so the drift class is closed
 * at one seam. Wire sources (camelCase + JsonStringEnumConverter per
 * the Bridge JSON-options contract):
 *
 *  - validate: Pidgeon.Core/Domain/Validation/ValidationResult.cs
 *      { isValid, standard, mode, issues: [{ location, severity, message,
 *        ruleId, expectedValue?, actualValue?, suggestion? }],
 *        statistics: { conformanceScore (0-100), ... } }
 *  - diff: Pidgeon.Core/Domain/Comparison/Entities/MessageDiff.cs
 *      { id, context, fieldDifferences: [{ fieldPath, fieldDescription,
 *        leftValue, rightValue, differenceType, severity, suggestedFix, ... }],
 *        similarityScore (0-1) }
 *  - loft status: the Bridge LoftStatusResponse contract
 *      { overallStatus, activeInterfaces, stoppedInterfaces,
 *        totalMessagesProcessed, totalErrors, errorRate, recentAlerts,
 *        lastMessageAt? } plus GET /api/loft/interfaces InterfaceResponse[].
 *
 * Style follows conform-normalize.ts: tolerant pick() over both casings, and
 * pass-through when the payload already matches the transport type (mocks,
 * the CLI transport's own normalization).
 */

function pick<T>(obj: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/** Split an issue Location ("PID.5", "Patient.name", "Message") into segment/field. */
function splitLocation(location: string | undefined): { segment?: string; field?: string } {
  if (!location) return {};
  const dot = location.indexOf(".");
  if (dot === -1) return { segment: location };
  return { segment: location.slice(0, dot), field: location.slice(dot + 1) };
}

function toIssueSeverity(v: unknown): "error" | "warning" | "info" {
  const s = String(v ?? "").toLowerCase();
  if (s === "error" || s === "critical" || s === "0") return "error";
  if (s === "warning" || s === "1") return "warning";
  return "info";
}

export function normalizeValidationResult(raw: Record<string, unknown>): ValidationResult {
  // Already transport-shaped (test mocks / pre-normalized payloads): pass
  // through. This assumes the Bridge never sends a top-level errors/warnings
  // array — it always sends issues[] (ValidationResult.cs). If the Bridge ever
  // adds structured top-level errors, tighten this guard.
  if (Array.isArray(raw["errors"]) || Array.isArray(raw["warnings"])) {
    return raw as unknown as ValidationResult;
  }

  const issues = (pick<Record<string, unknown>[]>(raw, "issues", "Issues") ?? []).map((i) => {
    const loc = splitLocation(pick<string>(i, "location", "Location"));
    const issue: ValidationError = {
      segment: loc.segment,
      field: loc.field,
      message: pick<string>(i, "message", "Message") ?? "Validation issue",
      severity: toIssueSeverity(pick(i, "severity", "Severity")),
      ruleId: pick<string>(i, "ruleId", "RuleId"),
    };
    return issue;
  });

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity !== "error");

  const statistics = pick<Record<string, unknown>>(raw, "statistics", "Statistics") ?? {};
  // The Bridge scores 0-100 (ValidationStatistics.ConformanceScore); the
  // transport contract is 0-1 (validate.ts multiplies by 100 for display).
  const rawScore = Number(pick<number>(statistics, "conformanceScore", "ConformanceScore") ?? NaN);
  const conformanceScore = Number.isFinite(rawScore)
    ? Math.min(1, Math.max(0, rawScore / 100))
    : undefined;

  // Trust the Bridge's verdict when present (?? only falls through on absence,
  // never on false); fall back to the error count for payloads without one.
  const isValid = pick<boolean>(raw, "isValid", "IsValid") ?? errors.length === 0;
  const fieldsValidated = pick<number>(statistics, "fieldsValidated", "FieldsValidated");

  return {
    isValid,
    errors,
    warnings,
    conformanceScore,
    standard: pick<string>(raw, "standard", "Standard"),
    summary:
      `${errors.length} error(s), ${warnings.length} warning(s)` +
      (fieldsValidated !== undefined ? ` across ${fieldsValidated} field(s) checked.` : "."),
  };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function toDiffSeverity(v: unknown): FieldDifference["severity"] {
  switch (String(v ?? "").toLowerCase()) {
    case "critical":
      return "critical";
    case "error":
      return "major";
    case "warning":
      return "minor";
    default:
      return "cosmetic";
  }
}

export function normalizeDiffResult(raw: Record<string, unknown>): DiffResult {
  // Already transport-shaped: pass through.
  if (Array.isArray(raw["differences"])) {
    return raw as unknown as DiffResult;
  }

  const differences = (pick<Record<string, unknown>[]>(raw, "fieldDifferences", "FieldDifferences") ?? []).map(
    (d): FieldDifference => ({
      path: pick<string>(d, "fieldPath", "FieldPath") ?? "",
      leftValue: pick<string>(d, "leftValue", "LeftValue"),
      rightValue: pick<string>(d, "rightValue", "RightValue"),
      severity: toDiffSeverity(pick(d, "severity", "Severity")),
      description:
        pick<string>(d, "suggestedFix", "SuggestedFix") ??
        pick<string>(d, "fieldDescription", "FieldDescription"),
    })
  );

  const similarity = Number(pick<number>(raw, "similarityScore", "SimilarityScore") ?? NaN);

  return {
    differences,
    summary:
      differences.length === 0
        ? "No field-level differences found."
        : `${differences.length} field-level difference(s)` +
          (Number.isFinite(similarity) ? `; similarity ${(similarity * 100).toFixed(0)}%.` : "."),
  };
}

// ---------------------------------------------------------------------------
// Loft status
// ---------------------------------------------------------------------------

function toInterfaceStatus(v: unknown): "healthy" | "warning" | "error" | "unknown" {
  switch (String(v ?? "").toLowerCase()) {
    case "healthy":
    case "running":
    case "active":
      return "healthy";
    case "warning":
    case "degraded":
      return "warning";
    case "error":
    case "failed":
    case "stopped":
      return "error";
    default:
      return "unknown";
  }
}

/**
 * Combines the aggregate GET /api/loft/status (LoftStatusResponse) with the
 * per-interface GET /api/loft/interfaces list (InterfaceResponse[], optional:
 * best-effort, the aggregate alone still yields a valid summary).
 */
export function normalizeLoftStatus(
  aggregate: Record<string, unknown>,
  interfaceList?: Record<string, unknown>[]
): LoftStatusResult {
  // Already transport-shaped: pass through.
  if (Array.isArray(aggregate["interfaces"]) && typeof aggregate["summary"] === "string") {
    return aggregate as unknown as LoftStatusResult;
  }

  const interfaces = (interfaceList ?? []).map((i) => {
    const metrics = pick<Record<string, unknown>>(i, "metrics", "Metrics") ?? {};
    return {
      name: pick<string>(i, "name", "Name") ?? pick<string>(i, "id", "Id") ?? "unknown",
      status: toInterfaceStatus(pick(i, "status", "Status")),
      messageCount: pick<number>(metrics, "totalMessagesProcessed", "TotalMessagesProcessed"),
      errorRate: pick<number>(metrics, "errorRate", "ErrorRate"),
      lastMessage: pick<string>(metrics, "lastMessageAt", "LastMessageAt"),
    };
  });

  const overall = pick<string>(aggregate, "overallStatus", "OverallStatus") ?? "unknown";
  const active = pick<number>(aggregate, "activeInterfaces", "ActiveInterfaces") ?? interfaces.length;
  const stopped = pick<number>(aggregate, "stoppedInterfaces", "StoppedInterfaces") ?? 0;
  const totalMessages = pick<number>(aggregate, "totalMessagesProcessed", "TotalMessagesProcessed") ?? 0;
  const totalErrors = pick<number>(aggregate, "totalErrors", "TotalErrors") ?? 0;
  const recentAlerts = pick<number>(aggregate, "recentAlerts", "RecentAlerts") ?? 0;

  return {
    interfaces,
    summary:
      `Overall: ${overall} — ${active} active / ${stopped} stopped interface(s); ` +
      `${totalMessages} message(s) processed, ${totalErrors} error(s), ${recentAlerts} recent alert(s).`,
  };
}

// ---------------------------------------------------------------------------
// Reference: field spec (GET /api/lookup/field, FieldReferenceDto)
// ---------------------------------------------------------------------------

/**
 * Projects the Bridge FieldReferenceDto onto FieldSpecResult. The echoed version
 * is the caller-resolved one (the Bridge resolves the field against it, and its
 * ResolveVersion defaults an omitted version to 2.3), so the tool renders the
 * version the field was actually resolved against.
 */
export function normalizeFieldSpec(
  dto: Record<string, unknown>,
  segment: string,
  position: number,
  version: string
): FieldSpecResult {
  return {
    segment: pick<string>(dto, "segment", "Segment") ?? segment,
    position: pick<number>(dto, "position", "Position") ?? position,
    name: pick<string>(dto, "name", "Name") ?? "",
    dataType: pick<string>(dto, "dataType", "DataType") ?? "",
    optionality: pick<string>(dto, "optionality", "Optionality") ?? "",
    maxLength: pick<number>(dto, "maxLength", "MaxLength"),
    repeatability: pick<string>(dto, "repeatability", "Repeatability"),
    tableReference: pick<string>(dto, "tableReference", "TableReference"),
    description: pick<string>(dto, "description", "Description"),
    version,
  };
}
