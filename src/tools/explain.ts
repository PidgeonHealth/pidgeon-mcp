// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { withSuccessEnvelope } from "./format.js";

const SEGMENT_DESCRIPTIONS: Record<string, string> = {
  MSH: "Message Header — routing, encoding, timestamp",
  EVN: "Event Type — trigger event details",
  PID: "Patient Identification — demographics, MRN, name, DOB",
  PV1: "Patient Visit — encounter details, attending provider, location",
  PV2: "Patient Visit Additional — admit reason, expected discharge",
  OBR: "Observation Request — order details, test requested",
  OBX: "Observation Result — lab/clinical result values",
  ORC: "Common Order — order control, filler/placer numbers",
  RXE: "Pharmacy Encoded Order — drug, dose, route",
  RXR: "Pharmacy Route",
  RXD: "Pharmacy Dispense",
  DG1: "Diagnosis — ICD codes, diagnosis type",
  IN1: "Insurance — primary insurance details",
  NK1: "Next of Kin / Associated Parties",
  AL1: "Allergy Information",
  GT1: "Guarantor — billing contact",
  NTE: "Notes and Comments",
  SPM: "Specimen — sample collection details",
  TXA: "Transcription Document Header",
  ZBX: "Z-segment (custom extension)",
};

// Human-readable names for HL7 trigger events.
const TRIGGER_EVENT_NAMES: Record<string, string> = {
  "ADT^A01": "Patient Admission",
  "ADT^A02": "Patient Transfer",
  "ADT^A03": "Patient Discharge",
  "ADT^A04": "Patient Registration",
  "ADT^A05": "Pre-Admission",
  "ADT^A06": "Change Outpatient to Inpatient",
  "ADT^A07": "Change Inpatient to Outpatient",
  "ADT^A08": "Patient Information Update",
  "ADT^A11": "Cancel Admission",
  "ADT^A12": "Cancel Transfer",
  "ADT^A13": "Cancel Discharge",
  "ADT^A28": "Add Person Information",
  "ADT^A31": "Update Person Information",
  "ADT^A40": "Merge Patient",
  "ORU^R01": "Unsolicited Observation/Lab Result",
  "ORM^O01": "General Order",
  "ORR^O02": "General Order Response",
  "RDE^O11": "Pharmacy Encoded Order",
  "RDS^O13": "Pharmacy Dispense",
  "RAS^O17": "Pharmacy Administration",
  "MDM^T01": "Transcription Document Notification",
  "MDM^T02": "Transcription Document with Content",
  "SIU^S12": "Schedule Appointment",
  "SIU^S14": "Schedule Appointment Modification",
  "SIU^S15": "Schedule Appointment Cancellation",
  "BAR^P01": "Add Patient Account",
  "BAR^P02": "Purge Patient Account",
  "DFT^P03": "Post Detail Financial Transaction",
};

interface ParsedHL7 {
  messageType: string;
  triggerEvent: string;
  sendingApp: string;
  sendingFacility: string;
  timestamp: string;
  segments: Array<{ name: string; raw: string }>;
  patientName: string | null;
  patientId: string | null;
}

function parseHL7(raw: string): ParsedHL7 | null {
  // Normalize line endings — HL7 uses \r as segment terminator
  const normalized = raw.replace(/\r\n/g, "\r").replace(/\n/g, "\r");
  const segmentStrings = normalized.split("\r").filter((s) => s.trim().length > 0);

  if (segmentStrings.length === 0) return null;

  const msh = segmentStrings.find((s) => s.startsWith("MSH"));
  if (!msh) return null;

  const fields = msh.split("|");
  // MSH.9 = message type (index 8), MSH.3 = sending app, MSH.4 = sending facility, MSH.7 = datetime
  const msgType = fields[8] ?? "";
  const [eventCode, triggerCode] = msgType.split("^");
  const messageType = triggerCode ? `${eventCode}^${triggerCode}` : eventCode ?? "";
  const triggerEvent = triggerCode ?? "";
  const sendingApp = fields[2] ?? "";
  const sendingFacility = fields[3] ?? "";
  const timestamp = fields[6] ?? "";

  const segments = segmentStrings.map((s) => ({
    name: s.substring(0, 3),
    raw: s,
  }));

  // Extract patient name from PID.5 (index 5, 1-based = field 5)
  let patientName: string | null = null;
  let patientId: string | null = null;
  const pid = segmentStrings.find((s) => s.startsWith("PID"));
  if (pid) {
    const pidFields = pid.split("|");
    // PID.3 = patient ID list (index 3), PID.5 = patient name (index 5)
    const rawId = pidFields[3];
    if (rawId) {
      patientId = rawId.split("^")[0] ?? rawId;
    }
    const rawName = pidFields[5];
    if (rawName) {
      const parts = rawName.split("^");
      const last = parts[0] ?? "";
      const first = parts[1] ?? "";
      patientName = [first, last].filter(Boolean).join(" ") || rawName;
    }
  }

  return {
    messageType,
    triggerEvent,
    sendingApp,
    sendingFacility,
    timestamp,
    segments,
    patientName,
    patientId,
  };
}

