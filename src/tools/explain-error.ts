// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { errorResult } from "./format.js";
import { ValidationError } from "../transport/index.js";

/** Max wait for the optional on-device narration-readiness probe before falling back to procedural triage. */
const NARRATION_PROBE_TIMEOUT_MS = 1500;

/**
 * explain_error — turn a validation or conformance finding into a plain-English
 * explanation plus a concrete suggested fix. This is the deterministic core of
 * on-device AI triage: the diagnosis a free user gets before paying for the
 * fix-and-deliver (refine_hl7_segment / send). It is procedural by design —
 * NORTH_STAR § On-device AI: the explanation must stand on its own with zero API
 * key; an on-device model only narrates on top of it, never gates the result.
 * The AI-narration seam is the optional layer noted at the end of the file.
 *
 * Two entry shapes (at least one required):
 *   - `message`: validate it (compatibility mode) and triage every finding.
 *   - `findings`: triage findings the caller already has — e.g. the issues a
 *     prior `validate_message` or `conform` call returned — without re-running.
 */

interface Finding {
  segment?: string;
  field?: string;
  ruleId?: string;
  message: string;
  severity: "error" | "warning" | "info";
}

interface Triage {
  what: string;
  why: string;
  fix: string;
}

// Required HL7 fields the triage can name precisely. Keyed by `SEG.field`.
const FIELD_PURPOSE: Record<string, string> = {
  "MSH.7": "the message date/time",
  "MSH.9": "the message type (e.g. ADT^A01)",
  "MSH.10": "the message control ID",
  "MSH.11": "the processing ID (P/T/D)",
  "MSH.12": "the HL7 version ID (e.g. 2.5.1)",
  "EVN.2": "the recorded date/time of the event",
  "PID.3": "the patient identifier list (MRN)",
  "PID.5": "the patient name",
  "PID.7": "the patient date of birth",
  "PID.8": "the administrative sex",
  "PV1.2": "the patient class (I/O/E)",
  "ORC.1": "the order control code",
  "OBR.4": "the universal service identifier",
  "OBX.2": "the value type (NM, ST, CE, …)",
  "OBX.3": "the observation identifier",
  "OBX.11": "the observation result status",
};

const SEGMENT_PURPOSE: Record<string, string> = {
  MSH: "Message Header — routing, encoding, version",
  EVN: "Event Type — the trigger event",
  PID: "Patient Identification — demographics and MRN",
  PV1: "Patient Visit — encounter, class, provider",
  OBR: "Observation Request — the order",
  OBX: "Observation Result — a result value",
  ORC: "Common Order — order control",
  RXE: "Pharmacy Encoded Order — drug, dose, route",
  DG1: "Diagnosis — ICD codes",
  IN1: "Insurance — coverage details",
};

type Category =
  | "required"
  | "format"
  | "table"
  | "mustSupport"
  | "structure"
  | "version"
  | "generic";

function classify(finding: Finding): Category {
  const rule = (finding.ruleId ?? "").toUpperCase();
  const msg = finding.message.toLowerCase();

  if (rule.startsWith("MUSTSUPPORT") || /must.?support/.test(msg)) return "mustSupport";
  if (/required|missing|mandatory|cardinality|must be present|min(imum)? occur/.test(msg) || rule.startsWith("REQUIRED") || rule.startsWith("RC"))
    return "required";
  if (/table|code set|coded value|not in (the )?(value set|table)|invalid (code|value)|vocab/.test(msg) || rule.startsWith("TABLE"))
    return "table";
  if (/format|data ?type|invalid date|expected (a )?(date|number|numeric)|too long|exceeds|length|truncat|escap|encoding/.test(msg) || rule.startsWith("DATATYPE") || rule.startsWith("TS") || rule.startsWith("DT"))
    return "format";
  if (/unknown segment|unexpected segment|z-?segment|out of order|segment order|group/.test(msg) || rule.startsWith("ORDER") || rule.startsWith("STRUCT"))
    return "structure";
  if (/version/.test(msg)) return "version";
  return "generic";
}

// Resolve "PID.3"-style location from explicit fields, the rule id, or the message text.
function locationKey(finding: Finding): string | null {
  if (finding.segment && finding.field) return `${finding.segment}.${finding.field}`;
  if (finding.segment && !finding.field) return finding.segment;
  const m = finding.message.match(/\b([A-Z][A-Z0-9]{2})[.\-]?(\d{1,3})\b/);
  if (m) return `${m[1]}.${m[2]}`;
  const seg = finding.message.match(/\b([A-Z][A-Z0-9]{2})\b/);
  if (seg && SEGMENT_PURPOSE[seg[1]]) return seg[1];
  return null;
}

