#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Composition-boundary tests (PREP-PUBLIC-MCP / PID-678).
 *
 * The public adapter's registration boundary is fail-closed:
 *   - CLI mode registers EXACTLY the checked-in community allowlist
 *     (community-catalog.ts) — a planted private/ghost catalog entry never
 *     registers there;
 *   - authenticated Bridge mode registers EXACTLY the server-advertised
 *     entitled roster — a catalog tool the server did not advertise never
 *     registers, whatever its client-side tier label says;
 *   - Bridge mode without an advertisement (older Bridge build, unreachable)
 *     fails closed to the community allowlist, never "register everything".
 *
 * Fix on failure: do NOT widen the community catalog to make a test pass.
 * Community membership follows the community CLI's shipped command catalog
 * (config/public-compositions/community.yaml, Pidgeon.CLI artifact) — see the
 * membership rule in src/community-catalog.ts.
 */
import { TOOL_CATALOG, ToolCatalogEntry } from "../src/catalog";
import { COMMUNITY_TOOL_NAMES, COMMUNITY_TOOL_SET } from "../src/community-catalog";
import { resolveCompositionRoster } from "../src/tools/registration";
import { PROMPT_CATALOG } from "../src/prompts/catalog";
import { setActiveComposition, resetActiveComposition, isToolActive } from "../src/composition";
import { createDescribeTool } from "../src/tools/describe-tool";
import { PidgeonTransport } from "../src/transport/types";

let passed = 0;
let failed = 0;

// Sequential runner: cases share the module-level active-composition state, so
// they must never interleave.
const cases: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>): void {
  cases.push({ name, fn });
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertSetEquals(actual: readonly string[], expected: readonly string[], label: string): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  assert(
    a.length === e.length && a.every((v, i) => v === e[i]),
    `${label}: expected [${e.join(", ")}], got [${a.join(", ")}]`
  );
}

console.log("Composition boundary (PREP-PUBLIC-MCP)\n");

// ---------------------------------------------------------------------------
// Community catalog drift guards
// ---------------------------------------------------------------------------

// The exact expected community roster. Changing it is a deliberate
// public-surface decision (OPEN_CORE_COMPILE_BOUNDARIES.md §7), made here AND
// in src/community-catalog.ts together, never in one place alone.
const EXPECTED_COMMUNITY = [
  "generate_message",
  "validate_message",
  "deidentify_message",
  "manage_data_packages",
  "search_artifacts",
  "explain_message",
  "explain_error",
  "lookup_code",
  "get_segment_spec",
  "pidgeon_status",
  "describe_tool",
];

test("community catalog is exactly the expected checked-in allowlist", () => {
  assertSetEquals(COMMUNITY_TOOL_NAMES, EXPECTED_COMMUNITY, "community catalog");
});

test("every community tool exists in the full catalog", () => {
  const known = new Set(TOOL_CATALOG.map((e) => e.name));
  const missing = COMMUNITY_TOOL_NAMES.filter((n) => !known.has(n));
  assert(missing.length === 0, `community names with no catalog definition: ${missing.join(", ")}`);
});

test("every community tool is free tier — no paid tool can enter the community surface", () => {
  const paid = TOOL_CATALOG.filter((e) => COMMUNITY_TOOL_SET.has(e.name) && e.requiredTier !== "free");
  assert(paid.length === 0, `paid tools in the community catalog: ${paid.map((e) => e.name).join(", ")}`);
});

test("Bridge-only advisory tools stay excluded from the community CLI catalog", () => {
  // Semantic/AI substrates are excluded from the community compile graph.
  for (const name of [
    "semantic_review",
    "clinical_check",
  ]) {
    assert(!COMMUNITY_TOOL_SET.has(name), `${name} must not be in the community catalog yet`);
  }
});

// ---------------------------------------------------------------------------
// resolveCompositionRoster — the fail-closed boundary
// ---------------------------------------------------------------------------

const PLANTED: ToolCatalogEntry = {
  name: "loft_admin_backdoor",
  requiredTier: "free", // even a free-labeled plant must not register
  factory: () => {
    throw new Error("planted tool factory must never run");
  },
};

test("CLI mode registers exactly the community allowlist", () => {
  const { roster, source } = resolveCompositionRoster({
    mode: "cli",
    catalog: TOOL_CATALOG,
    communityNames: COMMUNITY_TOOL_SET,
    advertised: null,
  });
  assertSetEquals(roster.map((e) => e.name), EXPECTED_COMMUNITY, "CLI-mode roster");
  assert(source === "community-cli", `source must be community-cli, got ${source}`);
});

test("a planted catalog tool never registers in CLI mode (fail-closed allowlist)", () => {
  const { roster } = resolveCompositionRoster({
    mode: "cli",
    catalog: [...TOOL_CATALOG, PLANTED],
    communityNames: COMMUNITY_TOOL_SET,
    advertised: null,
  });
  assert(!roster.some((e) => e.name === PLANTED.name), "planted tool leaked into the CLI-mode roster");
});

test("no Pro tool ever appears in the CLI-mode roster (0.2.0 ghost-tool finding F4)", () => {
  const { roster } = resolveCompositionRoster({
    mode: "cli",
    catalog: TOOL_CATALOG,
    communityNames: COMMUNITY_TOOL_SET,
    advertised: null,
  });
  const pro = roster.filter((e) => e.requiredTier !== "free");
  assert(pro.length === 0, `Pro tools in CLI-mode roster: ${pro.map((e) => e.name).join(", ")}`);
});

