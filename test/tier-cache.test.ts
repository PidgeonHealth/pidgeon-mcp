#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the tool gate's tier resolution (createTierResolver).
 *
 * Why this matters: the gate used to memoize tier once at server startup,
 * so a user who upgraded mid-session kept hitting TIER_REQUIRED until they
 * restarted the MCP server — failing them at exactly the conversion moment.
 * These tests pin the two refresh triggers: TTL expiry, and the forced
 * refresh the gate performs before denying a call.
 */
import { createTierResolver, TIER_TTL_MS } from "../src/server";
import type { PidgeonTransport, Tier } from "../src/transport";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${err instanceof Error ? err.message : String(err)}\n`);
    });
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** Transport stub: only getTier matters here; tier and call count are inspectable. */
function makeTransport(initialTier: Tier) {
  const state = {
    tier: initialTier,
    calls: 0,
    lastForceRefresh: undefined as boolean | undefined,
  };
  const transport = {
    getTier: (forceRefresh?: boolean) => {
      state.calls++;
      state.lastForceRefresh = forceRefresh;
      return Promise.resolve(state.tier);
    },
  } as unknown as PidgeonTransport;
  return { transport, state };
}

console.log("Running tier-cache tests...\n");

async function main(): Promise<void> {
  await test("repeated reads within the TTL hit the cache (one transport call)", async () => {
    const { transport, state } = makeTransport("free");
    const getTier = createTierResolver(transport, 60_000, () => 1_000);

    assert((await getTier()) === "free", "first read resolves");
    assert((await getTier()) === "free", "second read resolves");
    assert(state.calls === 1, `expected 1 transport call, got ${state.calls}`);
  });

  await test("TTL expiry re-resolves, so a routine upgrade surfaces within a minute", async () => {
    const { transport, state } = makeTransport("free");
    let clock = 0;
    const getTier = createTierResolver(transport, 60_000, () => clock);

    assert((await getTier()) === "free", "starts free");
    state.tier = "pro"; // upgrade lands server-side
    clock = 30_000;
    assert((await getTier()) === "free", "still cached inside the TTL");
    clock = 61_000;
    assert((await getTier()) === "pro", "re-resolved after TTL expiry");
    assert(state.calls === 2, `expected 2 transport calls, got ${state.calls}`);
  });

  await test("forceRefresh bypasses the cache and the transport's own cache", async () => {
    const { transport, state } = makeTransport("free");
    const getTier = createTierResolver(transport, 60_000, () => 1_000);

    assert((await getTier()) === "free", "starts free");
    state.tier = "pro"; // upgrade lands immediately before the user retries
    assert((await getTier(true)) === "pro", "forced refresh sees the upgrade");
    assert(
      state.lastForceRefresh === true,
      "forceRefresh must propagate to the transport so its own cache is bypassed too",
    );
  });

  await test("the MCP TTL is the one canonical 60s entitlement TTL (matches the Bridge resolver)", async () => {
    // WHY: the entitlement contract's freshness bound must be one value across
    // the C#/TS runtimes — if the MCP's 60s and the Bridge's 60s drift apart, the
    // two vectors disagree on how long a stale tier lingers and "a mid-session
    // upgrade unlocks within one TTL on every vector" breaks. No shared literal
    // exists across runtimes, so this pins the MCP side against a silent slide off
    // 60s; its C# twin (SubscriptionTierResolverTests) does the same for the Bridge.
    assert(TIER_TTL_MS === 60_000, `expected the canonical 60s TTL, got ${TIER_TTL_MS}ms`);
  });

  await test("the gate scenario: upgrade mid-session unlocks on retry, not on restart", async () => {
    // Mirrors the registerTools gate: read cached tier; if it fails the
    // requirement, force-refresh once and re-check.
    const { transport, state } = makeTransport("free");
    const getTier = createTierResolver(transport, 60_000, () => 1_000);

    let tier = await getTier();
    assert(tier === "free", "cached tier is stale-free");
    state.tier = "pro";
    if (tier !== "pro") tier = await getTier(true);
    assert(tier === "pro", "denial path re-resolved and unlocked the tool");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