function subjectPhrase(loc: string | null): string {
  if (!loc) return "the flagged element";
  if (FIELD_PURPOSE[loc]) return `${loc} (${FIELD_PURPOSE[loc]})`;
  const seg = loc.split(".")[0];
  if (loc.includes(".")) return SEGMENT_PURPOSE[seg] ? `${loc} in the ${seg} segment (${SEGMENT_PURPOSE[seg]})` : loc;
  return SEGMENT_PURPOSE[seg] ? `the ${seg} segment (${SEGMENT_PURPOSE[seg]})` : `the ${seg} segment`;
}

function triage(finding: Finding): Triage {
  const category = classify(finding);
  const loc = locationKey(finding);
  const subject = subjectPhrase(loc);

  switch (category) {
    case "required":
      return {
        what: `${subject} is required but missing or empty.`,
        why: "The HL7 / IG conformance profile marks this element as mandatory — receivers reject or mis-route the message when it is absent.",
        fix: `Populate ${loc ?? "the field"} with a valid value. The most common offenders are MSH.9 (message type), MSH.10 (control ID), MSH.12 (version), and PID.3 (patient ID) — confirm each carries a value before sending.`,
      };
    case "format":
      return {
        what: `${subject} has a value that doesn't match its declared data type or length.`,
        why: "Each field has an HL7 data type (e.g. DTM dates as YYYYMMDD[HHMMSS], NM for numerics, CE/CWE for coded elements). A value in the wrong shape fails strict validation even when the intent is clear.",
        fix: `Re-format ${loc ?? "the value"} to its data type: dates as YYYYMMDD (not YYYY-MM-DD), numerics without units in the value component, and coded elements as code^text^system. Use get_segment_spec to confirm the expected type.`,
      };
    case "table":
      return {
        what: `${subject} carries a code that isn't in the expected HL7 table / value set.`,
        why: "Table-bound fields only accept values from a defined set (e.g. PID.8 administrative sex, PV1.2 patient class). An out-of-table code is a conformance failure.",
        fix: `Replace the value in ${loc ?? "the field"} with a permitted table value. Use lookup_code or get_segment_spec to see the allowed set for this field.`,
      };
    case "mustSupport":
      return {
        what: `${subject} is a must-support element that is absent or unpopulated.`,
        why: "CMS-0057-F / US Core profiles require must-support elements to be sent when the data exists. In --ci mode a must-support gap is a hard fail, not a warning.",
        fix: `Populate ${loc ?? "the element"} if the source data is available, or confirm the data-absent reason is acceptable for this profile. Re-run conform --ci to verify the must-support gap clears.`,
      };
    case "structure":
      return {
        what: `${subject} is out of place — an unexpected, out-of-order, or unknown segment.`,
        why: "Each message type has a segment grammar (required segments, ordering, groups). A segment in the wrong place — or a site-specific Z-segment the profile doesn't know — breaks structural validation.",
        fix: `Re-order the segments to the message-type grammar, or register the Z-segment in the vendor profile. Use explain_message to see the segments present and get_segment_spec for the expected structure.`,
      };
    case "version":
      return {
        what: `${subject} indicates an HL7 version mismatch.`,
        why: "A v2.3 message validated against a v2.7 profile (or vice-versa) fails on fields that changed between versions. MSH.12 declares the version the receiver validates against.",
        fix: "Align MSH.12 with the version the endpoint expects, or generate the message for the target version (generate_message --hl7-version).",
      };
    default:
      return {
        what: `${subject}: ${finding.message}`,
        why: "This finding came from validating against the standard (and any vendor profile). It is graded against the external spec, not against the message itself.",
        fix: "Inspect the named field with get_segment_spec, correct the value, and re-run validate_message (or refine_hl7_segment to apply and self-heal the fix in place).",
      };
  }
}

const findingSchema = z.object({
  segment: z.string().optional().describe("Segment name, e.g. 'PID'."),
  field: z.union([z.string(), z.number()]).optional().describe("Field position, e.g. 3."),
  ruleId: z.string().optional().describe("Rule id, e.g. 'MUSTSUPPORT-1' or 'RC5'."),
  message: z.string().describe("The error/finding text."),
  severity: z.enum(["error", "warning", "info"]).optional().describe("Severity. Defaults to 'error'."),
});

const inputSchema = z.object({
  message: z
    .string()
    .optional()
    .describe("Raw HL7/FHIR message to validate and triage. Provide this OR `findings`."),
  standard: z.enum(["hl7", "fhir"]).optional().describe("Message standard. Auto-detected if omitted."),
  findings: z
    .array(findingSchema)
    .optional()
    .describe("Findings you already have (e.g. from validate_message or conform), triaged without re-validating. Provide this OR `message`."),
  narrate: z
    .boolean()
    .optional()
    .describe(
      "Reword each fix with the on-device model when one is available (default true); set false for deterministic triage only. Narration runs on-device and never changes the contract."
    ),
});

function normalizeField(field: unknown): string | undefined {
  if (field === undefined || field === null) return undefined;
  return String(field);
}

