#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the structured free/paid + error signal.
 *
 * Why this matters: an agent orchestrating a multi-tool workflow must be able to
 * branch on WHY a call failed — a tier gate vs a transport error — without
 * regexing prose. If the tier gate stops carrying a stable typed code, the agent
 * can no longer self-pace or self-upgrade, and a "needs Pro" message could be
 * mistaken for a real failure. These tests pin the typed envelope and the rule
 * that a tier gate is a graceful message, never a thrown error.
 */
import { tierGateResult, errorResult, throttleResult, normalizeTier, tierSatisfies, ErrorEnvelope } from "../src/tools/format";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

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

/** An agent parses the fenced ```json envelope a tool embeds in its text. */
function parseEnvelope(text: string): ErrorEnvelope {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) throw new Error(`no fenced json envelope in:\n${text}`);
  return JSON.parse(match[1]) as ErrorEnvelope;
}

console.log("Running structured-signal tests...\n");

test("tier gate carries a machine-parseable TIER_REQUIRED envelope", () => {
  const result = tierGateResult({ toolName: "diff_messages", currentTier: "free", requiredTier: "pro" });
  const text = result.content[0].text;
  const env = parseEnvelope(text);
  assert(env.ok === false, "envelope.ok should be false");
  assert(env.error.code === "TIER_REQUIRED", `expected TIER_REQUIRED, got ${env.error.code}`);
  assert(env.error.tier?.current === "free", "current tier should be free");
  assert(env.error.tier?.required === "pro", "required tier should be pro");
});

test("tier gate also carries a human-readable upgrade line", () => {
  const text = tierGateResult({ toolName: "diff_messages", currentTier: "free", requiredTier: "pro" }).content[0].text;
  assert(text.includes("Pidgeon Pro required"), "human line should name the Pro requirement");
  assert(text.includes("pidgeon.health/upgrade"), "human line should give the upgrade path");
  assert(text.includes("diff_messages"), "human line should name the gated tool");
});

test("tier gate recovery names REAL commands, not the nonexistent `pidgeon auth login`", () => {
  const text = tierGateResult({ toolName: "send_message", currentTier: "free", requiredTier: "pro" }).content[0].text;
  assert(!text.includes("pidgeon auth login"), "must not point an agent at a command that does not exist");
  assert(text.includes("pidgeon license activate"), "recovery must name the real license-activate command");
  assert(text.includes("claim-console-free"), "recovery must offer the free-tier claim path");
});

test("tier gate normalizes the Bridge's wider vocabulary in the DISPLAYED tier (Professional -> pro)", () => {
  // The Bridge 402 interpolates the C# enum ("Professional"/"ConsoleFree"); the
  // gate display must read in the same free|pro|enterprise vocabulary as the code.
  const text = tierGateResult({ currentTier: "ConsoleFree", requiredTier: "Professional" }).content[0].text;
  assert(text.includes("Your current tier: free"), "ConsoleFree must display as free");
  assert(text.includes("Required tier: pro"), "Professional must display as pro");
  const env = parseEnvelope(text);
  assert(env.error.tier?.current === "free" && env.error.tier?.required === "pro", "the envelope tiers normalize too");
});

test("enterprise gate labels Enterprise, not Pro", () => {
  const text = tierGateResult({ currentTier: "pro", requiredTier: "enterprise" }).content[0].text;
  assert(text.includes("Pidgeon Enterprise required"), "should label Enterprise");
  const env = parseEnvelope(text);
  assert(env.error.tier?.required === "enterprise", "required tier should be enterprise");
});

test("tier gate is a value, never a throw (an agent loop must not crash)", () => {
  let threw = false;
  try {
    const result = tierGateResult({ currentTier: "free", requiredTier: "pro" });
    assert(Array.isArray(result.content) && result.content.length > 0, "should return content");
  } catch {
    threw = true;
  }
  assert(!threw, "tierGateResult must not throw");
});

test("errorResult carries a typed TOOL_ERROR envelope with the message", () => {
  const text = errorResult("Bridge timed out after 30s").content[0].text;
  assert(text.startsWith("Bridge timed out"), "human message should lead");
  const env = parseEnvelope(text);
  assert(env.error.code === "TOOL_ERROR", `expected TOOL_ERROR, got ${env.error.code}`);
  assert(env.error.message === "Bridge timed out after 30s", "envelope should echo the message");
});

test("errorResult honors a custom code and context", () => {
  const env = parseEnvelope(errorResult("needs the Bridge", "BRIDGE_REQUIRED", { tool: "refine_hl7_segment" }).content[0].text);
  assert(env.error.code === "BRIDGE_REQUIRED", `expected BRIDGE_REQUIRED, got ${env.error.code}`);
  assert((env.error as Record<string, unknown>).tool === "refine_hl7_segment", "context should be merged into the envelope");
});

