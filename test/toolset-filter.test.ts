#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for user-configurable toolset narrowing (H-2 scoping clause, §2.3 part 2).
 *
 * Why this matters: H-2 says Pidgeon's DEFAULT ships the full roster (visibility
 * is the conversion surface) — but the operator may narrow the registered set to
 * their own context budget via PIDGEON_TOOLS / PIDGEON_EXCLUDE_TOOLS (or the
 * `.mcpb` user_config). These pin: (a) the default is full, (b) include/exclude
 * by name AND by tier, (c) a narrowing that removes everything reverts to full
 * (the default-full invariant never yields a useless empty server), and (d) the
 * resolver reads the ONE catalog, so a narrowed roster is a subset of the same
 * tools — it never forks semantics (H-1).
 */
import { resolveRoster, parseToolTokens, TOOLS_INCLUDE_ENV, TOOLS_EXCLUDE_ENV } from "../src/tools/registration";
import { TOOL_CATALOG } from "../src/catalog";

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

const names = (r: { roster: { name: string }[] }) => r.roster.map((e) => e.name);
const FREE = TOOL_CATALOG.filter((e) => e.requiredTier === "free").length;
const PRO = TOOL_CATALOG.filter((e) => e.requiredTier === "pro").length;

console.log("Running toolset-filter tests...\n");

test("default (no env) is the full roster (H-2 default-full)", () => {
  const r = resolveRoster(TOOL_CATALOG, {});
  assert(r.roster.length === TOOL_CATALOG.length, `expected ${TOOL_CATALOG.length}, got ${r.roster.length}`);
  assert(r.narrowed === false, "unconfigured is not narrowed");
  assert(r.warning === undefined, "no warning when unconfigured");
});

test("empty-string env vars are a no-op (still full roster)", () => {
  const r = resolveRoster(TOOL_CATALOG, { [TOOLS_INCLUDE_ENV]: "  ", [TOOLS_EXCLUDE_ENV]: "" });
  assert(r.roster.length === TOOL_CATALOG.length, "blank narrowing is a no-op");
  assert(r.narrowed === false, "blank config is not narrowed");
});

test("include by tier keyword: PIDGEON_TOOLS=free -> only free tools", () => {
  const r = resolveRoster(TOOL_CATALOG, { [TOOLS_INCLUDE_ENV]: "free" });
  assert(r.roster.length === FREE, `expected ${FREE} free tools, got ${r.roster.length}`);
  assert(r.roster.every((e) => e.requiredTier === "free"), "only free tools registered");
  assert(r.narrowed === true, "narrowing took effect");
});

test("include by name: PIDGEON_TOOLS names exactly those tools", () => {
  const r = resolveRoster(TOOL_CATALOG, { [TOOLS_INCLUDE_ENV]: "generate_message, validate_message" });
  assert(names(r).sort().join(",") === "generate_message,validate_message", `got ${names(r).join(",")}`);
});

test("include is case-insensitive and trims whitespace", () => {
  const r = resolveRoster(TOOL_CATALOG, { [TOOLS_INCLUDE_ENV]: " Generate_Message " });
  assert(names(r).join(",") === "generate_message", `got ${names(r).join(",")}`);
});

test("exclude by tier keyword: PIDGEON_EXCLUDE_TOOLS=pro -> drops every Pro tool", () => {
  const r = resolveRoster(TOOL_CATALOG, { [TOOLS_EXCLUDE_ENV]: "pro" });
  assert(r.roster.length === FREE, `expected ${FREE} free tools, got ${r.roster.length}`);
  assert(r.roster.every((e) => e.requiredTier === "free"), "no Pro tool survives the exclude");
});

test("exclude by name drops just that tool", () => {
  const r = resolveRoster(TOOL_CATALOG, { [TOOLS_EXCLUDE_ENV]: "send_message" });
  assert(r.roster.length === TOOL_CATALOG.length - 1, "one tool dropped");
  assert(!names(r).includes("send_message"), "send_message excluded");
});

test("exclude is applied AFTER include (include pro, exclude send_message)", () => {
  const r = resolveRoster(TOOL_CATALOG, { [TOOLS_INCLUDE_ENV]: "pro", [TOOLS_EXCLUDE_ENV]: "send_message" });
  assert(r.roster.length === PRO - 1, `expected ${PRO - 1}, got ${r.roster.length}`);
  assert(r.roster.every((e) => e.requiredTier === "pro"), "only Pro survives include");
  assert(!names(r).includes("send_message"), "then send_message is excluded");
});

test("a narrowing that removes everything reverts to the full roster + warns", () => {
  // include a name, then exclude the same name -> empty; must revert to full.
  const r = resolveRoster(TOOL_CATALOG, { [TOOLS_INCLUDE_ENV]: "generate_message", [TOOLS_EXCLUDE_ENV]: "generate_message" });
  assert(r.roster.length === TOOL_CATALOG.length, "empty narrowing reverts to full (H-2)");
  assert(r.narrowed === false, "reverted roster is not reported as narrowed");
  assert(typeof r.warning === "string" && r.warning.length > 0, "a revert emits a warning");
});

test("unknown tokens match nothing and (alone) revert to full", () => {
  const r = resolveRoster(TOOL_CATALOG, { [TOOLS_INCLUDE_ENV]: "not_a_tool" });
  assert(r.roster.length === TOOL_CATALOG.length, "an all-unknown include reverts to full, never empty");
  assert(typeof r.warning === "string", "warns on the misconfiguration");
});

test("a narrowed roster is a strict subset of the same catalog entries (H-1, no fork)", () => {
  const r = resolveRoster(TOOL_CATALOG, { [TOOLS_INCLUDE_ENV]: "free" });
  for (const e of r.roster) {
    assert(TOOL_CATALOG.includes(e), `${e.name} is not the catalog's own entry — narrowing must not clone`);
  }
});

test("parseToolTokens splits, trims, lowercases, drops empties", () => {
  assert(parseToolTokens("A, b ,,  c ").join(",") === "a,b,c", "token parse normalizes");
  assert(parseToolTokens(undefined).length === 0, "undefined -> no tokens");
  assert(parseToolTokens("").length === 0, "empty -> no tokens");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
