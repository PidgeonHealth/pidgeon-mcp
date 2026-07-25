// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { Icd10Match } from "../transport/index.js";

// ---------------------------------------------------------------------------
// Code system type
// ---------------------------------------------------------------------------

type CodeSystem = "loinc" | "icd10" | "icd9" | "ndc" | "cvx" | "rxnorm" | "cpt" | "snomed";

// ---------------------------------------------------------------------------
// Embedded reference data
// ---------------------------------------------------------------------------

interface LoincEntry {
  display: string;
  category: string;
}

interface Icd10Entry {
  display: string;
  chapter: string;
}

interface CvxEntry {
  display: string;
  manufacturer: string;
}

const LOINC_CODES: Record<string, LoincEntry> = {
  "2823-3": { display: "Potassium [Moles/volume] in Serum or Plasma", category: "Chemistry" },
  "2345-7": { display: "Glucose [Mass/volume] in Serum or Plasma", category: "Chemistry" },
  "718-7": { display: "Hemoglobin [Mass/volume] in Blood", category: "Hematology" },
  "4548-4": { display: "Hemoglobin A1c/Hemoglobin.total in Blood", category: "Chemistry" },
  "2160-0": { display: "Creatinine [Mass/volume] in Serum or Plasma", category: "Chemistry" },
  "6690-2": { display: "Leukocytes [#/volume] in Blood by Automated count", category: "Hematology" },
  "777-3": { display: "Platelets [#/volume] in Blood by Automated count", category: "Hematology" },
  "14749-6": { display: "Glucose [Moles/volume] in Serum or Plasma", category: "Chemistry" },
  "17861-6": { display: "Calcium [Mass/volume] in Serum or Plasma", category: "Chemistry" },
  "10702-5": { display: "Sodium [Moles/volume] in Serum or Plasma", category: "Chemistry" },
  "6298-4": { display: "Potassium [Moles/volume] in Blood", category: "Chemistry" },
  "2951-2": { display: "Sodium [Moles/volume] in Serum or Plasma", category: "Chemistry" },
  "3094-0": { display: "Urea nitrogen [Mass/volume] in Serum or Plasma", category: "Chemistry" },
  "1742-6": { display: "Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma", category: "Chemistry" },
  "1920-8": { display: "Aspartate aminotransferase [Enzymatic activity/volume] in Serum or Plasma", category: "Chemistry" },
};

const ICD10_CODES: Record<string, Icd10Entry> = {
  "E11.9": { display: "Type 2 diabetes mellitus without complications", chapter: "Endocrine" },
  "I10": { display: "Essential (primary) hypertension", chapter: "Circulatory" },
  "J44.1": { display: "Chronic obstructive pulmonary disease with acute exacerbation", chapter: "Respiratory" },
  "N18.3": { display: "Chronic kidney disease, stage 3 (moderate)", chapter: "Genitourinary" },
  "F32.9": { display: "Major depressive disorder, single episode, unspecified", chapter: "Mental" },
  "M54.5": { display: "Low back pain", chapter: "Musculoskeletal" },
  "Z87.891": { display: "Personal history of nicotine dependence", chapter: "Z-codes" },
  "K21.0": { display: "Gastro-esophageal reflux disease with esophagitis", chapter: "Digestive" },
  "E78.5": { display: "Hyperlipidemia, unspecified", chapter: "Endocrine" },
  "J06.9": { display: "Acute upper respiratory infection, unspecified", chapter: "Respiratory" },
};

const CVX_CODES: Record<string, CvxEntry> = {
  "4": { display: "M/R/mumps", manufacturer: "Various" },
  "8": { display: "Hep B, adolescent or pediatric", manufacturer: "Various" },
  "20": { display: "DTaP", manufacturer: "Various" },
  "21": { display: "Varicella", manufacturer: "Various" },
  "33": { display: "Pneumococcal polysaccharide PPV23", manufacturer: "Various" },
  "88": { display: "Influenza, unspecified formulation", manufacturer: "Various" },
  "103": { display: "Meningococcal C/Y-HIB PRP", manufacturer: "Various" },
  "136": { display: "Meningococcal MCV4P", manufacturer: "Various" },
  "140": { display: "Influenza, seasonal, injectable, preservative free", manufacturer: "Various" },
  "207": { display: "COVID-19, mRNA, LNP-S, PF, 100 mcg/0.5 mL dose", manufacturer: "Moderna" },
  "208": { display: "COVID-19, mRNA, LNP-S, PF, 30 mcg/0.3 mL dose", manufacturer: "Pfizer" },
};

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

// Honest not-found messaging: only ICD-10 has a Bridge code-lookup endpoint
// (the full ~74,719-code set). Every other system here is served ONLY from the
// small embedded sample below — there is no fuller online lookup wired for them,
// so the message must not promise a dataset that does not exist.
function notFoundMessage(code: string, system: CodeSystem): string {
  if (system === "icd10") {
    return (
      `ICD-10-CM code '${code}' not found. Start Pidgeon Bridge to search the full ` +
      `~74,719-code set via the oracle; this MCP server's offline fallback carries only common codes.`
    );
  }
  return (
    `Code '${code}' not found in this server's embedded ${system.toUpperCase()} sample ` +
    `(common codes only). Pidgeon exposes no ${system.toUpperCase()} code-lookup endpoint yet.`
  );
}

function formatIcd10Matches(query: string, matches: Icd10Match[]): string {
  const lines = [`ICD-10-CM matches for "${query}" (source: Bridge oracle):\n`];
  for (const m of matches.slice(0, 25)) {
    lines.push(`  ${m.code.padEnd(10)} ${m.description}${m.category ? ` [${m.category}]` : ""}`);
  }
  return lines.join("\n");
}

