#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Bridge-oracle path for the reference-lookup tools (FU-2). smoke.ts covers the
 * embedded fallback (default mock throws); this file proves the value-add when a
 * Bridge IS running: lookup_code resolves ICD-10 against the full set, and
 * get_segment_spec resolves a single field for the EXACT hl7Version — the fix
 * for the previously-cosmetic version param and the 11-of-110 segment coverage.
 *
 * Run: npx ts-node test/reference-lookup.test.ts
 */

import { createLookupTool } from "../src/tools/lookup";
import { createSegmentSpecTool } from "../src/tools/segment-spec";
import { PidgeonTransport } from "../src/transport/index";
import { FieldSpecResult, Icd10Match } from "../src/transport/reference-types";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assertContains(text: string, needle: string): void {
  if (!text.includes(needle)) throw new Error(`expected output to contain "${needle}"\n--- got ---\n${text}`);
}

// A running Bridge oracle: only the two reference methods the tools call are
// implemented; everything else on the interface is absent and never invoked.
function oracleTransport(overrides: {
  field?: (segment: string, position: number, version?: string) => FieldSpecResult;
  icd10?: (query: string) => Icd10Match[];
} = {}): PidgeonTransport {
  return {
    async getFieldSpec(segment: string, position: number, version?: string): Promise<FieldSpecResult> {
      if (overrides.field) return overrides.field(segment, position, version);
      return { segment, position, name: "Patient Name", dataType: "XPN", optionality: "R", maxLength: 250, version: version ?? "2.3" };
    },
    async lookupIcd10(query: string): Promise<Icd10Match[]> {
      if (overrides.icd10) return overrides.icd10(query);
      return [{ code: "E11.9", description: "Type 2 diabetes mellitus without complications", category: "Endocrine" }];
    },
  } as unknown as PidgeonTransport;
}

// A Bridge that is up but has no match — the tool must fall back to embedded,
// not render an empty oracle result.
function emptyOracleTransport(): PidgeonTransport {
  return oracleTransport({ icd10: () => [] });
}

async function main() {
  console.log("Running reference-lookup Bridge-oracle tests...\n");

  await test("lookup_code ICD-10 renders full-set matches from the oracle", async () => {
    const tool = createLookupTool();
    const result = await tool.handler(oracleTransport(), { code: "E11.9", codeSystem: "icd10" });
    assertContains(result.content[0].text, "Bridge oracle");
    assertContains(result.content[0].text, "E11.9");
    assertContains(result.content[0].text, "diabetes");
  });

  await test("lookup_code ICD-10 falls back to embedded when the oracle returns no match", async () => {
    const tool = createLookupTool();
    // I10 IS in the embedded sample; an empty oracle response must not hide it.
    const result = await tool.handler(emptyOracleTransport(), { code: "I10", codeSystem: "icd10" });
    assertContains(result.content[0].text, "hypertension");
  });

  await test("lookup_code non-ICD systems never touch the oracle (LOINC stays embedded)", async () => {
    const tool = createLookupTool();
    // getFieldSpec/lookupIcd10 both throw here; if LOINC routed to the oracle it would surface.
    const throwing = { async getFieldSpec() { throw new Error("x"); }, async lookupIcd10() { throw new Error("x"); } } as unknown as PidgeonTransport;
    const result = await tool.handler(throwing, { code: "2823-3", codeSystem: "loinc" });
    assertContains(result.content[0].text, "Potassium");
  });

  await test("get_segment_spec single field is version-resolved via the oracle (hl7Version no longer cosmetic)", async () => {
    const tool = createSegmentSpecTool();
    const result = await tool.handler(oracleTransport(), { segment: "PID", field: 5, hl7Version: "2.8" });
    assertContains(result.content[0].text, "Bridge oracle (HL7 v2.8)");
    assertContains(result.content[0].text, "XPN");
  });

  await test("get_segment_spec single field falls back to the embedded summary when the oracle is down", async () => {
    const tool = createSegmentSpecTool();
    const down = { async getFieldSpec() { throw new Error("no bridge"); } } as unknown as PidgeonTransport;
    const result = await tool.handler(down, { segment: "PID", field: 5 });
    assertContains(result.content[0].text, "Patient Name");
    assertContains(result.content[0].text, "embedded summary");
  });

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main();
