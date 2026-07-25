#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Wire-shape parity tests: pin the transport normalizers against VERBATIM
 * Bridge response shapes, so the transport-vs-DTO drift class the ergonomics
 * audit found (validate/diff/loft TypeErrors on every Bridge call,
 * AGENT_API_ERGONOMICS_AUDIT §2.2 / Appendix A) can never silently return.
 *
 * The fixtures below are hand-pinned to the C# DTOs (camelCase +
 * JsonStringEnumConverter and the Bridge JSON-options contract):
 *  - validate  → Pidgeon.Core/Domain/Validation/ValidationResult.cs
 *  - diff      → Pidgeon.Core/Domain/Comparison/Entities/MessageDiff.cs
 *  - loft      → Bridge LoftStatusResponse contract
 *  - flock     → Bridge population request contract
 *  - send      → Bridge agent-surface request contract
 * A DTO change on the C# side must be mirrored here (and vice versa) — that IS
 * the contract this file enforces.
 *
 * Run: npx ts-node test/wire-shapes.test.ts
 */

import {
  normalizeValidationResult,
  normalizeDiffResult,
  normalizeLoftStatus,
  normalizeFieldSpec,
} from "../src/transport/wire-normalize";
import { toFlockGenerateBody, toSendBody, toGenerateBody, extractGenerateHeaders } from "../src/transport/wire";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Validate: Core ValidationResult wire shape → transport {errors[], warnings[]}
// ---------------------------------------------------------------------------

// As serialized from Pidgeon.Core.Domain.Validation.ValidationResult (string
// enums, camelCase, nulls omitted). NOTE: no `errors`/`warnings` on the wire.
const BRIDGE_VALIDATE_FIXTURE = {
  isValid: false,
  standard: "hl7",
  mode: "Strict",
  issues: [
    {
      location: "PID.3",
      severity: "Error",
      message: "Patient Identifier List is required but missing",
      ruleId: "RC5",
    },
    {
      location: "PV1.44",
      severity: "Warning",
      message: "Admit Date/Time is recommended",
      ruleId: "REC-12",
      suggestion: "Populate PV1.44 with the admission timestamp",
    },
    {
      location: "Message",
      severity: "Info",
      message: "Message parsed as HL7 v2.5.1",
      ruleId: "INFO-1",
    },
  ],
  statistics: {
    totalRulesChecked: 25,
    rulesPassed: 20,
    rulesFailed: 5,
    fieldsValidated: 42,
    validationTime: "00:00:00.0510000",
    conformanceScore: 80.0, // C# scores 0-100
  },
  metadata: {},
  semanticFindings: [],
  errorCount: 1,
  warningCount: 1,
  infoCount: 1,
  advisoryCount: 0,
};

test("validate: Bridge issues[] normalize into errors/warnings with segment.field split", () => {
  const result = normalizeValidationResult(BRIDGE_VALIDATE_FIXTURE as Record<string, unknown>);
  assert(result.isValid === false, "isValid must carry through");
  assert(result.errors.length === 1, `expected 1 error, got ${result.errors.length}`);
  assert(result.errors[0].segment === "PID", `segment: expected PID, got ${result.errors[0].segment}`);
  assert(result.errors[0].field === "3", `field: expected 3, got ${result.errors[0].field}`);
  assert(result.errors[0].ruleId === "RC5", "ruleId must carry through");
  assert(result.warnings.length === 2, `expected 2 warnings (Warning + Info), got ${result.warnings.length}`);
  assert(result.warnings[1].severity === "info", "Info issues keep their severity");
});

test("validate: conformance score rescales from the Bridge's 0-100 to the transport's 0-1", () => {
  const result = normalizeValidationResult(BRIDGE_VALIDATE_FIXTURE as Record<string, unknown>);
  assert(result.conformanceScore === 0.8, `expected 0.8, got ${result.conformanceScore}`);
});

test("validate: already-transport-shaped payloads pass through unchanged (CLI transport, mocks)", () => {
  const shaped = { isValid: true, errors: [], warnings: [], conformanceScore: 0.95 };
  const result = normalizeValidationResult(shaped as Record<string, unknown>);
  assert(result.conformanceScore === 0.95, "pass-through must not rescale an already 0-1 score");
  assert(result.errors.length === 0 && result.warnings.length === 0, "pass-through arrays intact");
});

// ---------------------------------------------------------------------------
// Diff: Core MessageDiff wire shape → transport {differences[]}
// ---------------------------------------------------------------------------