function lookupLoinc(code: string, fuzzy: boolean): string {
  if (!fuzzy) {
    const entry = LOINC_CODES[code];
    if (!entry) return notFoundMessage(code, "loinc");
    return [
      `**LOINC ${code}**`,
      `Display:  ${entry.display}`,
      `Category: ${entry.category}`,
      `System:   LOINC`,
    ].join("\n");
  }

  const term = code.toLowerCase();
  const matches = Object.entries(LOINC_CODES).filter(([, v]) =>
    v.display.toLowerCase().includes(term) || v.category.toLowerCase().includes(term)
  );
  if (matches.length === 0) return notFoundMessage(code, "loinc");
  const lines = [`LOINC codes matching "${code}":\n`];
  for (const [c, v] of matches) {
    lines.push(`  ${c.padEnd(10)} ${v.display} [${v.category}]`);
  }
  return lines.join("\n");
}

function lookupIcd10(code: string, fuzzy: boolean): string {
  const normalised = code.toUpperCase();
  if (!fuzzy) {
    const entry = ICD10_CODES[normalised];
    if (!entry) return notFoundMessage(code, "icd10");
    return [
      `**ICD-10-CM ${normalised}**`,
      `Display: ${entry.display}`,
      `Chapter: ${entry.chapter}`,
      `System:  ICD-10-CM`,
    ].join("\n");
  }

  const term = code.toLowerCase();
  const matches = Object.entries(ICD10_CODES).filter(([k, v]) =>
    k.toLowerCase().includes(term) || v.display.toLowerCase().includes(term)
  );
  if (matches.length === 0) return notFoundMessage(code, "icd10");
  const lines = [`ICD-10-CM codes matching "${code}":\n`];
  for (const [c, v] of matches) {
    lines.push(`  ${c.padEnd(10)} ${v.display} [${v.chapter}]`);
  }
  return lines.join("\n");
}

function lookupCvx(code: string, fuzzy: boolean): string {
  if (!fuzzy) {
    const entry = CVX_CODES[code];
    if (!entry) return notFoundMessage(code, "cvx");
    return [
      `**CVX ${code}**`,
      `Display:      ${entry.display}`,
      `Manufacturer: ${entry.manufacturer}`,
      `System:       CVX (CDC Vaccine Administered Codes)`,
    ].join("\n");
  }

  const term = code.toLowerCase();
  const matches = Object.entries(CVX_CODES).filter(([, v]) =>
    v.display.toLowerCase().includes(term)
  );
  if (matches.length === 0) return notFoundMessage(code, "cvx");
  const lines = [`CVX codes matching "${code}":\n`];
  for (const [c, v] of matches) {
    lines.push(`  ${c.padEnd(6)} ${v.display} [${v.manufacturer}]`);
  }
  return lines.join("\n");
}

function lookupUnsupported(code: string, system: CodeSystem): string {
  return notFoundMessage(code, system);
}

function performLookup(code: string, system: CodeSystem, fuzzy: boolean): string {
  switch (system) {
    case "loinc":  return lookupLoinc(code, fuzzy);
    case "icd10":  return lookupIcd10(code, fuzzy);
    case "cvx":    return lookupCvx(code, fuzzy);
    case "icd9":   return lookupUnsupported(code, "icd9");
    case "ndc":    return lookupUnsupported(code, "ndc");
    case "rxnorm": return lookupUnsupported(code, "rxnorm");
    case "cpt":    return lookupUnsupported(code, "cpt");
    case "snomed": return lookupUnsupported(code, "snomed");
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  code: z
    .string()
    .describe(
      "The code to look up. Examples: '2823-3' (LOINC potassium), 'E11.9' (ICD-10 diabetes), " +
        "'0069-0105-66' (NDC aspirin), '4' (CVX influenza)."
    ),
  codeSystem: z
    .enum(["loinc", "icd10", "icd9", "ndc", "cvx", "rxnorm", "cpt", "snomed"])
    .describe("The code system to search."),
  fuzzySearch: z
    .boolean()
    .optional()
    .describe("If true, perform a description-based search instead of exact code match."),
});

export function createLookupTool(): ToolDefinition {
  return {
    name: "lookup_code",
    requiredTier: "free",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Look up a healthcare reference code to get its display name and description. " +
      "ICD-10-CM diagnoses resolve against the full code set via the Bridge oracle when the Bridge is " +
      "running (exact or description search); otherwise, and for LOINC (lab tests) and CVX (vaccines), " +
      "results come from a small embedded sample of common codes. ICD-9, NDC, RxNorm, CPT, and SNOMED are " +
      "recognized but have no lookup endpoint yet. Use this to decode a code value's meaning — for an HL7 " +
      "segment's field layout use get_segment_spec instead, not lookup_code.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);
      const system = parsed.codeSystem as CodeSystem;

      // ICD-10 has a real Bridge endpoint over the full set (substring match on
      // code + description, so exact and fuzzy both work). Fall back to the
      // embedded sample when the Bridge is unavailable (CLI mode / not running).
      if (system === "icd10") {
        try {
          const matches = await transport.lookupIcd10(parsed.code);
          if (matches.length > 0) {
            return { content: [{ type: "text", text: formatIcd10Matches(parsed.code, matches) }] };
          }
        } catch {
          // fall through to the embedded sample
        }
      }

      const result = performLookup(parsed.code, system, parsed.fuzzySearch ?? false);
      return {
        content: [{ type: "text", text: result }],
      };
    },
  };
}
