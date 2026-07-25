#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Drift guard for the generated MCP manifest + the tool catalog.
 *
 * Why this matters: the manifest is how the surface advertises itself to an
 * agent. If it drifts from what the server actually registers, an agent plans
 * against tools or tiers that do not exist. These tests fail the build the
 * moment `manifest.json` / `MANIFEST.md` / `bundle/manifest.json` no longer
 * match what the catalog + tool schemas generate, and the moment a tool's live
 * tier disagrees with the catalog entry that gates it.
 *
 * Fix on failure: run `npm run manifest` and commit the regenerated files.
 */
import { existsSync, readFileSync } from "fs";

import { TOOL_CATALOG } from "../src/catalog";
import {
  buildManifest,
  buildMcpbManifest,
  buildTokenBudget,
  renderMarkdown,
  serializeJson,
  COLD_START_TOKEN_BUDGET,
  PER_TOOL_CHAR_CEILING,
  MANIFEST_JSON_PATH,
  MANIFEST_MD_PATH,
  MCPB_MANIFEST_PATH,
} from "../scripts/manifest";

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
    console.log(`    ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEqualFile(path: string, expected: string, label: string): void {
  const actual = readFileSync(path, "utf8");
  if (actual !== expected) {
    const at = [...actual].findIndex((ch, i) => ch !== expected[i]);
    throw new Error(
      `${label} is stale (run \`npm run manifest\`). First difference near index ${at}:\n` +
        `  committed: ${JSON.stringify(actual.slice(Math.max(0, at - 20), at + 20))}\n` +
        `  generated: ${JSON.stringify(expected.slice(Math.max(0, at - 20), at + 20))}`
    );
  }
}

console.log("Running manifest + catalog drift guard...\n");

const manifest = buildManifest();

test("catalog entry tier + name match each tool's live factory output", () => {
  for (const entry of TOOL_CATALOG) {
    const def = entry.factory();
    assert(def.name === entry.name, `catalog name '${entry.name}' != factory name '${def.name}'`);
    assert(
      def.requiredTier === entry.requiredTier,
      `${entry.name}: catalog tier '${entry.requiredTier}' != factory tier '${def.requiredTier}'`
    );
  }
});

test("catalog is 22 tools — 13 free, 9 Pro", () => {
  // 20 (envelope-everywhere baseline) + describe_tool (the H-22 free meta-tool)
  // + search_artifacts (ARTIFACT-ECOSYSTEM local discovery) = 22. Both additions
  // are free: describe_tool describes Pro tools without unlocking them, and
  // artifact discovery is the funnel into install/activate, never account-gated.
  assert(TOOL_CATALOG.length === 22, `expected 22 tools, got ${TOOL_CATALOG.length}`);
  const free = TOOL_CATALOG.filter((e) => e.requiredTier === "free").length;
  const pro = TOOL_CATALOG.filter((e) => e.requiredTier === "pro").length;
  assert(free === 13, `expected 13 free tools, got ${free}`);
  assert(pro === 9, `expected 9 Pro tools, got ${pro}`);
});

test("tool names are unique", () => {
  const names = TOOL_CATALOG.map((e) => e.name);
  assert(new Set(names).size === names.length, `duplicate tool name in catalog: ${names.join(", ")}`);
});

test("every tool carries a non-empty input schema in the manifest", () => {
  for (const t of manifest.tools) {
    assert(typeof t.inputSchema === "object" && t.inputSchema !== null, `${t.name} has no input schema`);
    assert(t.inputSchema["type"] === "object", `${t.name} input schema is not an object schema`);
  }
});

// ---------------------------------------------------------------------------
// Token-budget standing guards (H-20 / H-21)
// ---------------------------------------------------------------------------
// These are the point of the slice: the surface's cold-start cost cannot grow
// past the budget by accretion. A description or schema bloat fails the build.

const budget = buildTokenBudget(manifest);

test(`no tool's full definition exceeds the H-21 hard ceiling (${PER_TOOL_CHAR_CEILING} chars)`, () => {
  const over = budget.rows.filter((r) => r.fullChars > PER_TOOL_CHAR_CEILING);
  assert(
    over.length === 0,
    `over the ${PER_TOOL_CHAR_CEILING}-char per-tool ceiling (H-21): ` +
      over.map((r) => `${r.name}=${r.fullChars}`).join(", ") +
      ` — trim the description/schema (move examples to MANIFEST.md, one-line field descriptions).`
  );
});

test(`cold-start total is within the H-20 budget (${COLD_START_TOKEN_BUDGET} tokens)`, () => {
  assert(
    budget.totalTokens <= COLD_START_TOKEN_BUDGET,
    `cold-start total ${budget.totalTokens} tokens (${budget.totalChars} chars) exceeds the ${COLD_START_TOKEN_BUDGET}-token budget (H-20). ` +
      `Trim tools or defer the lowest-reach ones (agentic harness standard §2.3).`
  );
});