const BRIDGE_DIFF_FIXTURE = {
  id: "d2f9c4e1",
  context: { comparisonType: "MessageToMessage" },
  fieldDifferences: [
    {
      fieldPath: "PID.3",
      fieldDescription: "Patient Identifier List",
      leftValue: "MRN001",
      rightValue: "MRN002",
      differenceType: "ValueDifference",
      severity: "Critical",
      suggestedFix: "Confirm the intended patient identity",
      confidence: 0.9,
    },
    {
      fieldPath: "MSH.7",
      fieldDescription: "Date/Time of Message",
      leftValue: "20260301120000",
      rightValue: "20260301120005",
      differenceType: "ValueDifference",
      severity: "Info",
      confidence: 1.0,
    },
    {
      fieldPath: "PV1.2",
      fieldDescription: "Patient Class",
      leftValue: "I",
      rightValue: "O",
      differenceType: "ValueDifference",
      severity: "Error",
      confidence: 0.8,
    },
  ],
  similarityScore: 0.92,
};

test("diff: fieldDifferences[] normalize into differences[] with the severity ladder mapped", () => {
  const result = normalizeDiffResult(BRIDGE_DIFF_FIXTURE as Record<string, unknown>);
  assert(result.differences.length === 3, `expected 3 differences, got ${result.differences.length}`);
  assert(result.differences[0].path === "PID.3", "path maps from fieldPath");
  assert(result.differences[0].severity === "critical", "Critical → critical");
  assert(result.differences[1].severity === "cosmetic", "Info → cosmetic");
  assert(result.differences[2].severity === "major", "Error → major");
  assert(
    result.differences[0].description === "Confirm the intended patient identity",
    "description prefers suggestedFix"
  );
  assert(result.summary.includes("92%"), `summary carries similarity: ${result.summary}`);
});

// ---------------------------------------------------------------------------
// Loft: aggregate LoftStatusResponse + InterfaceResponse[] → transport shape
// ---------------------------------------------------------------------------

const BRIDGE_LOFT_AGGREGATE_FIXTURE = {
  overallStatus: "degraded",
  activeInterfaces: 2,
  stoppedInterfaces: 1,
  totalMessagesProcessed: 1801,
  totalErrors: 87,
  errorRate: 0.048,
  recentAlerts: 3,
  lastMessageAt: "2026-07-03T11:58:00Z",
};

const BRIDGE_LOFT_INTERFACES_FIXTURE = [
  {
    id: "if_1",
    name: "Epic ADT",
    directoryPath: "C:/mirth/pickup/adt",
    status: "Running",
    metrics: { totalMessagesProcessed: 1234, totalErrors: 12, totalSuccesses: 1222, errorRate: 0.0097 },
  },
  {
    id: "if_2",
    name: "Cerner Labs",
    directoryPath: "C:/mirth/pickup/labs",
    status: "Stopped",
    metrics: { totalMessagesProcessed: 567, totalErrors: 75, totalSuccesses: 492, errorRate: 0.1323 },
  },
];

test("loft: aggregate + interface list normalize into per-interface rows and a real summary", () => {
  const result = normalizeLoftStatus(
    BRIDGE_LOFT_AGGREGATE_FIXTURE as Record<string, unknown>,
    BRIDGE_LOFT_INTERFACES_FIXTURE as Record<string, unknown>[]
  );
  assert(result.interfaces.length === 2, `expected 2 interfaces, got ${result.interfaces.length}`);
  assert(result.interfaces[0].status === "healthy", "Running → healthy");
  assert(result.interfaces[1].status === "error", "Stopped → error");
  assert(result.interfaces[0].messageCount === 1234, "metrics carry through");
  assert(result.summary.includes("degraded"), "summary carries overall status");
  assert(result.summary.includes("1801"), "summary carries message volume");
});

test("loft: the aggregate alone (interfaces fetch failed) still yields a valid result", () => {
  const result = normalizeLoftStatus(BRIDGE_LOFT_AGGREGATE_FIXTURE as Record<string, unknown>);
  assert(result.interfaces.length === 0, "no fabricated interfaces");
  assert(result.summary.includes("2 active"), "aggregate summary intact");
});

// ---------------------------------------------------------------------------
// Flock request: MCP options → FlockGenerateRequest wire names
// ---------------------------------------------------------------------------

test("flock: population/location map onto count/geographicFocus — the drift that silently started 1000-patient jobs", () => {
  const body = toFlockGenerateBody({ population: 50, location: "MS", format: "hl7", seed: 42 });
  assert((body as Record<string, unknown>)["count"] === 50, "population → count");
  assert((body as Record<string, unknown>)["geographicFocus"] === "MS", "location → geographicFocus");
  assert((body as Record<string, unknown>)["format"] === "hl7", "format carries through");
  assert((body as Record<string, unknown>)["seed"] === 42, "seed carries through");
  assert(!("population" in body), "the MCP name must not leak onto the wire");
  assert(!("location" in body), "the MCP name must not leak onto the wire");
});

// ---------------------------------------------------------------------------
// Send request: MCP options → SendMessageRequest wire names
// ---------------------------------------------------------------------------

