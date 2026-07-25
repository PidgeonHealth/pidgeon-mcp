// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Reference-lookup result shapes for the Bridge oracle path (get_segment_spec's
// field lookup + lookup_code's ICD-10 lookup). Kept out of types.ts to hold that
// file under its LOC budget; re-exported through the transport barrel.

/** A single HL7 field's schema, version-resolved by the Bridge oracle (GET /api/lookup/field). */
export interface FieldSpecResult {
  segment: string;
  position: number;
  name: string;
  dataType: string;
  optionality: string;
  maxLength?: number;
  repeatability?: string;
  tableReference?: string;
  description?: string;
  /** The HL7 version the Bridge resolved the field against (echoes the request). */
  version: string;
}

/** One ICD-10-CM match from the Bridge lookup (GET /api/lookup/icd10). */
export interface Icd10Match {
  code: string;
  description: string;
  category?: string;
}
