#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for capability-driven registration + tools/list_changed (§2.3 part 3),
 * and the budget-deferral flag that is PRESENT but OFF.
 *
 * Why this matters: the standard designs deferral NOW so growth has somewhere to
 * go, without flipping it on. A future package-gated tool (X12 / C-CDA validator)
 * must register only once its package installs, and announce its arrival via
 * `notifications/tools/list_changed`. No CURRENT tool is package-gated, so this
 * proves the mechanism against a SYNTHETIC gated catalog + a fake registrar that
 * records registrations and notifications — and pins that the real 21-tool roster
 * defers nothing and the budget-deferral flag stays OFF.
 */
import {
  partitionByCapability,
  onCapabilityInstalled,
  installedCapabilitiesFromEnv,
  ToolRegistrar,
  DEFERRAL_ENABLED,
  DEFERRAL_TOOL_THRESHOLD,
  shouldDeferForBudget,
  CAPABILITIES_ENV,
} from "../src/tools/registration";
import { ToolCatalogEntry } from "../src/catalog";
import { TOOL_CATALOG } from "../src/catalog";
import { ToolDefinition } from "../src/tools/types";

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

/** A fake registrar that records every registration + list_changed emission. */
function fakeRegistrar(): ToolRegistrar & { registered: string[]; notifications: number } {
  const state = { registered: [] as string[], notifications: 0 };
  return {
    registered: state.registered,
    get notifications() { return state.notifications; },
    registerTool: (entry: ToolCatalogEntry) => { state.registered.push(entry.name); },
    notifyListChanged: () => { state.notifications++; },
  } as ToolRegistrar & { registered: string[]; notifications: number };
}

/** Minimal catalog entry stub (the factory is never invoked in these tests). */
function entry(name: string, requiresCapability?: string): ToolCatalogEntry {
  return { name, requiredTier: "pro", factory: (() => ({}) as unknown as ToolDefinition), requiresCapability };
}

// A synthetic roster: two always-on tools + one gated on an installable package.
const SYNTH: ToolCatalogEntry[] = [
  entry("generate_message"),
  entry("validate_message"),
  entry("validate_x12", "x12-5010"),
];

console.log("Running list_changed / capability-registration tests...\n");

test("a capability-gated tool defers when its package is not installed", () => {
  const { available, deferred } = partitionByCapability(SYNTH, new Set());
  assert(available.map((e) => e.name).join(",") === "generate_message,validate_message", "ungated tools available");
  assert(deferred.map((e) => e.name).join(",") === "validate_x12", "gated tool deferred");
});

test("the gated tool is available once its package IS installed", () => {
  const { available, deferred } = partitionByCapability(SYNTH, new Set(["x12-5010"]));
  assert(available.length === 3, "all three available once installed");
  assert(deferred.length === 0, "nothing deferred");
});

test("onCapabilityInstalled registers the newly-available tool AND emits list_changed", () => {
  const reg = fakeRegistrar();
  const registered = new Set<string>(["generate_message", "validate_message"]); // the initial roster
  const added = onCapabilityInstalled(reg, SYNTH, "x12-5010", registered);
  assert(added.join(",") === "validate_x12", "returns the newly registered tool");
  assert(reg.registered.join(",") === "validate_x12", "registered exactly the gated tool");
  assert(reg.notifications === 1, "emitted exactly one tools/list_changed");
  assert(registered.has("validate_x12"), "tracks the new tool as registered");
});

test("installing a capability that unlocks nothing emits NO notification (idempotent)", () => {
  const reg = fakeRegistrar();
  const registered = new Set<string>(["generate_message", "validate_message", "validate_x12"]);
  const added = onCapabilityInstalled(reg, SYNTH, "x12-5010", registered);
  assert(added.length === 0, "nothing new to register");
  assert(reg.notifications === 0, "no spurious list_changed when the roster did not change");
});

test("a duplicate install event is a no-op the second time", () => {
  const reg = fakeRegistrar();
  const registered = new Set<string>(["generate_message", "validate_message"]);
  onCapabilityInstalled(reg, SYNTH, "x12-5010", registered);
  const again = onCapabilityInstalled(reg, SYNTH, "x12-5010", registered);
  assert(again.length === 0, "second install registers nothing");
  assert(reg.notifications === 1, "only the first install notified");
});

test("installedCapabilitiesFromEnv parses the env hook; default is empty", () => {
  assert(installedCapabilitiesFromEnv({}).size === 0, "no env -> no capabilities installed");
  const set = installedCapabilitiesFromEnv({ [CAPABILITIES_ENV]: "x12-5010, ccda" });
  assert(set.has("x12-5010") && set.has("ccda"), "parses the comma list");
});

// --- The real roster: nothing is package-gated today ---

test("the real 21-tool roster defers NOTHING (no current tool is package-gated)", () => {
  const { available, deferred } = partitionByCapability(TOOL_CATALOG, new Set());
  assert(deferred.length === 0, `expected 0 deferred, got ${deferred.length}: ${deferred.map((e) => e.name).join(",")}`);
  assert(available.length === TOOL_CATALOG.length, "every current tool is available at cold start");
});

// --- The budget-deferral flag: present but OFF ---

test("the budget-deferral flag is OFF (H-22: Pidgeon defers nothing at 21 tools)", () => {
  assert(DEFERRAL_ENABLED === false, "DEFERRAL_ENABLED must ship false");
});

test("shouldDeferForBudget is false at any roster size while the flag is off", () => {
  assert(shouldDeferForBudget(TOOL_CATALOG.length) === false, "current roster: no deferral");
  assert(shouldDeferForBudget(DEFERRAL_TOOL_THRESHOLD + 1000) === false, "even way over the threshold: no deferral while OFF");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