test("MANIFEST.md carries the token-budget table with the live headline total", () => {
  // The full table is byte-drift-guarded below; this asserts the section and
  // the headline number are present so an accounting change is legible.
  const md = readFileSync(MANIFEST_MD_PATH, "utf8");
  const commas = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  assert(md.includes("## Token budget (cold-start accounting)"), "MANIFEST.md is missing the token-budget section");
  assert(
    md.includes(`Cold-start total: **${commas(budget.totalTokens)} tokens**`),
    `MANIFEST.md headline total is stale — expected ${commas(budget.totalTokens)} tokens (run \`npm run manifest\`)`
  );
});

// ---------------------------------------------------------------------------
// Annotation ↔ catalog parity (H-15)
// ---------------------------------------------------------------------------
// A new tool cannot register without ToolAnnotations: the ToolDefinition field
// is required (compile-enforced) and this test fails on an empty/ill-typed
// annotation object, so the retry-class declaration can never be skipped.

test("every catalog tool declares ToolAnnotations with readOnlyHint (H-15)", () => {
  for (const entry of TOOL_CATALOG) {
    const def = entry.factory();
    const a = def.annotations;
    assert(a !== undefined && a !== null && typeof a === "object", `${entry.name} has no annotations object`);
    assert(Object.keys(a).length > 0, `${entry.name} has an empty annotations object — declare its retry class`);
    assert(typeof a.readOnlyHint === "boolean", `${entry.name} must set readOnlyHint (H-15 retry-class declaration)`);
  }
});

test("side-effecting tools declare destructive + idempotent hints (H-15)", () => {
  // When readOnlyHint is false the destructive/idempotent hints carry the real
  // signal (spec: they are only meaningful for non-read tools), so both must be
  // present booleans — an unqualified non-read tool would default to destructive.
  for (const entry of TOOL_CATALOG) {
    const a = entry.factory().annotations;
    if (a.readOnlyHint === false) {
      assert(typeof a.destructiveHint === "boolean", `${entry.name} is non-read: set destructiveHint`);
      assert(typeof a.idempotentHint === "boolean", `${entry.name} is non-read: set idempotentHint`);
    }
  }
});

test("manifest tools carry their annotations", () => {
  for (const t of manifest.tools) {
    assert(typeof t.annotations === "object" && t.annotations !== null, `${t.name} manifest entry has no annotations`);
    assert(typeof t.annotations.readOnlyHint === "boolean", `${t.name} manifest annotation missing readOnlyHint`);
  }
});

// ---------------------------------------------------------------------------
// Output-envelope contract (H-16, the `envelope-everywhere` slice)
// ---------------------------------------------------------------------------
// Every tool whose result plausibly feeds another tool emits a machine envelope
// via withSuccessEnvelope, and documents its `ok: true` keys in the manifest so
// an agent can chain output -> input without re-parsing prose. These guards keep
// the roster of chaining tools + their documented keys from silently drifting.
//
// A representative (stable) key per tool, used to assert the doc actually rendered
// into MANIFEST.md. The full key set + feeds are validated against the live factory.
const CHAINING_TOOL_KEYS: Record<string, { keys: string[]; marker: string }> = {
  generate_message: { keys: ["messages", "messageType", "count", "effectiveSeed"], marker: "messages" },
  validate_message: { keys: ["isValid", "conformanceScore", "findings"], marker: "isValid" },
  explain_message: { keys: ["standard", "messageType", "segments", "resourceType", "id"], marker: "segments" },
  diff_messages: { keys: ["identical", "differenceCount", "differences"], marker: "differences" },
  run_workflow: { keys: ["stepCount", "steps"], marker: "steps" },
  conform: { keys: ["passed", "mode", "endpoint", "findings"], marker: "passed" },
  // Cross-app journey handoff pair (H-26): generate_population's jobId envelope is
  // population_status's argument; population_status re-feeds itself until ready.
  generate_population: { keys: ["jobId", "population", "format", "patientCount"], marker: "jobId" },
  population_status: { keys: ["jobId", "status", "ready", "downloadRef"], marker: "downloadRef" },
};

test("every chaining tool declares an outputEnvelope with keys + feeds (H-16)", () => {
  const catalogNames = new Set(TOOL_CATALOG.map((e) => e.name));
  for (const name of Object.keys(CHAINING_TOOL_KEYS)) {
    const entry = TOOL_CATALOG.find((e) => e.name === name);
    assert(entry !== undefined, `chaining tool '${name}' is missing from the catalog`);
    const oe = entry!.factory().outputEnvelope;
    assert(oe !== undefined, `${name} must declare an outputEnvelope (H-16)`);
    assert(Array.isArray(oe!.keys) && oe!.keys.length > 0, `${name} outputEnvelope needs at least one key`);
    assert(Array.isArray(oe!.feeds) && oe!.feeds.length > 0, `${name} outputEnvelope must name the tool(s) it feeds`);
    for (const k of oe!.keys) {
      assert(typeof k.key === "string" && k.key.length > 0, `${name} has an envelope key with no name`);
      assert(typeof k.description === "string" && k.description.length > 0, `${name}.${k.key} needs a one-line contract`);
    }
    for (const f of oe!.feeds) {
      assert(catalogNames.has(f), `${name} outputEnvelope.feeds names '${f}', which is not a catalog tool`);
    }
  }
});