export function createExplainErrorTool(): ToolDefinition {
  return {
    name: "explain_error",
    requiredTier: "free",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Triage a validation or conformance failure: for each finding, explain in plain English what is wrong, " +
      "why the rule exists, and the concrete fix. Pass a raw `message` (it will be validated) or a list of `findings` " +
      "you already have (e.g. from validate_message or conform). Runs on-device — no API key, no PHI leaves the machine. " +
      "First rung of the triage ladder: this handles spec/conformance findings — for clinical-sense problems use " +
      "clinical_check (deterministic rules) then semantic_review (the on-device judge), not explain_error.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      let findings: Finding[] = [];

      if (parsed.findings && parsed.findings.length > 0) {
        findings = parsed.findings.map((f) => ({
          segment: f.segment,
          field: normalizeField(f.field),
          ruleId: f.ruleId,
          message: f.message,
          severity: f.severity ?? "error",
        }));
      } else if (parsed.message) {
        let result;
        try {
          result = await transport.validate(parsed.message, {
            mode: "compatibility",
            standard: parsed.standard,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult(`Could not validate the message to triage it: ${message}`);
        }
        const collect = (arr: ValidationError[], sev: Finding["severity"]) =>
          arr.map((e) => ({
            segment: e.segment,
            field: e.field,
            ruleId: e.ruleId,
            message: e.message,
            severity: sev,
          }));
        findings = [...collect(result.errors, "error"), ...collect(result.warnings, "warning")];

        if (findings.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  "No validation findings to explain — the message is clean (compatibility mode). " +
                  "Run validate_message in strict mode if you want spec-strict findings to triage.",
              },
            ],
          };
        }
      } else {
        return errorResult("Provide either `message` (to validate) or `findings` (to triage directly).");
      }

      const lines: string[] = [];
      const errorCount = findings.filter((f) => f.severity === "error").length;
      const warnCount = findings.length - errorCount;
      lines.push(
        `Triaged ${findings.length} finding${findings.length === 1 ? "" : "s"} ` +
          `(${errorCount} error${errorCount === 1 ? "" : "s"}, ${warnCount} warning${warnCount === 1 ? "" : "s"}).`
      );
      lines.push("");

      // On-device narration is opt-out and never load-bearing: the procedural
      // triage is the contract; when a local model is present we only reword
      // the Fix. Probe readiness once, then narrate per finding — any failure
      // (or no model) leaves the procedural fix verbatim.
      let narrationReady = false;
      if (parsed.narrate !== false) {
        try {
          // Bound the readiness probe: getAiModelStatus() hits the Bridge (and can
          // stall when no on-device model / Ollama is running). explain_error is a
          // free, on-device tool whose contract is the procedural triage — it must
          // never hang waiting on an optional narration model. If the probe does
          // not answer fast, we skip narration and keep the procedural fix.
          const status = await Promise.race([
            transport.getAiModelStatus(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), NARRATION_PROBE_TIMEOUT_MS)),
          ]);
          narrationReady = status !== null && status.ready === true;
        } catch {
          narrationReady = false;
        }
      }

      for (let i = 0; i < findings.length; i++) {
        const finding = findings[i];
        const t = triage(finding);
        const loc = locationKey(finding);

        let fix = t.fix;
        if (narrationReady) {
          try {
            const narrated = await transport.narrate({
              findingMessage: finding.message,
              proceduralWhat: t.what,
              proceduralWhy: t.why,
              proceduralFix: t.fix,
              location: loc ?? undefined,
              standard: parsed.standard,
            });
            if (narrated && narrated.narratedFix.trim().length > 0) {
              fix = narrated.narratedFix.trim();
            }
          } catch {
            // Keep the procedural fix.
          }
        }

        const sevTag = finding.severity === "error" ? "ERROR" : finding.severity === "warning" ? "WARN" : "INFO";
        const heading = [`**${i + 1}. [${sevTag}]`, loc ? `${loc}` : null, finding.ruleId ? `(${finding.ruleId})` : null]
          .filter(Boolean)
          .join(" ")
          .concat("**");
        lines.push(heading);
        lines.push(`- What: ${t.what}`);
        lines.push(`- Why: ${t.why}`);
        lines.push(`- Fix: ${fix}`);
        lines.push("");
      }

      lines.push(
        "Next: apply a fix with refine_hl7_segment (Pro — edits the segment in place and self-heals), " +
          "then re-run validate_message to confirm it clears."
      );

      return { content: [{ type: "text", text: lines.join("\n").trimEnd() }] };
    },
  };
}

// AI-narration seam (optional, on-device, never load-bearing): when the Bridge
// reports a ready on-device model (Ollama + a bundled model), the
// handler calls `transport.narrate(...)` per finding to reword each `Fix` with
// message-specific phrasing via POST /api/ai/triage/narrate. Narration runs
// on-device only (the Bridge degrades a cloud/BYOK provider to a null result),
// is opt-out via the `narrate` input, and never changes the contract — the
// procedural triage above is what's returned whenever no model is present.