function isFhirJson(raw: string): boolean {
  try {
    const obj = JSON.parse(raw);
    return typeof obj === "object" && obj !== null && "resourceType" in obj;
  } catch {
    return false;
  }
}

function detectStandard(message: string, hint?: string): "hl7" | "fhir" | "unknown" {
  if (hint === "hl7") return "hl7";
  if (hint === "fhir") return "fhir";
  if (isFhirJson(message)) return "fhir";
  if (message.trimStart().startsWith("MSH|")) return "hl7";
  return "unknown";
}

const inputSchema = z.object({
  message: z
    .string()
    .describe(
      "The raw message text to explain. Supports HL7 v2 pipe-delimited format and FHIR JSON."
    ),
  standard: z
    .enum(["hl7", "fhir"])
    .optional()
    .describe("Message standard. Auto-detected if not specified."),
});

export function createExplainTool(): ToolDefinition {
  return {
    name: "explain_message",
    requiredTier: "free",
    annotations: { readOnlyHint: true, openWorldHint: false },
    outputEnvelope: {
      keys: [
        { key: "standard", description: "Detected standard: 'hl7' or 'fhir'." },
        { key: "messageType", description: "HL7 only: the message type, e.g. 'ADT^A01'." },
        { key: "segments", description: "HL7 only: every segment as { index, name }, where index is the 0-based position — pass it as refine_hl7_segment.segmentIndex." },
        { key: "resourceType", description: "FHIR only: the resource type, e.g. 'Patient'." },
        { key: "id", description: "FHIR only: the resource id, when present." },
      ],
      feeds: ["refine_hl7_segment"],
    },
    description:
      "Parse an HL7 or FHIR message and explain it in plain English. " +
      "Shows the message structure (segments, fields), identifies the message type and trigger event, " +
      "and summarizes the clinical meaning. " +
      "Useful for onboarding, debugging, or understanding unfamiliar message formats.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);
      const standard = detectStandard(parsed.message, parsed.standard);

      // Machine envelope, populated only on a successful parse. HL7 carries the
      // 0-based segment index list (refine_hl7_segment.segmentIndex); FHIR carries
      // the resource identity. Left null for the unparseable/unknown paths so we
      // never dress a non-result as a chainable success (H-12/H-16).
      let envelope: Record<string, unknown> | null = null;

      // Run validation in compatibility mode to get any issues and parsed metadata
      let validationResult;
      try {
        validationResult = await transport.validate(parsed.message, { mode: "compatibility" });
      } catch {
        validationResult = null;
      }

      const lines: string[] = [];

      if (standard === "hl7") {
        const hl7 = parseHL7(parsed.message);

        if (!hl7) {
          lines.push("Could not parse message as HL7 v2. Ensure it starts with 'MSH|'.");
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        const eventName = TRIGGER_EVENT_NAMES[hl7.messageType] ?? "Unknown event";
        lines.push(`**Message Type**: ${hl7.messageType} — ${eventName}`);
        lines.push(`**Standard**: HL7 v2.x`);

        if (hl7.sendingApp || hl7.sendingFacility) {
          const sender = [hl7.sendingApp, hl7.sendingFacility].filter(Boolean).join(" / ");
          lines.push(`**Sender**: ${sender}`);
        }

        if (hl7.timestamp) {
          lines.push(`**Timestamp**: ${hl7.timestamp}`);
        }

        const uniqueSegmentNames = [...new Set(hl7.segments.map((s) => s.name))];
        lines.push(`**Segments present**: ${uniqueSegmentNames.join(", ")}`);

        if (hl7.patientName || hl7.patientId) {
          const patientParts: string[] = [];
          if (hl7.patientName) patientParts.push(hl7.patientName);
          if (hl7.patientId) patientParts.push(`MRN: ${hl7.patientId}`);
          lines.push(`**Patient**: ${patientParts.join(", ")}`);
        }

        lines.push("");
        lines.push("**Clinical Summary**:");
        const summaryParts: string[] = [`This is a${/^[aeiou]/i.test(eventName) ? "n" : ""} ${eventName.toLowerCase()} message`];
        if (hl7.patientName) summaryParts.push(`for patient ${hl7.patientName}`);
        if (hl7.sendingFacility) summaryParts.push(`originating from ${hl7.sendingFacility}`);
        lines.push(summaryParts.join(" ") + ".");

        lines.push("");
        lines.push("**Segment Breakdown** (index is the 0-based segment position — pass it to refine_hl7_segment):");
        lines.push("");

        // Number EVERY segment with its 0-based line index (not deduped): that
        // index is exactly what refine_hl7_segment.segmentIndex expects, so an
        // agent reads the target index here instead of counting CRs by hand.
        hl7.segments.forEach((seg, index) => {
          const desc = SEGMENT_DESCRIPTIONS[seg.name];
          const label = desc ? `${seg.name} — ${desc}` : `${seg.name} — custom/unknown segment`;
          lines.push(`  [${index}] ${label}`);
        });

        envelope = {
          standard: "hl7",
          messageType: hl7.messageType,
          segments: hl7.segments.map((seg, index) => ({ index, name: seg.name })),
        };

        if (
          validationResult &&
          (validationResult.errors.length > 0 || validationResult.warnings.length > 0)
        ) {
          lines.push("");
          const issueCount = validationResult.errors.length + validationResult.warnings.length;
          lines.push(
            `Note: Message has ${issueCount} validation issue${issueCount !== 1 ? "s" : ""} ` +
              `(${validationResult.errors.length} error${validationResult.errors.length !== 1 ? "s" : ""}, ` +
              `${validationResult.warnings.length} warning${validationResult.warnings.length !== 1 ? "s" : ""}). ` +
              `Use validate_message for details.`
          );
        }
      } else if (standard === "fhir") {
        let fhirObj: Record<string, unknown>;
        try {
          fhirObj = JSON.parse(parsed.message);
        } catch {
          lines.push("Could not parse message as FHIR JSON. Ensure the message is valid JSON.");
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        const resourceType = String(fhirObj["resourceType"] ?? "Unknown");
        const id = fhirObj["id"] ? String(fhirObj["id"]) : null;
        const status = fhirObj["status"] ? String(fhirObj["status"]) : null;

        lines.push(`**Resource Type**: ${resourceType}`);
        lines.push(`**Standard**: FHIR R4`);
        if (id) lines.push(`**Resource ID**: ${id}`);
        if (status) lines.push(`**Status**: ${status}`);

        envelope = { standard: "fhir", resourceType, ...(id ? { id } : {}) };

        // For Bundle, list entry resource types
        if (resourceType === "Bundle") {
          const bundleType = fhirObj["type"] ? String(fhirObj["type"]) : "unknown";
          lines.push(`**Bundle Type**: ${bundleType}`);
          const entries = fhirObj["entry"];
          if (Array.isArray(entries)) {
            const entryTypes = entries
              .map((e: unknown) => {
                if (typeof e === "object" && e !== null) {
                  const resource = (e as Record<string, unknown>)["resource"];
                  if (typeof resource === "object" && resource !== null) {
                    return String((resource as Record<string, unknown>)["resourceType"] ?? "Unknown");
                  }
                }
                return "Unknown";
              })
              .filter(Boolean);
            lines.push(`**Entries (${entryTypes.length})**: ${entryTypes.join(", ")}`);
          }
        }

        lines.push("");
        lines.push("**Clinical Summary**:");
        lines.push(
          `This is a FHIR R4 ${resourceType} resource${id ? ` with ID ${id}` : ""}${status ? ` in ${status} status` : ""}.`
        );

        // Top-level keys give a rough field inventory
        const topLevelKeys = Object.keys(fhirObj).filter((k) => k !== "resourceType" && k !== "id");
        if (topLevelKeys.length > 0) {
          lines.push("");
          lines.push("**Fields present**:");
          lines.push(`  ${topLevelKeys.join(", ")}`);
        }

        if (
          validationResult &&
          (validationResult.errors.length > 0 || validationResult.warnings.length > 0)
        ) {
          lines.push("");
          const issueCount = validationResult.errors.length + validationResult.warnings.length;
          lines.push(
            `Note: Resource has ${issueCount} validation issue${issueCount !== 1 ? "s" : ""} ` +
              `(${validationResult.errors.length} error${validationResult.errors.length !== 1 ? "s" : ""}, ` +
              `${validationResult.warnings.length} warning${validationResult.warnings.length !== 1 ? "s" : ""}). ` +
              `Use validate_message for details.`
          );
        }
      } else {
        lines.push(
          "Could not detect message standard. " +
            "HL7 messages start with 'MSH|'; FHIR messages are JSON objects with a 'resourceType' field."
        );
      }

      const text = lines.join("\n").trimEnd();
      // Emit the machine envelope only when the parse produced a chainable result
      // (H-16); the unparseable/unknown paths return plain guidance text.
      return envelope
        ? withSuccessEnvelope(text, envelope)
        : { content: [{ type: "text", text }] };
    },
  };
}