test("chaining tools document their expected envelope keys in the manifest", () => {
  for (const [name, spec] of Object.entries(CHAINING_TOOL_KEYS)) {
    const t = manifest.tools.find((tool) => tool.name === name);
    assert(t?.outputEnvelope !== undefined, `${name} manifest entry is missing outputEnvelope`);
    const documented = t!.outputEnvelope!.keys.map((k) => k.key);
    for (const expected of spec.keys) {
      assert(documented.includes(expected), `${name} envelope should document '${expected}' (has: ${documented.join(", ")})`);
    }
  }
});

test("output-envelope docs are OFF the cold-start budget (H-20/H-21)", () => {
  // The whole point of the wave-1 budget guard: output docs must NOT count toward
  // the per-tool ceiling or the cold-start total. The measured cold-start cost is
  // exactly {name, description, inputSchema, annotations} — outputEnvelope rides
  // the manifest only. This proves the field never leaks into what tools/list ships.
  for (const name of Object.keys(CHAINING_TOOL_KEYS)) {
    const t = manifest.tools.find((tool) => tool.name === name)!;
    const coldStart = JSON.stringify({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    });
    assert(!coldStart.includes("outputEnvelope"), `${name}: outputEnvelope must not ride the cold-start definition`);
    const row = budget.rows.find((r) => r.name === name)!;
    assert(
      row.fullChars === coldStart.length,
      `${name}: measured cold-start (${row.fullChars} chars) must equal {name,description,inputSchema,annotations} (${coldStart.length}) — ` +
        `the output-envelope docs are leaking into the H-20/H-21 budget.`
    );
  }
});

test("MANIFEST.md renders each chaining tool's output-envelope section", () => {
  const md = readFileSync(MANIFEST_MD_PATH, "utf8");
  assert(md.includes("**Output envelope** (H-16)"), "MANIFEST.md is missing the output-envelope sections");
  for (const [name, spec] of Object.entries(CHAINING_TOOL_KEYS)) {
    assert(
      md.includes(`| \`${spec.marker}\` |`),
      `MANIFEST.md is missing the documented '${spec.marker}' key row for ${name} (run \`npm run manifest\`)`
    );
  }
});

// loft_status is the cross-app journey's terminal watch step (H-26): it emits a
// machine envelope (so an agent branches on interface health, not prose) but its
// findings feed no downstream tool, so its outputEnvelope has empty feeds. Guarded
// separately because the CHAINING_TOOL_KEYS suite above assumes non-empty feeds.
test("loft_status declares a terminal output envelope (H-16/H-26 — empty feeds)", () => {
  const entry = TOOL_CATALOG.find((e) => e.name === "loft_status");
  assert(entry !== undefined, "loft_status is missing from the catalog");
  const oe = entry!.factory().outputEnvelope;
  assert(oe !== undefined, "loft_status must declare an outputEnvelope (it emits withSuccessEnvelope)");
  assert(Array.isArray(oe!.keys) && oe!.keys.length > 0, "loft_status envelope needs at least one key");
  assert(Array.isArray(oe!.feeds) && oe!.feeds.length === 0, "loft_status is terminal — feeds must be empty");
  const documented = oe!.keys.map((k) => k.key);
  for (const expected of ["interfaces", "health", "summary"]) {
    assert(documented.includes(expected), `loft_status envelope should document '${expected}' (has: ${documented.join(", ")})`);
  }
  const md = readFileSync(MANIFEST_MD_PATH, "utf8");
  assert(
    md.includes("the journey's terminal artifact"),
    "MANIFEST.md should render loft_status's terminal-envelope clause (run `npm run manifest`)"
  );
});

test("committed manifest.json matches the generator", () => {
  assertEqualFile(MANIFEST_JSON_PATH, serializeJson(manifest), "manifest.json");
});

test("committed MANIFEST.md matches the generator", () => {
  assertEqualFile(MANIFEST_MD_PATH, renderMarkdown(manifest) + "\n", "MANIFEST.md");
});

// The private monorepo carries the optional desktop-client .mcpb bundle. The
// public source/package boundary intentionally omits it, while still exercising
// the pure bundle builder below for catalog parity.
if (existsSync(MCPB_MANIFEST_PATH)) {
  test("committed bundle/manifest.json (.mcpb) matches the generator", () => {
    assertEqualFile(MCPB_MANIFEST_PATH, serializeJson(buildMcpbManifest(manifest)), "bundle/manifest.json");
  });
}

test(".mcpb manifest lists every catalog tool", () => {
  const mcpb = buildMcpbManifest(manifest);
  assert(mcpb.tools.length === TOOL_CATALOG.length, `bundle lists ${mcpb.tools.length} tools, catalog has ${TOOL_CATALOG.length}`);
  for (const entry of TOOL_CATALOG) {
    assert(mcpb.tools.some((t) => t.name === entry.name), `bundle manifest missing tool '${entry.name}'`);
  }
});

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
