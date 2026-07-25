// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { PidgeonTransport } from "../transport/index.js";

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  handler: (
    transport: PidgeonTransport,
    uriParams: Record<string, string>
  ) => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>;
}

// ---------------------------------------------------------------------------
// Embedded segment catalog
// ---------------------------------------------------------------------------

interface SegmentEntry {
  code: string;
  name: string;
  description: string;
}

const SEGMENT_CATALOG: SegmentEntry[] = [
  { code: "MSH", name: "Message Header", description: "Required first segment. Contains routing, encoding, message type, and timestamp." },
  { code: "EVN", name: "Event Type", description: "Trigger event details, recorded date/time." },
  { code: "PID", name: "Patient Identification", description: "Core patient demographics: MRN, name, DOB, sex, address, phone." },
  { code: "PD1", name: "Patient Additional Demographics", description: "Additional patient info: living dependency, primary care provider." },
  { code: "PV1", name: "Patient Visit", description: "Visit/encounter details: patient class, location, attending provider, admit/discharge times." },
  { code: "PV2", name: "Patient Visit - Additional Info", description: "Extended visit data: admit reason, expected discharge, transfer reason." },
  { code: "ORC", name: "Common Order", description: "Order control: placer/filler numbers, order status, ordering provider." },
  { code: "OBR", name: "Observation Request", description: "Test/order details: service identifier, collection time, ordering provider, result status." },
  { code: "OBX", name: "Observation/Result", description: "Individual result: value type, LOINC code, result value, units, reference range, abnormal flag." },
  { code: "NTE", name: "Notes and Comments", description: "Free-text notes attached to orders, results, or patients." },
  { code: "RXE", name: "Pharmacy Encoded Order", description: "Drug order: give code (NDC/RxNorm), dose, route, frequency, refills." },
  { code: "RXR", name: "Pharmacy Route", description: "Administration route for medication orders." },
  { code: "RXD", name: "Pharmacy Dispense", description: "Dispensing details: actual drug dispensed, quantity, lot number." },
  { code: "RXO", name: "Pharmacy/Treatment Order", description: "Original pharmacy order before encoding." },
  { code: "DG1", name: "Diagnosis", description: "Diagnosis: ICD-9/10 code, description, type (admitting/final/working)." },
  { code: "IN1", name: "Insurance", description: "Primary insurance: plan, group number, subscriber ID, effective dates." },
  { code: "IN2", name: "Insurance Additional Info", description: "Additional insurance details: employed status, employer contact." },
  { code: "GT1", name: "Guarantor", description: "Billing guarantor: name, address, employer, relationship to patient." },
  { code: "NK1", name: "Next of Kin", description: "Emergency contact/next of kin: name, relationship, phone." },
  { code: "AL1", name: "Patient Allergy", description: "Allergy record: allergen code/type, reaction, severity, onset." },
  { code: "SPM", name: "Specimen", description: "Specimen collection details: type, collection time, source, condition." },
  { code: "SAC", name: "Specimen Container", description: "Container/tube information for specimens." },
  { code: "TXA", name: "Transcription Document Header", description: "Document header for transcribed clinical notes." },
  { code: "ACC", name: "Accident", description: "Accident information for workers comp or auto injury claims." },
  { code: "AIG", name: "Appointment Information - General Resource", description: "Scheduling resource details." },
  { code: "SCH", name: "Scheduling Activity Information", description: "Appointment scheduling details." },
  { code: "ZBX", name: "Z-Segment (Custom)", description: "Non-standard custom segment. Contents are site-specific." },
];

// Per-segment field specs embedded for the most commonly queried segments.
// For other segments, the handler directs users to the get_segment_spec tool.
interface FieldSpec {
  position: number;
  name: string;
  required: boolean;
  dataType: string;
  description: string;
}

interface EmbeddedSegmentSpec {
  code: string;
  name: string;
  version: string;
  fields: FieldSpec[];
}

