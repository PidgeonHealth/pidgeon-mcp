#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Agent memory read-surface (H-29..H-32): workspace facts reachable with uniform
 * "which substrate answered" provenance and a point-in-time staleness signal.
 *
 * Covers the vendor-profiles resource (Bridge-loaded profiles vs embedded
 * fallback) and the session resource (scope / saved pins / AI status), asserting
 * each answer names its substrate (H-32), carries a staleness contract (H-31),
 * and never leaks message content (H-29/H-33).
 *
 * Run: npx ts-node test/workspace-facts.test.ts
 */

import { createVendorsResource } from "../src/resources/vendors";
import { createSessionResource } from "../src/resources/session";
import { PidgeonTransport, VendorProfileInfo, ScopeInfo, LockSessionInfo, AiModelStatus } from "../src/transport/index";

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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertContains(text: string, needle: string): void {
  if (!text.includes(needle)) throw new Error(`expected output to contain "${needle}"\n--- got ---\n${text.slice(0, 800)}`);
}

function assertNotContains(text: string, needle: string): void {
  if (text.includes(needle)) throw new Error(`expected output NOT to contain "${needle}"\n--- got ---\n${text.slice(0, 800)}`);
}

const EPIC_PROFILE: VendorProfileInfo = {
  key: "epic/adt_outbound",
  vendor: "epic",
  interfaceName: "adt_outbound",
  standard: "hl7",
  version: "2.5.1",
  direction: "outbound",
  messageTypes: ["ADT^A01"],
  marketCategory: "Tier1",
};

// A running Bridge whose vendor-profiles read surface returns loaded profiles.
function bridgeVendorTransport(profiles: VendorProfileInfo[] = [EPIC_PROFILE]): PidgeonTransport {
  return {
    async listVendorProfiles(): Promise<VendorProfileInfo[]> {
      return profiles;
    },
  } as unknown as PidgeonTransport;
}

// A transport where the vendor-profiles read throws (Bridge down / CLI mode).
function noBridgeVendorTransport(): PidgeonTransport {
  return {
    async listVendorProfiles(): Promise<VendorProfileInfo[]> {
      throw new Error("no bridge");
    },
  } as unknown as PidgeonTransport;
}

// A Bridge with live session context (scope + saved pins + on-device model).
function bridgeSessionTransport(): PidgeonTransport {
  return {
    getMode: () => "bridge",
    async getScope(): Promise<ScopeInfo> {
      return {
        available: true,
        memberships: [
          { organizationId: "org_1", organizationName: "Fusion Health", tier: "pro", facilities: [{ id: "fac_1", name: "FCH Main", kind: "hospital" }] },
        ],
        defaultFacilityId: "fac_1",
        lastProduct: "post",
      };
    },
    async listLockSessions(): Promise<LockSessionInfo[]> {
      return [
        { name: "demo-patient", scope: "Custom", description: "Pinned demo patient", lockedValues: { "PID.5": "DOE^JOHN" }, createdAt: "2026-07-01T00:00:00Z" },
      ];
    },
    async getAiModelStatus(): Promise<AiModelStatus> {
      return { available: true, ollamaAvailable: true, pulledTags: ["qwen3:4b"], ready: true };
    },
  } as unknown as PidgeonTransport;
}

// CLI-mode / unauthenticated: every session read is an unavailable sentinel.
function emptySessionTransport(): PidgeonTransport {
  return {
    getMode: () => "cli",
    async getScope(): Promise<ScopeInfo> { return { available: false, memberships: [] }; },
    async listLockSessions(): Promise<LockSessionInfo[]> { return []; },
    async getAiModelStatus(): Promise<AiModelStatus> { return { available: false, ollamaAvailable: false, pulledTags: [], ready: false }; },
  } as unknown as PidgeonTransport;
}

async function main() {
  console.log("Running workspace-facts read-surface tests...\n");

  // ---- Vendor profiles: Bridge path with provenance + staleness ----
  await test("vendors resource labels the Bridge substrate and stamps staleness (H-31/H-32)", async () => {
    const res = createVendorsResource();
    const result = await res.handler(bridgeVendorTransport(), {});
    const text = result.contents[0].text;
    const body = JSON.parse(text);
    assert(body.source === "bridge", `expected source 'bridge', got '${body.source}'`);
    assertContains(text, "Pidgeon Bridge (live workspace store");
    assert(typeof body.retrievedAt === "string" && body.retrievedAt.length > 0, "expected a retrievedAt timestamp");
    assertContains(text, "Point-in-time claim");
    assertContains(text, "static"); // vendor-profile-specific staleness addendum
    assert(Array.isArray(body.profiles) && body.profiles[0].key === "epic/adt_outbound", "expected the loaded profiles");
  });

  await test("vendors Bridge answer is metadata only — no sample message body (H-29/H-33)", async () => {
    const res = createVendorsResource();
    const result = await res.handler(bridgeVendorTransport(), {});
    const text = result.contents[0].text;
    // The read surface carries profile metadata, never message content.
    assertNotContains(text, "MSH|");
  });

  await test("vendors resource falls back to embedded with 'embedded' provenance when the Bridge is down", async () => {
    const res = createVendorsResource();
    const result = await res.handler(noBridgeVendorTransport(), {});
    const text = result.contents[0].text;
    const body = JSON.parse(text);
    assert(body.source === "embedded", `expected source 'embedded', got '${body.source}'`);
    assertContains(text, "offline fallback");
    assertContains(text, "Point-in-time claim");
    assert(Array.isArray(body.vendors) && body.vendors.some((v: { name: string }) => v.name === "epic"), "expected the embedded catalog");
  });

  await test("vendors resource does not render an empty Bridge result — it falls back to embedded", async () => {
    const res = createVendorsResource();
    const result = await res.handler(bridgeVendorTransport([]), {});
    const body = JSON.parse(result.contents[0].text);
    assert(body.source === "embedded", `an empty Bridge listing must fall back to embedded, got source '${body.source}'`);
  });

  // ---- Session: provenance + staleness on scope / pins / AI ----
  await test("session resource stamps top-level provenance + staleness from the Bridge", async () => {
    const res = createSessionResource();
    const result = await res.handler(bridgeSessionTransport(), {});
    const text = result.contents[0].text;
    const body = JSON.parse(text);
    assert(body.source === "bridge", `expected source 'bridge', got '${body.source}'`);
    assert(typeof body.retrievedAt === "string" && body.retrievedAt.length > 0, "expected a retrievedAt timestamp");
    assertContains(text, "Point-in-time claim");
  });

  await test("session pins carry a per-block substrate label and a re-verify-before-write staleness note", async () => {
    const res = createSessionResource();
    const result = await res.handler(bridgeSessionTransport(), {});
    const body = JSON.parse(result.contents[0].text);
    assert(body.lockSessions.source === "bridge", `expected pins source 'bridge', got '${body.lockSessions.source}'`);
    assert(typeof body.lockSessions.staleness === "string" && body.lockSessions.staleness.includes("re-verify"), "expected a pins staleness note");
    assert(body.scope.source === "bridge", "expected scope source 'bridge'");
    assert(body.ai.source === "bridge", "expected ai source 'bridge'");
  });

  await test("session resource marks the substrate 'unavailable' when no Bridge context is present", async () => {
    const res = createSessionResource();
    const result = await res.handler(emptySessionTransport(), {});
    const text = result.contents[0].text;
    const body = JSON.parse(text);
    assert(body.source === "unavailable", `expected source 'unavailable', got '${body.source}'`);
    assertContains(text, "Bridge mode");
  });

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main();
