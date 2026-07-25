#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * H-29 guard: no code path derives agent memory from message content.
 *
 * Pidgeon's memory model (AGENTIC_HARNESS_STANDARD.md §4.3) writes memory ONLY
 * by explicit named actions (config analyze --save, session save, pin,
 * `pidgeon ai configure`). It builds NO background-derived memory: no
 * auto-harvested preferences, no message content persisted as ambient context,
 * no usage-profile injection. This is stricter than the labs by design —
 * auto-derivation from healthcare traffic is exactly what the no-PHI posture and
 * the VIN consent gate forbid until the legal pass clears.
 *
 * This is a structural / grep-level guard over the MCP read-surface source. It
 * fails the moment someone adds a content-derived-memory shape, so the invariant
 * trips here — on the contract — rather than shipping silently.
 *
 * Note on the boundary: this bans the AUTOMATIC-derivation vocabulary, never the
 * explicit `save` action, which H-29 permits (analyze_vendor_pattern --save is a
 * user-invoked write, not background harvesting).
 *
 * Run: npx ts-node test/no-derived-memory.test.ts
 */

import { readdirSync, readFileSync, statSync } from "fs";
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
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

const SRC_DIR = join(__dirname, "..", "src");

function allTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Compound identifiers that would signal message content being turned into
// durable agent memory. Deliberately specific (not the bare words "memory" or
// "derive", which appear legitimately — "in-memory diff", "derives it from
// TOOL_CATALOG") so the guard flags the forbidden CONCEPT, not innocent prose.
const BANNED_DERIVATION_TOKENS = [
  "harvest",              // auto-harvested preferences / templates
  "autoderive",
  "auto-derive",
  "derivememory",
  "derivedmemory",
  "ambientmemory",
  "ambientcontext",
  "usageprofile",
  "inferpreference",
  "learnpreference",
  "rememberfrom",
  "rememberpreference",
  "memoryfrommessage",
  "messagememory",
  "contentderived",
  "content-derived",
  "persistcontent",
];

// The workspace-fact read surface: these files only READ facts and label their
// provenance — they must never persist. Write/egress verbs are banned here.
const READ_SURFACE_FILES = [
  join(SRC_DIR, "resources", "session.ts"),
  join(SRC_DIR, "resources", "vendors.ts"),
  join(SRC_DIR, "resources", "provenance.ts"),
];
const WRITE_VERBS = ["writefile", "appendfile", ".post(", ".put(", ".patch(", "setitem", "localstorage"];

// The workspace-fact read methods retrieve state; they must not ingest message
// content (no `message`/`content` parameter). Retrieval is state-read, not
// content-ingestion (H-30).
const READ_METHOD_SIGNATURES = [
  "getScope",
  "listLockSessions",
  "listVendorProfiles",
  "getAiModelStatus",
];

function main(): void {
  console.log("Running no-derived-memory guard...\n");

  const files = allTsFiles(SRC_DIR);

  test(`scans a non-trivial MCP source tree (${files.length} files)`, () => {
    if (files.length < 10) throw new Error(`expected to scan the src tree, found only ${files.length} files`);
  });

  test("no source file uses a content-derived-memory identifier (H-29)", () => {
    const hits: string[] = [];
    for (const file of files) {
      const lower = readFileSync(file, "utf8").toLowerCase();
      for (const token of BANNED_DERIVATION_TOKENS) {
        if (lower.includes(token)) hits.push(`${file}: '${token}'`);
      }
    }
    if (hits.length > 0) {
      throw new Error(
        "Found content-derived-memory shapes — Pidgeon builds no background-derived memory (H-29):\n  " +
          hits.join("\n  ")
      );
    }
  });

  test("the workspace-fact read surface never persists (no write/egress verbs)", () => {
    const hits: string[] = [];
    for (const file of READ_SURFACE_FILES) {
      const lower = readFileSync(file, "utf8").toLowerCase();
      for (const verb of WRITE_VERBS) {
        if (lower.includes(verb)) hits.push(`${file}: '${verb}'`);
      }
    }
    if (hits.length > 0) {
      throw new Error(
        "A memory read-surface file contains a write/egress verb — reads must not persist:\n  " + hits.join("\n  ")
      );
    }
  });

  test("workspace-fact read methods take no message/content parameter (H-30)", () => {
    const typesSrc = readFileSync(join(SRC_DIR, "transport", "types.ts"), "utf8");
    const hits: string[] = [];
    for (const method of READ_METHOD_SIGNATURES) {
      // Match the interface declaration: methodName( ...params... ):
      const re = new RegExp(`${method}\\s*\\(([^)]*)\\)\\s*:`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(typesSrc)) !== null) {
        const params = m[1].toLowerCase();
        if (params.includes("message") || params.includes("content")) {
          hits.push(`${method}(${m[1].trim()})`);
        }
      }
    }
    if (hits.length > 0) {
      throw new Error(
        "A workspace-fact read method ingests message content — retrieval is a state-read, not content-ingestion:\n  " +
          hits.join("\n  ")
      );
    }
  });

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main();
