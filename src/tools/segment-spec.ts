// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { FieldSpecResult } from "../transport/index.js";

// Human-readable HL7 optionality codes as the Bridge oracle returns them.
const OPTIONALITY_LABELS: Record<string, string> = {
  R: "Required",
  O: "Optional",
  C: "Conditional",
  X: "Not supported",
  B: "Backward compatibility",
  W: "Withdrawn",
};

// ---------------------------------------------------------------------------
// Segment spec data types
// ---------------------------------------------------------------------------

interface FieldSpec {
  name: string;
  dataType: string;
  maxLength: string;
  required: "R" | "O" | "C";
}

interface SegmentSpec {
  description: string;
  fields: Record<number, FieldSpec>;
}

// ---------------------------------------------------------------------------
// Embedded segment specifications
// ---------------------------------------------------------------------------

const SEGMENT_SPECS: Record<string, SegmentSpec> = {
  MSH: {
    description: "Message Header",
    fields: {
      1:  { name: "Field Separator",          dataType: "ST",  maxLength: "1",   required: "R" },
      2:  { name: "Encoding Characters",      dataType: "ST",  maxLength: "4",   required: "R" },
      3:  { name: "Sending Application",      dataType: "HD",  maxLength: "227", required: "O" },
      4:  { name: "Sending Facility",         dataType: "HD",  maxLength: "227", required: "O" },
      5:  { name: "Receiving Application",    dataType: "HD",  maxLength: "227", required: "O" },
      6:  { name: "Receiving Facility",       dataType: "HD",  maxLength: "227", required: "O" },
      7:  { name: "Date/Time of Message",     dataType: "TS",  maxLength: "26",  required: "R" },
      8:  { name: "Security",                 dataType: "ST",  maxLength: "40",  required: "O" },
      9:  { name: "Message Type",             dataType: "MSG", maxLength: "15",  required: "R" },
      10: { name: "Message Control ID",       dataType: "ST",  maxLength: "20",  required: "R" },
      11: { name: "Processing ID",            dataType: "PT",  maxLength: "3",   required: "R" },
      12: { name: "Version ID",               dataType: "VID", maxLength: "60",  required: "R" },
    },
  },

  PID: {
    description: "Patient Identification",
    fields: {
      1:  { name: "Set ID - PID",                   dataType: "SI",  maxLength: "4",   required: "O" },
      2:  { name: "Patient ID",                     dataType: "CX",  maxLength: "20",  required: "O" },
      3:  { name: "Patient Identifier List",        dataType: "CX",  maxLength: "250", required: "R" },
      4:  { name: "Alternate Patient ID",           dataType: "CX",  maxLength: "20",  required: "O" },
      5:  { name: "Patient Name",                   dataType: "XPN", maxLength: "250", required: "R" },
      6:  { name: "Mother's Maiden Name",           dataType: "XPN", maxLength: "250", required: "O" },
      7:  { name: "Date/Time of Birth",             dataType: "TS",  maxLength: "26",  required: "O" },
      8:  { name: "Administrative Sex",             dataType: "IS",  maxLength: "1",   required: "O" },
      9:  { name: "Patient Alias",                  dataType: "XPN", maxLength: "250", required: "O" },
      10: { name: "Race",                           dataType: "CE",  maxLength: "250", required: "O" },
      11: { name: "Patient Address",                dataType: "XAD", maxLength: "250", required: "O" },
      12: { name: "County Code",                    dataType: "IS",  maxLength: "4",   required: "O" },
      13: { name: "Phone Number - Home",            dataType: "XTN", maxLength: "250", required: "O" },
      14: { name: "Phone Number - Business",        dataType: "XTN", maxLength: "250", required: "O" },
      15: { name: "Primary Language",               dataType: "CE",  maxLength: "250", required: "O" },
      16: { name: "Marital Status",                 dataType: "CE",  maxLength: "250", required: "O" },
      17: { name: "Religion",                       dataType: "CE",  maxLength: "250", required: "O" },
      18: { name: "Patient Account Number",         dataType: "CX",  maxLength: "250", required: "O" },
      19: { name: "SSN Number - Patient",           dataType: "ST",  maxLength: "16",  required: "O" },
      20: { name: "Driver's License Number",        dataType: "DLN", maxLength: "25",  required: "O" },
      21: { name: "Mother's Identifier",            dataType: "CX",  maxLength: "250", required: "O" },
      22: { name: "Ethnic Group",                   dataType: "CE",  maxLength: "250", required: "O" },
      23: { name: "Birth Place",                    dataType: "ST",  maxLength: "250", required: "O" },
      24: { name: "Multiple Birth Indicator",       dataType: "ID",  maxLength: "1",   required: "O" },
      25: { name: "Birth Order",                    dataType: "NM",  maxLength: "2",   required: "O" },
      26: { name: "Citizenship",                    dataType: "CE",  maxLength: "250", required: "O" },
      29: { name: "Patient Death Date and Time",    dataType: "TS",  maxLength: "26",  required: "O" },
      30: { name: "Patient Death Indicator",        dataType: "ID",  maxLength: "1",   required: "O" },
    },
  },

  PV1: {
    description: "Patient Visit",
    fields: {
      1:  { name: "Set ID - PV1",            dataType: "SI",  maxLength: "4",   required: "O" },
      2:  { name: "Patient Class",           dataType: "IS",  maxLength: "1",   required: "R" },
      3:  { name: "Assigned Patient Location", dataType: "PL", maxLength: "80",  required: "O" },
      4:  { name: "Admission Type",          dataType: "IS",  maxLength: "2",   required: "O" },
      5:  { name: "Preadmit Number",         dataType: "CX",  maxLength: "250", required: "O" },
      6:  { name: "Prior Patient Location",  dataType: "PL",  maxLength: "80",  required: "O" },
      7:  { name: "Attending Doctor",        dataType: "XCN", maxLength: "250", required: "O" },
      8:  { name: "Referring Doctor",        dataType: "XCN", maxLength: "250", required: "O" },
      9:  { name: "Consulting Doctor",       dataType: "XCN", maxLength: "250", required: "O" },
      10: { name: "Hospital Service",        dataType: "IS",  maxLength: "3",   required: "O" },
      17: { name: "Admitting Doctor",        dataType: "XCN", maxLength: "250", required: "O" },
      18: { name: "Patient Type",            dataType: "IS",  maxLength: "2",   required: "O" },
      19: { name: "Visit Number",            dataType: "CX",  maxLength: "250", required: "O" },
      44: { name: "Admit Date/Time",         dataType: "TS",  maxLength: "26",  required: "O" },
      45: { name: "Discharge Date/Time",     dataType: "TS",  maxLength: "26",  required: "O" },
    },
  },

  OBX: {
    description: "Observation/Result",
    fields: {
      1:  { name: "Set ID - OBX",              dataType: "SI",     maxLength: "4",     required: "O" },
      2:  { name: "Value Type",                dataType: "ID",     maxLength: "2",     required: "C" },
      3:  { name: "Observation Identifier",    dataType: "CE",     maxLength: "250",   required: "R" },
      4:  { name: "Observation Sub-ID",        dataType: "ST",     maxLength: "20",    required: "C" },
      5:  { name: "Observation Value",         dataType: "varies", maxLength: "65536", required: "C" },
      6:  { name: "Units",                     dataType: "CE",     maxLength: "250",   required: "O" },
      7:  { name: "References Range",          dataType: "ST",     maxLength: "60",    required: "O" },
      8:  { name: "Abnormal Flags",            dataType: "IS",     maxLength: "5",     required: "O" },
      11: { name: "Observation Result Status", dataType: "ID",     maxLength: "1",     required: "R" },
      14: { name: "Date/Time of the Observation", dataType: "TS",  maxLength: "26",    required: "O" },
      15: { name: "Producer's ID",             dataType: "CE",     maxLength: "250",   required: "O" },
      16: { name: "Responsible Observer",      dataType: "XCN",    maxLength: "250",   required: "O" },
    },
  },

  OBR: {
    description: "Observation Request",
    fields: {
      1:  { name: "Set ID - OBR",                          dataType: "SI",  maxLength: "4",   required: "O" },
      2:  { name: "Placer Order Number",                   dataType: "EI",  maxLength: "427", required: "C" },
      3:  { name: "Filler Order Number",                   dataType: "EI",  maxLength: "427", required: "C" },
      4:  { name: "Universal Service Identifier",          dataType: "CE",  maxLength: "250", required: "R" },
      7:  { name: "Observation Date/Time",                 dataType: "TS",  maxLength: "26",  required: "C" },
      14: { name: "Specimen Received Date/Time",           dataType: "TS",  maxLength: "26",  required: "O" },
      16: { name: "Ordering Provider",                     dataType: "XCN", maxLength: "250", required: "O" },
      22: { name: "Results Rpt/Status Chng - Date/Time",   dataType: "TS",  maxLength: "26",  required: "C" },
      25: { name: "Result Status",                         dataType: "ID",  maxLength: "1",   required: "C" },
    },
  },

  ORC: {
    description: "Common Order",
    fields: {
      1:  { name: "Order Control",              dataType: "ID",  maxLength: "2",   required: "R" },
      2:  { name: "Placer Order Number",        dataType: "EI",  maxLength: "427", required: "C" },
      3:  { name: "Filler Order Number",        dataType: "EI",  maxLength: "427", required: "C" },
      5:  { name: "Order Status",               dataType: "ID",  maxLength: "2",   required: "O" },
      7:  { name: "Quantity/Timing",            dataType: "TQ",  maxLength: "200", required: "O" },
      9:  { name: "Date/Time of Transaction",   dataType: "TS",  maxLength: "26",  required: "O" },
      10: { name: "Entered By",                 dataType: "XCN", maxLength: "250", required: "O" },
      12: { name: "Ordering Provider",          dataType: "XCN", maxLength: "250", required: "O" },
      13: { name: "Enterer's Location",         dataType: "PL",  maxLength: "80",  required: "O" },
      14: { name: "Call Back Phone Number",     dataType: "XTN", maxLength: "250", required: "O" },
    },
  },

  RXE: {
    description: "Pharmacy Encoded Order",
    fields: {
      1:  { name: "Quantity/Timing",                                         dataType: "TQ",  maxLength: "200", required: "O" },
      2:  { name: "Give Code",                                               dataType: "CE",  maxLength: "250", required: "R" },
      3:  { name: "Give Amount - Minimum",                                   dataType: "NM",  maxLength: "20",  required: "R" },
      4:  { name: "Give Amount - Maximum",                                   dataType: "NM",  maxLength: "20",  required: "O" },
      5:  { name: "Give Units",                                              dataType: "CE",  maxLength: "250", required: "R" },
      6:  { name: "Give Dosage Form",                                        dataType: "CE",  maxLength: "250", required: "O" },
      7:  { name: "Provider's Administration Instructions",                  dataType: "CE",  maxLength: "250", required: "O" },
      10: { name: "Dispense Amount",                                         dataType: "NM",  maxLength: "20",  required: "O" },
      11: { name: "Dispense Units",                                          dataType: "CE",  maxLength: "250", required: "O" },
      12: { name: "Number Of Refills",                                       dataType: "NM",  maxLength: "3",   required: "O" },
      14: { name: "Pharmacist/Treatment Supplier's Verifier ID",             dataType: "XCN", maxLength: "250", required: "O" },
    },
  },

  DG1: {
    description: "Diagnosis",
    fields: {
      1:  { name: "Set ID - DG1",        dataType: "SI", maxLength: "4",   required: "R" },
      2:  { name: "Diagnosis Coding Method", dataType: "ID", maxLength: "2", required: "O" },
      3:  { name: "Diagnosis Code - DG1", dataType: "CE", maxLength: "250", required: "O" },
      4:  { name: "Diagnosis Description", dataType: "ST", maxLength: "40", required: "O" },
      5:  { name: "Diagnosis Date/Time",  dataType: "TS", maxLength: "26",  required: "O" },
      6:  { name: "Diagnosis Type",       dataType: "IS", maxLength: "2",   required: "R" },
      15: { name: "Diagnosis Priority",   dataType: "ID", maxLength: "2",   required: "O" },
    },
  },

  EVN: {
    description: "Event Type",
    fields: {
      1: { name: "Event Type Code",         dataType: "ID",  maxLength: "3",   required: "O" },
      2: { name: "Recorded Date/Time",      dataType: "TS",  maxLength: "26",  required: "R" },
      3: { name: "Date/Time Planned Event", dataType: "TS",  maxLength: "26",  required: "O" },
      4: { name: "Event Reason Code",       dataType: "IS",  maxLength: "3",   required: "O" },
      5: { name: "Operator ID",             dataType: "XCN", maxLength: "250", required: "O" },
    },
  },

  NK1: {
    description: "Next of Kin",
    fields: {
      1: { name: "Set ID - NK1",       dataType: "SI",  maxLength: "4",   required: "R" },
      2: { name: "Name",               dataType: "XPN", maxLength: "250", required: "O" },
      3: { name: "Relationship",       dataType: "CE",  maxLength: "250", required: "O" },
      4: { name: "Address",            dataType: "XAD", maxLength: "250", required: "O" },
      5: { name: "Phone Number",       dataType: "XTN", maxLength: "250", required: "O" },
      6: { name: "Business Phone Number", dataType: "XTN", maxLength: "250", required: "O" },
      7: { name: "Contact Role",       dataType: "CE",  maxLength: "250", required: "O" },
    },
  },
};

