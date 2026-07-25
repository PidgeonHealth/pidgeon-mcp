// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Advisory clinical-sense review types (Semantic Validation L5). The on-device
// LLM judge reviews a structurally-valid message for clinical implausibility — a
// 10x dose, a sex-conflicting procedure, a note that contradicts the coded
// result — none of which spec validation can see. Advisory-forever: a finding
// can never change a message's validity, block a pipeline, or remediate.
//
// Carved into its own transport module (mirroring bridge-session.ts) so the
// shared types.ts catalog stays under its structural budget as the transport
// gains surfaces.

export interface SemanticReviewOptions {
  // Caller attestation that the content carries no PHI. Only this lets a
  // non-local provider see the content; false keeps real content on-device.
  contentIsSynthetic?: boolean;
  // Optional subset of check-family names to run; omit to run them all.
  families?: string[];
  // Optional wall-clock budget for the review, in milliseconds.
  maxLatencyMs?: number;
}

export interface SemanticFinding {
  faultClass: string;        // canonical id, e.g. "SEM-F01"
  title: string;             // short fault-class title, e.g. "10x/0.1x dose"
  finding: string;           // what looks clinically wrong and why
  confidence: number;        // detector confidence in [0, 1]
  evidenceFields: string[];  // message locations the finding is grounded in
  source: string;            // detector tier — "Rule" or "Judge"
  severity: string;          // always "Advisory" — the type-enforced ceiling
}

export interface SemanticReviewResult {
  findings: SemanticFinding[];
  ranFamilies: string[];
  skippedFamilies: string[];
  wasTruncated: boolean;
}