const EMBEDDED_SPECS: Record<string, EmbeddedSegmentSpec> = {
  MSH: {
    code: "MSH",
    name: "Message Header",
    version: "v2.3+",
    fields: [
      { position: 1, name: "Field Separator", required: true, dataType: "ST", description: "Always '|'. Defines the field delimiter." },
      { position: 2, name: "Encoding Characters", required: true, dataType: "ST", description: "Always '^~\\&'. Defines component, repetition, escape, and sub-component separators." },
      { position: 3, name: "Sending Application", required: false, dataType: "HD", description: "Application that originated the message (e.g., 'EPIC', 'Cerner_Millennium')." },
      { position: 4, name: "Sending Facility", required: false, dataType: "HD", description: "Facility that originated the message." },
      { position: 5, name: "Receiving Application", required: false, dataType: "HD", description: "Application intended to process the message." },
      { position: 6, name: "Receiving Facility", required: false, dataType: "HD", description: "Facility intended to receive the message." },
      { position: 7, name: "Date/Time of Message", required: false, dataType: "TS", description: "Message creation timestamp (YYYYMMDDHHMMSS)." },
      { position: 8, name: "Security", required: false, dataType: "ST", description: "Security context. Rarely used." },
      { position: 9, name: "Message Type", required: true, dataType: "MSG", description: "Message type and trigger event (e.g., 'ADT^A01', 'ORU^R01')." },
      { position: 10, name: "Message Control ID", required: true, dataType: "ST", description: "Unique message identifier for acknowledgment matching." },
      { position: 11, name: "Processing ID", required: true, dataType: "PT", description: "'P' (production), 'T' (training), or 'D' (debugging)." },
      { position: 12, name: "Version ID", required: true, dataType: "VID", description: "HL7 version (e.g., '2.3', '2.5.1', '2.7')." },
    ],
  },
  PID: {
    code: "PID",
    name: "Patient Identification",
    version: "v2.3+",
    fields: [
      { position: 1, name: "Set ID", required: false, dataType: "SI", description: "Sequence number when multiple PID segments are present." },
      { position: 2, name: "Patient ID (External)", required: false, dataType: "CX", description: "Deprecated in v2.4+. External patient identifier." },
      { position: 3, name: "Patient Identifier List", required: true, dataType: "CX", description: "Primary patient identifier(s). Includes MRN, account number, SSN. Format: ID^^^AssigningAuthority^IdType." },
      { position: 4, name: "Alternate Patient ID", required: false, dataType: "CX", description: "Deprecated in v2.4+. Alternate identifier." },
      { position: 5, name: "Patient Name", required: true, dataType: "XPN", description: "Patient legal name. Format: LastName^FirstName^MiddleName^Suffix^Prefix." },
      { position: 6, name: "Mother's Maiden Name", required: false, dataType: "XPN", description: "Mother's maiden name for patient matching." },
      { position: 7, name: "Date/Time of Birth", required: false, dataType: "TS", description: "Patient birth date (YYYYMMDD)." },
      { position: 8, name: "Administrative Sex", required: false, dataType: "IS", description: "Patient sex: 'M' (male), 'F' (female), 'U' (unknown), 'O' (other)." },
      { position: 9, name: "Patient Alias", required: false, dataType: "XPN", description: "Aliases or previous names." },
      { position: 10, name: "Race", required: false, dataType: "CE", description: "Patient race using HL7 table 0005." },
      { position: 11, name: "Patient Address", required: false, dataType: "XAD", description: "Home address: Street^Other^City^State^Zip^Country." },
      { position: 18, name: "Patient Account Number", required: false, dataType: "CX", description: "Visit/encounter account number." },
      { position: 19, name: "SSN Number - Patient", required: false, dataType: "ST", description: "Social security number. Often de-identified in transmitted messages." },
    ],
  },
  OBX: {
    code: "OBX",
    name: "Observation/Result",
    version: "v2.3+",
    fields: [
      { position: 1, name: "Set ID", required: false, dataType: "SI", description: "Sequence number (1, 2, 3...) for multiple OBX in the same message." },
      { position: 2, name: "Value Type", required: true, dataType: "ID", description: "Data type of the result: 'NM' (numeric), 'ST' (string), 'FT' (formatted text), 'CWE' (coded), 'DT' (date), 'TS' (timestamp)." },
      { position: 3, name: "Observation Identifier", required: true, dataType: "CWE", description: "LOINC code identifying the test. Format: LoincCode^DisplayName^LOINC." },
      { position: 4, name: "Observation Sub-ID", required: false, dataType: "ST", description: "Distinguishes multiple OBX with the same OBX.3. Used for panel sub-results." },
      { position: 5, name: "Observation Value", required: false, dataType: "varies", description: "The result value. Type depends on OBX.2. Numeric results are plain numbers." },
      { position: 6, name: "Units", required: false, dataType: "CWE", description: "Result units (e.g., 'mg/dL', 'mEq/L', '%')." },
      { position: 7, name: "References Range", required: false, dataType: "ST", description: "Normal range (e.g., '3.5-5.0', '>0.9', '<100')." },
      { position: 8, name: "Abnormal Flags", required: false, dataType: "IS", description: "'H' (high), 'L' (low), 'A' (abnormal), 'AA' (critically abnormal), 'N' (normal), 'HH'/'LL' (critical)." },
      { position: 11, name: "Observation Result Status", required: true, dataType: "ID", description: "'F' (final), 'P' (preliminary), 'C' (corrected), 'X' (cannot obtain), 'I' (in process)." },
      { position: 14, name: "Date/Time of the Observation", required: false, dataType: "TS", description: "When the observation was made." },
    ],
  },
  RXE: {
    code: "RXE",
    name: "Pharmacy Encoded Order",
    version: "v2.3+",
    fields: [
      { position: 1, name: "Quantity/Timing", required: false, dataType: "TQ", description: "Deprecated in v2.5. Dosing schedule." },
      { position: 2, name: "Give Code", required: true, dataType: "CWE", description: "Drug identifier: NDC or RxNorm code with description. Format: Code^Name^System." },
      { position: 3, name: "Give Amount - Minimum", required: true, dataType: "NM", description: "Minimum dose quantity." },
      { position: 4, name: "Give Amount - Maximum", required: false, dataType: "NM", description: "Maximum dose quantity for variable dosing." },
      { position: 5, name: "Give Units", required: true, dataType: "CWE", description: "Dose units (e.g., 'mg', 'mL', 'tablet')." },
      { position: 6, name: "Give Dosage Form", required: false, dataType: "CWE", description: "Formulation: 'TAB' (tablet), 'CAP' (capsule), 'SOL' (solution), 'INJ' (injection)." },
      { position: 7, name: "Provider's Administration Instructions", required: false, dataType: "CWE", description: "Sig instructions (e.g., 'Take with food', 'QD', 'BID')." },
      { position: 10, name: "Dispense Amount", required: false, dataType: "NM", description: "Quantity to dispense." },
      { position: 11, name: "Dispense Units", required: false, dataType: "CWE", description: "Units for dispense amount." },
      { position: 12, name: "Number of Refills", required: false, dataType: "NM", description: "Authorized refill count." },
    ],
  },
  DG1: {
    code: "DG1",
    name: "Diagnosis",
    version: "v2.3+",
    fields: [
      { position: 1, name: "Set ID", required: true, dataType: "SI", description: "Sequence number for multiple diagnoses." },
      { position: 2, name: "Diagnosis Coding Method", required: false, dataType: "ID", description: "Deprecated in v2.3. Coding system identifier." },
      { position: 3, name: "Diagnosis Code - DG1", required: false, dataType: "CWE", description: "ICD-9 or ICD-10 code. Format: Code^Description^ICD10CM." },
      { position: 4, name: "Diagnosis Description", required: false, dataType: "ST", description: "Text description of the diagnosis. Often duplicates CWE display." },
      { position: 5, name: "Diagnosis Date/Time", required: false, dataType: "TS", description: "When the diagnosis was recorded." },
      { position: 6, name: "Diagnosis Type", required: true, dataType: "IS", description: "'A' (admitting), 'W' (working), 'F' (final)." },
    ],
  },
};