// Human-readable required flag labels
const REQUIRED_LABELS: Record<string, string> = {
  R: "Required",
  O: "Optional",
  C: "Conditional",
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function padRight(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function formatFullSegment(segmentName: string, spec: SegmentSpec): string {
  const fieldNumbers = Object.keys(spec.fields)
    .map(Number)
    .sort((a, b) => a - b);

  // The embedded table is a single version-agnostic baseline. Version-resolved,
  // all-segment detail comes from the Bridge oracle (per-field, see below).
  const header =
    `**${segmentName}** — ${spec.description}\n` +
    `Source: embedded structural summary (version-agnostic). ` +
    `Start Pidgeon Bridge for version-resolved specs, or pass field=<n> for one field's version-resolved detail.\n`;
  const divider = "─".repeat(65);

  const colHeaders = `| ${"#".padEnd(3)} | ${"Field Name".padEnd(44)} | ${"Type".padEnd(6)} | ${"Len".padEnd(6)} | Req |`;
  const colSep     = `| ${"-".repeat(3)} | ${"-".repeat(44)} | ${"-".repeat(6)} | ${"-".repeat(6)} | --- |`;

  const rows = fieldNumbers.map((num) => {
    const f = spec.fields[num];
    const numStr = String(num).padEnd(3);
    const nameStr = padRight(f.name, 44);
    const typeStr = padRight(f.dataType, 6);
    const lenStr  = padRight(f.maxLength, 6);
    return `| ${numStr} | ${nameStr} | ${typeStr} | ${lenStr} | ${f.required}   |`;
  });

  return [header, divider, colHeaders, colSep, ...rows].join("\n");
}

function formatSingleField(
  segmentName: string,
  fieldNum: number,
  spec: SegmentSpec
): string {
  const field = spec.fields[fieldNum];
  if (!field) {
    const available = Object.keys(spec.fields).map(Number).sort((a, b) => a - b).join(", ");
    return (
      `Field ${fieldNum} is not defined for ${segmentName} in the embedded spec.\n` +
      `Available fields: ${available}`
    );
  }

  return [
    `**${segmentName}-${fieldNum}** — ${field.name}`,
    `Source:    embedded summary (version-agnostic; start Pidgeon Bridge for a version-resolved spec)`,
    `Data Type: ${field.dataType}`,
    `Max Len:   ${field.maxLength}`,
    `Required:  ${field.required} (${REQUIRED_LABELS[field.required] ?? field.required})`,
  ].join("\n");
}

// Renders the version-resolved field the Bridge oracle returned. Unlike the
// embedded summary, this reflects the exact HL7 version requested.
function formatBridgeField(f: FieldSpecResult): string {
  const lines = [
    `**${f.segment}-${f.position}** — ${f.name}`,
    `Source:    Bridge oracle (HL7 v${f.version})`,
    `Data Type: ${f.dataType}`,
  ];
  if (f.maxLength !== undefined) lines.push(`Max Len:   ${f.maxLength}`);
  const opt = OPTIONALITY_LABELS[f.optionality] ?? f.optionality;
  lines.push(`Required:  ${f.optionality}${opt ? ` (${opt})` : ""}`);
  if (f.repeatability) lines.push(`Repeats:   ${f.repeatability}`);
  if (f.tableReference) lines.push(`Table:     ${f.tableReference}`);
  if (f.description) lines.push(`Notes:     ${f.description}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  segment: z
    .string()
    .describe(
      "Segment name (e.g., 'PID', 'OBX', 'MSH', 'RXE'). Case-insensitive."
    ),
  field: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Specific field number to look up (e.g., 5 for PID-5 patient name). Returns just that field's details."
    ),
  hl7Version: z
    .string()
    .optional()
    .default("2.5.1")
    .describe(
      "HL7 version: '2.3', '2.3.1', '2.4', '2.5', '2.5.1', '2.6', '2.7', '2.7.1', '2.8'."
    ),
});

export function createSegmentSpecTool(): ToolDefinition {
  return {
    name: "get_segment_spec",
    requiredTier: "free",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Get the HL7 v2 specification for a segment, showing fields with their names, data types, " +
      "lengths, and required/optional status. Use this to understand what a segment contains, find the " +
      "right field index for a value, or verify that a message is correctly structured. " +
      "A single field (pass field=<n>) is resolved for the exact hl7Version from the Bridge oracle when " +
      "the Bridge is running; otherwise an embedded summary of common segments is returned. " +
      "Describes a segment's fields — to decode a code value (LOINC/ICD-10/CVX) use lookup_code instead, not this.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);
      const segName = parsed.segment.toUpperCase().trim();
      const version = parsed.hl7Version ?? "2.5.1";

      // Single field: prefer the Bridge oracle — it's version-resolved and covers
      // every segment, not just the embedded subset. Fall back to the embedded
      // table when the Bridge is unavailable (CLI mode / not running).
      if (parsed.field !== undefined) {
        try {
          const spec = await transport.getFieldSpec(segName, parsed.field, version);
          return { content: [{ type: "text", text: formatBridgeField(spec) }] };
        } catch {
          // fall through to the embedded table
        }
      }

      const spec = SEGMENT_SPECS[segName];
      if (!spec) {
        const embedded = Object.keys(SEGMENT_SPECS).sort().join(", ");
        const text =
          `Segment '${segName}' is not in this MCP server's embedded summary.\n\n` +
          `Start Pidgeon Bridge and use the pidgeon://hl7/segments/${segName} resource, or the ` +
          `Bridge oracle (pass field=<n> for a version-resolved field), for the full spec.\n\n` +
          `Embedded segments: ${embedded}`;
        return { content: [{ type: "text", text }] };
      }

      const text =
        parsed.field !== undefined
          ? formatSingleField(segName, parsed.field, spec)
          : formatFullSegment(segName, spec);

      return { content: [{ type: "text", text }] };
    },
  };
}
