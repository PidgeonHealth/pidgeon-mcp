#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Containment recurrence guard for the immutable @pidgeonhealth/mcp 0.2.0 vector.
 *
 * Why this matters: 0.2.0 is a public-registry containment case (see
 * the 0.2.0 containment receipt). The published artifact
 * carried a client-side entitlement gate with a demo bypass and shipped from a
 * personal npm account with no public source repo. The repaired successor is
 * built by PREP-PUBLIC-MCP; until then the monorepo source must not be able to
 * re-publish this vector. These assertions fail the build if the source-side
 * containment applied by publishing governance is silently removed.
 *
 * Fix on failure: do NOT weaken this test. The monorepo package must stay
 * unpublishable; publish only from the verified public mirror (D-door flow).
 */
import { readFileSync } from "fs";
import { resolve } from "path";

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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
const isPublicMirror = pkg.pidgeonPublicMirror === true;

console.log("MCP 0.2.0 containment recurrence guard\n");

test("package publication posture matches its source boundary", () => {
  if (isPublicMirror) {
    assert(pkg.private !== true, "the verified public mirror package must be publishable");
    assert(
      pkg.publishConfig?.access === "public",
      `the public mirror must declare public access, got ${JSON.stringify(pkg.publishConfig)}`
    );
    return;
  }
  assert(pkg.private === true, `monorepo package.json "private" must be true, got ${JSON.stringify(pkg.private)}`);
});

test("prepublishOnly matches the private containment or public verification posture", () => {
  const guard: string = pkg.scripts?.prepublishOnly ?? "";
  if (isPublicMirror) {
    assert(guard === "npm test", `public mirror prepublishOnly must run the full test gate; got: ${JSON.stringify(guard)}`);
    return;
  }
  assert(/process\.exit\(1\)/.test(guard), `prepublishOnly must abort publish (process.exit(1)); got: ${JSON.stringify(guard)}`);
  assert(guard !== "npm run build", "prepublishOnly must not be the 0.2.0 'npm run build' step that allowed publish");
});

test("only the verified public mirror points at the public registry", () => {
  if (isPublicMirror) {
    assert(pkg.publishConfig?.access === "public", "the public mirror must publish with public access");
    return;
  }
  assert(pkg.publishConfig === undefined, `publishConfig must be absent in the monorepo; got ${JSON.stringify(pkg.publishConfig)}`);
});

test("demo-mode bypass test is not wired into the publish/test path", () => {
  const t: string = pkg.scripts?.test ?? "";
  assert(!/demo-mode\.test/.test(t), "the 0.2.0 demo-mode entitlement-bypass test must not be re-introduced into the test script");
});

// ---------------------------------------------------------------------------
// Successor-source guards (PREP-PUBLIC-MCP): the 0.2.0 findings the repaired
// composition must not inherit (containment packet §4/§5, R2–R5). These read
// the adapter's own source tree, so they hold identically in the projected
// public repository.
// ---------------------------------------------------------------------------

import { readdirSync, statSync } from "fs";
import { join } from "path";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const SRC = resolve(__dirname, "..", "src");
const allSource = sourceFiles(SRC).map((f) => ({ path: f, text: readFileSync(f, "utf8") }));

test("no source-tree Bridge bootstrap remains (F5/R4): no auto-start, no monorepo project probe", () => {
  for (const f of allSource) {
    assert(!/tryAutoStartBridge|findBridgeProject|BRIDGE_PROJECT_CANDIDATES/.test(f.text),
      `Bridge auto-start residue in ${f.path}`);
    assert(!/dotnet run --project/.test(f.text),
      `monorepo 'dotnet run --project' guidance in ${f.path} — the public package must not instruct source-tree Bridge startup`);
  }
});

test("no process primitives outside the sanctioned files (the adapter never starts a Bridge)", () => {
  // transport/cli.ts execFiles the pidgeon CLI (the transport itself);
  // tools/status.ts execFiles read-only `--version` diagnostics. Nothing else
  // may touch child_process, and nothing anywhere may detach a process — the
  // 0.2.0 bootstrap spawned the Bridge detached from monorepo paths.
  const sanctioned = [join("transport", "cli.ts"), join("tools", "status.ts")];
  for (const f of allSource) {
    assert(!/detached\s*:\s*true/.test(f.text), `detached process spawn in ${f.path}`);
    if (sanctioned.some((s) => f.path.endsWith(s))) continue;
    assert(!/child_process/.test(f.text), `child_process usage outside the sanctioned files: ${f.path}`);
  }
});

test("no demo entitlement bypass remains in source (F3/R3)", () => {
  for (const f of allSource) {
    assert(!/PIDGEON_DEMO_MODE|isDemoMode/.test(f.text), `demo-mode bypass residue in ${f.path}`);
  }
});

test("npm package inventory is the exact allowlist (R5): dist + README + LICENSE only", () => {
  assert(Array.isArray(pkg.files), "package.json must carry a files allowlist");
  const files = [...(pkg.files as string[])].sort();
  const expected = ["LICENSE", "README.md", "dist"].sort();
  assert(
    files.length === expected.length && files.every((v, i) => v === expected[i]),
    `package files allowlist must be exactly [dist, README.md, LICENSE]; got [${files.join(", ")}]`
  );
});

test("candidate uses the clean public package identity and 0.1.0 beta line", () => {
  assert(
    pkg.name === "@pidgeonhealth/pidgeon-mcp",
    `expected @pidgeonhealth/pidgeon-mcp, got ${pkg.name}`
  );
  assert(pkg.version === "0.1.0-beta.1", `expected version 0.1.0-beta.1, got ${pkg.version}`);
});

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) process.exit(1);