// normalizeTier: the one-vocabulary seam. The Bridge entitlement contract emits
// the C# SubscriptionTier enum name lowercased ("professional", "consolefree"),
// which the gate's free|pro|enterprise ranks cannot read. WHY this matters: an
// un-normalized "professional" ranks as undefined, so a PAYING Pro caller driving
// MCP bridge mode is silently denied at the gate — the exact divergent-vocabulary
// hole the entitlement-source slice closes.
test("normalizeTier maps the Bridge enum name \"professional\" to pro (else a paying user is denied)", () => {
  assert(normalizeTier("professional") === "pro", "\"professional\" must rank as pro");
  assert(tierSatisfies(normalizeTier("professional"), "pro") === true, "a Pro emission must satisfy a Pro gate");
});

test("normalizeTier maps the GUI tier \"consolefree\" to free", () => {
  assert(normalizeTier("consolefree") === "free", "\"consolefree\" sits below pro");
});

test("normalizeTier maps the Supabase/JWT \"trial\" claim to pro (a trial exercises paid features)", () => {
  assert(normalizeTier("trial") === "pro", "\"trial\" must unlock paid tools");
});

test("normalizeTier passes the canonical vocabulary through unchanged", () => {
  assert(normalizeTier("free") === "free", "free stays free");
  assert(normalizeTier("pro") === "pro", "pro stays pro");
  assert(normalizeTier("enterprise") === "enterprise", "enterprise stays enterprise");
});

test("normalizeTier is case/whitespace tolerant and fails safe to free", () => {
  assert(normalizeTier(" Professional ") === "pro", "trimmed + lowercased");
  assert(normalizeTier("ENTERPRISE") === "enterprise", "case-insensitive");
  assert(normalizeTier("") === "free", "empty fails safe to free");
  assert(normalizeTier(undefined) === "free", "undefined fails safe to free");
  assert(normalizeTier("platinum") === "free", "an unknown tier must gate, not crash");
});

// throttleResult: the free-tier volume cap's graceful surface. WHY this matters:
// an unattended agent loop that hits the daily cap must get a typed, self-paceable
// THROTTLED signal it can branch on — never a thrown error that crashes the loop.
// The whole soft-cap posture ("convert on volume, never a hard 403") depends on
// this being a returned value carrying remaining/resetsAt, not an exception.
test("throttleResult is a value carrying a machine-parseable THROTTLED envelope, never a throw", () => {
  let threw = false;
  let text = "";
  try {
    text = throttleResult({
      toolName: "generate_message",
      reason: "daily_cap_reached",
      remaining: 0,
      resetsAt: "2026-06-20T00:00:00Z",
    }).content[0].text;
  } catch {
    threw = true;
  }
  assert(!threw, "throttleResult must not throw — a soft cap never breaks the agent loop");

  const env = parseEnvelope(text);
  const throttle = (env.error as Record<string, any>).throttle;
  assert(env.ok === false, "envelope.ok should be false");
  assert(env.error.code === "THROTTLED", `expected THROTTLED, got ${env.error.code}`);
  assert(throttle.reason === "daily_cap_reached", "carries the structured reason an agent branches on");
  assert(throttle.remaining === 0, "carries remaining so the agent can self-pace");
  assert(throttle.resetsAt === "2026-06-20T00:00:00Z", "carries the reset time");
});

test("throttleResult also carries a human-readable, never-fatal upgrade line", () => {
  const text = throttleResult({
    toolName: "generate_message",
    reason: "daily_cap_reached",
    remaining: 0,
    resetsAt: "soon",
  }).content[0].text;
  assert(text.toLowerCase().includes("cap reached"), "human line names the cap");
  assert(text.includes("one call a minute"), "human line explains the soft degradation, not a hard block");
  assert(text.includes("pidgeon.health/upgrade"), "human line gives the upgrade path");
});

// Cross-runtime tier-vocabulary contract. WHY this matters: normalizeTier (here) and
// the C# TierClaims.ToTier are hand-maintained peers with no shared literal across the
// runtimes. A tier alias added to one runtime but not the other silently collapses a
// paying user to free on that vector. golden/tier-vocabulary.json is the one table both
// must satisfy: this asserts the MCP side, the C# TierVocabularyContractTests asserts the
// Bridge side. Adding a paid alias to one runtime forces a golden row, which fails the
// other runtime's test until it is taught the alias too.
test("normalizeTier matches every row of the shared tier-vocabulary golden", () => {
  const goldenPath = [
    join(__dirname, "../golden/tier-vocabulary.json"),
    join(__dirname, "../../golden/tier-vocabulary.json"),
  ].find(existsSync);
  if (goldenPath === undefined) {
    throw new Error("tier-vocabulary golden should exist in the package or monorepo");
  }
  const rows = JSON.parse(readFileSync(goldenPath, "utf8")) as Array<{ alias: string; tier: string }>;
  assert(rows.length > 0, "tier-vocabulary golden should not be empty");
  for (const row of rows) {
    const actual = normalizeTier(row.alias);
    assert(
      actual === row.tier,
      `tier-vocabulary drift: golden says "${row.alias}" -> "${row.tier}", but MCP normalizeTier resolves it to "${actual}". ` +
        "Update normalizeTier, the C# TierClaims.ToTier, and golden/tier-vocabulary.json together.",
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