test("send: message/destination/filename/idempotencyKey map onto SendMessageRequest", () => {
  const body = toSendBody("MSH|...", "sftp://host/pickup", {
    filename: "a.hl7",
    idempotencyKey: "k1",
    protocol: "sftp",
  });
  assert(body.message === "MSH|...", "message carries through");
  assert(body.destination === "sftp://host/pickup", "destination carries through");
  assert(body.filename === "a.hl7", "filename carries through");
  assert(body.idempotencyKey === "k1", "idempotencyKey carries through");
});

// ---------------------------------------------------------------------------
// Generate request: pins map onto GenerateRequest wire names (LockedValues /
// LockSessionName), so the MCP pins reach the Bridge composer.
// ---------------------------------------------------------------------------

// The two pin sources are mutually exclusive (the tool handler rejects both at
// once), so each leg is pinned alone — proving it reaches the wire AND that the
// unused leg stays absent, not that both can ride together.
test("generate: lockedValues alone reaches GenerateRequest, lockSessionName absent", () => {
  const body = toGenerateBody("ADT^A01", {
    seed: 9,
    lockedValues: [{ fieldPath: "PID.5.1", value: "DOE" }],
  }) as Record<string, unknown>;
  assert(body["seed"] === 9, "seed carries through");
  assert(Array.isArray(body["lockedValues"]) && (body["lockedValues"] as unknown[]).length === 1, "lockedValues carry through");
  assert(((body["lockedValues"] as Array<Record<string, unknown>>)[0]).fieldPath === "PID.5.1", "the pin's fieldPath is on the wire");
  assert(body["lockSessionName"] === undefined, "the unused pin source stays absent");
});

test("generate: lockSessionName alone reaches GenerateRequest, lockedValues absent", () => {
  const body = toGenerateBody("ADT^A01", { lockSessionName: "epic_er" }) as Record<string, unknown>;
  assert(body["lockSessionName"] === "epic_er", "lockSessionName carries through");
  assert(body["lockedValues"] === undefined, "the unused pin source stays absent");
});

// ---------------------------------------------------------------------------
// Generate response headers: Bridge X-Pidgeon-Effective-Seed + X-RateLimit-*
// (lower-cased by node) → {effectiveSeed, volume}. Non-numeric = absent, so a
// malformed header can never surface NaN into the self-pacing line.
// ---------------------------------------------------------------------------

test("generate headers: effective seed + volume parse; malformed values drop to absent", () => {
  const good = extractGenerateHeaders({
    "x-pidgeon-effective-seed": "4242",
    "x-ratelimit-limit": "100",
    "x-ratelimit-remaining": "5",
    "x-ratelimit-reset": "2026-07-03T00:00:00Z",
  });
  assert(good.effectiveSeed === 4242, "effective seed parses");
  assert(good.volume?.limit === 100 && good.volume?.remaining === 5, "volume parses");
  assert(good.volume?.resetsAt === "2026-07-03T00:00:00Z", "reset carries through");

  const bad = extractGenerateHeaders({ "x-pidgeon-effective-seed": "unlimited", "x-ratelimit-limit": "x" });
  assert(bad.effectiveSeed === undefined, "non-numeric seed → undefined, never NaN");
  assert(bad.volume === undefined, "partial/non-numeric volume → undefined, never NaN");
});

// ---------------------------------------------------------------------------
// Field spec: Bridge FieldReferenceDto (GET /api/lookup/field) → FieldSpecResult.
// Pinned to the Bridge wire contract (camelCase); the version is echoed from the
// request, proving the tool renders the version the field was resolved against.
// ---------------------------------------------------------------------------

const BRIDGE_FIELD_FIXTURE = {
  segment: "PID",
  position: 5,
  name: "Patient Name",
  dataType: "XPN",
  optionality: "R",
  maxLength: 250,
  repeatability: "*",
  tableReference: "0200",
  description: "Legal name of the patient",
};

test("field spec: FieldReferenceDto normalizes into FieldSpecResult with the requested version echoed", () => {
  const spec = normalizeFieldSpec(BRIDGE_FIELD_FIXTURE as Record<string, unknown>, "PID", 5, "2.8");
  assert(spec.segment === "PID" && spec.position === 5, "segment/position carry through");
  assert(spec.name === "Patient Name", "name carries through");
  assert(spec.dataType === "XPN", "dataType carries through");
  assert(spec.optionality === "R", "optionality carries through");
  assert(spec.maxLength === 250, "maxLength carries through");
  assert(spec.tableReference === "0200", "table reference carries through");
  assert(spec.version === "2.8", "the echoed version is the caller-resolved one, not a hardcode");
});

test("field spec: PascalCase DTO keys still normalize (tolerant pick)", () => {
  const spec = normalizeFieldSpec({ Segment: "OBX", Position: 3, Name: "Observation Identifier", DataType: "CE" }, "OBX", 3, "2.5.1");
  assert(spec.name === "Observation Identifier", "PascalCase Name resolves");
  assert(spec.dataType === "CE", "PascalCase DataType resolves");
});

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