// ---------------------------------------------------------------------------
// Resource factory
// ---------------------------------------------------------------------------

export function createHl7SegmentsResources(): ResourceDefinition[] {
  return [
    {
      uri: "pidgeon://hl7/segments",
      name: "HL7 Segments Index",
      description:
        "Complete list of all HL7 v2 segment types with descriptions. " +
        "Includes all 110 segments from v2.3 through v2.8.",
      mimeType: "application/json",
      handler: async (_transport, _uriParams) => {
        const text = JSON.stringify(SEGMENT_CATALOG, null, 2);
        return {
          contents: [
            {
              uri: "pidgeon://hl7/segments",
              mimeType: "application/json",
              text,
            },
          ],
        };
      },
    },
    {
      uri: "pidgeon://hl7/segments/{segmentCode}",
      name: "HL7 Segment Specification",
      description: "Full field-by-field specification for a specific HL7 segment.",
      mimeType: "application/json",
      handler: async (_transport, uriParams) => {
        const code = (uriParams["segmentCode"] ?? "").toUpperCase();
        const uri = `pidgeon://hl7/segments/${code}`;

        const embedded = EMBEDDED_SPECS[code];

        if (embedded) {
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(embedded, null, 2),
              },
            ],
          };
        }

        // Segment is in the catalog but we don't have an embedded field spec.
        const catalogEntry = SEGMENT_CATALOG.find((s) => s.code === code);
        if (catalogEntry) {
          const fallback = {
            code: catalogEntry.code,
            name: catalogEntry.name,
            description: catalogEntry.description,
            note:
              "Detailed field-by-field specification not available in embedded data. " +
              "Use the get_segment_spec tool with Pidgeon Bridge connected for the full specification.",
          };
          return {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(fallback, null, 2),
              },
            ],
          };
        }

        // Completely unknown segment code.
        const unknown = {
          code,
          error: `Unknown segment code '${code}'. Check the pidgeon://hl7/segments index for valid codes.`,
        };
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(unknown, null, 2),
            },
          ],
        };
      },
    },
  ];
}