test("Bridge mode registers exactly the server-advertised roster", () => {
  const advertised = ["generate_message", "validate_message", "diff_messages", "conform"];
  const { roster, source } = resolveCompositionRoster({
    mode: "bridge",
    catalog: TOOL_CATALOG,
    communityNames: COMMUNITY_TOOL_SET,
    advertised,
  });
  assertSetEquals(roster.map((e) => e.name), advertised, "Bridge-mode roster");
  assert(source === "bridge-advertised", `source must be bridge-advertised, got ${source}`);
});

test("a catalog tool the Bridge did not advertise never registers (client tier labels do not materialize tools)", () => {
  const advertised = ["generate_message", "validate_message"];
  const { roster } = resolveCompositionRoster({
    mode: "bridge",
    catalog: [...TOOL_CATALOG, PLANTED],
    communityNames: COMMUNITY_TOOL_SET,
    advertised,
  });
  assert(!roster.some((e) => e.name === "diff_messages"), "unadvertised Pro tool leaked into the Bridge roster");
  assert(!roster.some((e) => e.name === PLANTED.name), "planted tool leaked into the Bridge roster");
});

test("an advertised capability with no local definition is skipped and reported, never fabricated", () => {
  const advertised = ["generate_message", "x12_validate_837p"];
  const { roster, unknownAdvertised } = resolveCompositionRoster({
    mode: "bridge",
    catalog: TOOL_CATALOG,
    communityNames: COMMUNITY_TOOL_SET,
    advertised,
  });
  assertSetEquals(roster.map((e) => e.name), ["generate_message"], "roster with unknown advertisement");
  assertSetEquals(unknownAdvertised, ["x12_validate_837p"], "unknownAdvertised");
});

test("Bridge mode without an advertisement fails closed to the community allowlist", () => {
  const { roster, source } = resolveCompositionRoster({
    mode: "bridge",
    catalog: TOOL_CATALOG,
    communityNames: COMMUNITY_TOOL_SET,
    advertised: null,
  });
  assertSetEquals(roster.map((e) => e.name), EXPECTED_COMMUNITY, "Bridge fallback roster");
  assert(source === "bridge-fallback-community", `source must be bridge-fallback-community, got ${source}`);
});

test("an empty advertisement registers nothing (the server said so — not a fallback)", () => {
  const { roster, source } = resolveCompositionRoster({
    mode: "bridge",
    catalog: TOOL_CATALOG,
    communityNames: COMMUNITY_TOOL_SET,
    advertised: [],
  });
  assert(roster.length === 0, `expected an empty roster, got ${roster.map((e) => e.name).join(", ")}`);
  assert(source === "bridge-advertised", `source must be bridge-advertised, got ${source}`);
});

// ---------------------------------------------------------------------------
// Ghost surfaces beyond registration: prompts + describe_tool follow the roster
// ---------------------------------------------------------------------------

test("every guided workflow's tool chain is covered by the full catalog (no dangling prompt references)", () => {
  const known = new Set(TOOL_CATALOG.map((e) => e.name));
  for (const p of PROMPT_CATALOG) {
    const dangling = p.tools.filter((t) => !known.has(t));
    assert(dangling.length === 0, `prompt ${p.name} references unknown tools: ${dangling.join(", ")}`);
  }
});

test("prompt filtering: only community-covered workflows survive the community composition", () => {
  try {
    setActiveComposition({ source: "community-cli", toolNames: COMMUNITY_TOOL_SET });
    const surviving = PROMPT_CATALOG.filter((p) => p.tools.every((t) => isToolActive(t)));
    // The three end-to-end free workflows return with community validation;
    // mixed workflows remain filtered because every chained tool must be active.
    assertSetEquals(
      surviving.map((p) => p.name),
      ["debug_hl7_error", "go_live_prep", "onboard_vendor_interface"],
      "community guided workflows"
    );
  } finally {
    resetActiveComposition();
  }
});

test("describe_tool lists only the active composition and refuses tools outside it", async () => {
  try {
    setActiveComposition({ source: "community-cli", toolNames: COMMUNITY_TOOL_SET });
    const tool = createDescribeTool();
    const fakeTransport = {} as PidgeonTransport;

    const listing = await tool.handler(fakeTransport, {});
    const listingText = JSON.stringify(listing);
    assert(!listingText.includes("diff_messages"), "describe_tool roster listing leaked a Pro tool name");
    assert(listingText.includes("generate_message"), "describe_tool roster listing lost a community tool");

    const denied = await tool.handler(fakeTransport, { name: "loft_status" });
    const deniedText = JSON.stringify(denied);
    assert(deniedText.includes("No tool named"), "describe_tool described a tool outside the active composition");
  } finally {
    resetActiveComposition();
  }
});

test("with no composition set (manifest builders), describe_tool sees the full catalog", async () => {
  resetActiveComposition();
  const tool = createDescribeTool();
  const listing = await tool.handler({} as PidgeonTransport, {});
  const text = JSON.stringify(listing);
  assert(text.includes("diff_messages"), "full-catalog default lost a Pro tool for the manifest path");
});

async function run(): Promise<void> {
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✓ ${c.name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${c.name}`);
      console.log(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

void run();
