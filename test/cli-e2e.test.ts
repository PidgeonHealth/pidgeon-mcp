#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CLI-transport end-to-end test: spawns the REAL pidgeon CLI through CliClient
 * for the free showcase loop (generate → validate → deident), proving the
 * repaired invocations against the actual command grammar — the layer the
 * mocked argv tests (cli-args.test.ts) cannot see.
 *
 * Env-gated like the repo's Docker/LiveOllama suites: set PIDGEON_CLI_E2E=1 to
 * run; otherwise it prints a skip and exits 0 so `npm test` stays green on
 * boxes without a built CLI. The CLI binary resolves from PIDGEON_CLI_PATH or
 * the repo Debug build (pidgeon-cli/src/Pidgeon.CLI/bin/Debug/Pidgeon.CLI.exe).
 *
 * Run: PIDGEON_CLI_E2E=1 npx ts-node test/cli-e2e.test.ts
 */

import { existsSync } from "fs";
import * as path from "path";
import { CliClient } from "../src/transport/cli";

function resolveCliPath(): string | null {
  const fromEnv = process.env["PIDGEON_CLI_PATH"];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const repoDebug = path.resolve(
    __dirname,
    "..",
    "..",
    "pidgeon-cli",
    "src",
    "Pidgeon.CLI",
    "bin",
    "Debug",
    process.platform === "win32" ? "Pidgeon.CLI.exe" : "Pidgeon.CLI"
  );
  return existsSync(repoDebug) ? repoDebug : null;
}

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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  if (process.env["PIDGEON_CLI_E2E"] !== "1") {
    console.log("cli-e2e: skipped (set PIDGEON_CLI_E2E=1 with a built CLI to run)");
    return;
  }

  const cliPath = resolveCliPath();
  if (!cliPath) {
    console.error("cli-e2e: PIDGEON_CLI_E2E=1 but no CLI binary found (set PIDGEON_CLI_PATH or build the sln)");
    process.exit(1);
  }

  console.log(`cli-e2e: driving ${cliPath}`);
  const client = new CliClient({ cliPath, timeout: 120000 });

  let generated = "";

  await test("generate returns real HL7 through the JSON envelope", async () => {
    const { messages } = await client.generate("ADT^A01", { count: 1, seed: 1234 });
    assert(messages.length === 1, `expected 1 message, got ${messages.length}`);
    assert(messages[0].startsWith("MSH|"), `expected HL7 content, got: ${messages[0].slice(0, 60)}`);
    generated = messages[0];
  });

  await test("validate accepts a real message via stdin and returns a real verdict", async () => {
    const result = await client.validate(generated, {
      mode: "compatibility",
      vendorProfile: "generic",
    });
    assert(typeof result.isValid === "boolean", "isValid must be a boolean verdict");
    assert(Array.isArray(result.errors) && Array.isArray(result.warnings), "normalized arrays present");
  });

  await test("validate REJECTS garbage instead of reporting VALID (the false-VALID regression)", async () => {
    let outcome: "throw" | { isValid: boolean } = "throw";
    try {
      outcome = await client.validate("this is not an HL7 message at all", { mode: "strict" });
    } catch {
      outcome = "throw";
    }
    // Either the CLI reports it invalid, or the transport throws a typed
    // error — what must NEVER happen is a VALID verdict.
    if (outcome !== "throw") {
      assert(outcome.isValid === false, "garbage must not validate as VALID");
    }
  });

  await test("deident round-trips a real message and strips the patient name", async () => {
    const withPhi =
      "MSH|^~\\&|SENDER|FAC|RECV|FAC|20260101120000||ADT^A01|MSG1|P|2.5.1\r" +
      "PID|1||MRN123^^^FAC^MR||DOE^JOHN||19800101|M";
    const result = await client.deidentify(withPhi, { salt: "e2e-salt" });
    assert(result.deidentified.startsWith("MSH|"), "structure survives");
    assert(!result.deidentified.includes("DOE^JOHN"), "PHI name must be stripped");
  });

  await test("data-package list returns the real public catalog", async () => {
    const packages = await client.manageDataPackages({ action: "list" });
    if (!Array.isArray(packages)) throw new Error("list must return package rows");
    assert(
      packages.some((item) => item.name === "fhir-davinci-crd-2.1"),
      "public FHIR package must be listed"
    );
  });

  await test("artifact search returns the package-backed community catalog", async () => {
    const result = await client.searchArtifacts({
      query: "davinci",
      kind: "data-package",
      limit: 10,
    });
    assert(result.total > 0, "expected at least one Da Vinci artifact");
    assert(
      result.items.every((item) => item.kind === "data-package"),
      "community results stay package-backed"
    );
  });

  console.log(`\ncli-e2e: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
