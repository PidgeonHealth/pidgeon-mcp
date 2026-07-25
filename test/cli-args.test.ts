#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CLI-transport argv contract tests: pin the EXACT argument arrays CliClient
 * builds against the real CLI grammar, and pin that failures surface as typed
 * errors instead of fabricated successes. This is the regression guard for the
 * drift class the ergonomics audit found (AGENT_API_ERGONOMICS_AUDIT §2.3):
 * `--output json` where the global flag is `--output-format`, the missing `-`
 * stdin sentinel on validate (which produced a false `✓ VALID` for any input),
 * and the false "De-identification Complete"/"Messages are identical" renders.
 *
 * Run: npx ts-node test/cli-args.test.ts
 */

import { promises as fs } from "fs";
import { CliClient, CliRunResult, CliRunner } from "../src/transport/cli";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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

function assertArgs(actual: string[], expected: string[]): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `argv mismatch:\n  actual:   ${a}\n  expected: ${e}`);
}

interface Capture {
  args: string[];
  stdin?: string;
}

function capturingRunner(
  captures: Capture[],
  respond: (args: string[]) => CliRunResult | Promise<CliRunResult>
): CliRunner {
  return async (_cliPath, args, stdin, _timeout) => {
    captures.push({ args, stdin });
    return respond(args);
  };
}

const ok = (stdout: string): CliRunResult => ({ stdout, stderr: "", code: 0 });

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // getTier — reads the license command's own --output json (not the global
  // flag); pinned so the deferred LicenseCommand --output cleanup can't
  // silently regress the tier read a paid CLI user depends on.
  // -------------------------------------------------------------------------
  await test("getTier builds `--quiet license status --output json` and reads the tier", async () => {
    const captures: Capture[] = [];
    const client = new CliClient(
      { cliPath: "pidgeon" },
      capturingRunner(captures, () => ok(JSON.stringify({ tier: "pro" })))
    );
    const tier = await client.getTier();
    assertArgs(captures[0].args, ["--quiet", "license", "status", "--output", "json"]);
    assert(tier === "pro", `expected pro, got ${tier}`);
  });

  // -------------------------------------------------------------------------
  // generate
  // -------------------------------------------------------------------------
  await test("generate builds --output-format json (not the --output FILE flag) and parses the envelope", async () => {
    const captures: Capture[] = [];
    const client = new CliClient(
      { cliPath: "pidgeon" },
      capturingRunner(captures, () =>
        ok(JSON.stringify({ standard: "hl7", messageType: "ADT^A01", messages: ["MSH|1", "MSH|2"] }))
      )
    );
    const result = await client.generate("ADT^A01", { count: 2, vendor: "epic", seed: 42 });
    // Globals BEFORE the subcommand: placed after it, open positionals bind
    // them as values (validate treated `--quiet` as a file to validate).
    assertArgs(captures[0].args, [
      "--output-format", "json", "--quiet", "generate", "ADT^A01",
      "--count", "2", "--vendor", "epic", "--seed", "42",
    ]);
    assert(result.messages.length === 2, "envelope messages must be returned");
  });

  await test("generate with unparseable stdout throws instead of returning an empty message", async () => {
    const client = new CliClient(
      { cliPath: "pidgeon" },
      capturingRunner([], () => ok("Generated 1 message"))
    );
    let threw = false;
    try {
      await client.generate("ADT^A01");
    } catch (err) {
      threw = true;
      assert(String(err).includes("unparseable"), `error must name the cause: ${err}`);
    }
    assert(threw, "must throw on unparseable output");
  });

  // -------------------------------------------------------------------------
  // validate — the false-VALID regression pin
  // -------------------------------------------------------------------------
  await test("validate uses stdin + JSON, capitalizes mode, and forwards standard/profile", async () => {
    const captures: Capture[] = [];
    const client = new CliClient(
      { cliPath: "pidgeon" },
      capturingRunner(captures, () =>
        ok(JSON.stringify({ isValid: false, issues: [{ location: "PID.3", severity: "Error", message: "missing", ruleId: "RC5" }], statistics: { conformanceScore: 60 } }))
      )
    );
    const result = await client.validate("MSH|...", {
      mode: "strict",
      standard: "hl7",
      vendorProfile: "epic",
    });
    assertArgs(captures[0].args, [
      "--output-format", "json", "--quiet", "validate", "-", "--mode", "Strict",
      "--standard", "hl7", "--profile", "epic",
    ]);
    assert(captures[0].stdin === "MSH|...", "the message must flow via stdin");
    assert(result.isValid === false, "the CLI verdict must carry through");
    assert(result.errors.length === 1 && result.errors[0].segment === "PID", "issues normalize via the shared normalizer");
  });

  await test("validate NEVER mints a verdict from unparseable output (the false-VALID bug)", async () => {
    const client = new CliClient(
      { cliPath: "pidgeon" },
      // The exact pre-repair failure shape: a parse error printed nothing to
      // stdout, and the old heuristic (!stdout.includes(\"error\")) said VALID.
      capturingRunner([], () => ok(""))
    );
    let threw = false;
    try {
      await client.validate("total garbage");
    } catch (err) {
      threw = true;
      assert(String(err).includes("unparseable"), `error must name the cause: ${err}`);
    }
    assert(threw, "unparseable validation output must throw, never report VALID");
  });

  await test("a nonzero CLI exit surfaces the CLI's stderr, never a fabricated result", async () => {
    const client = new CliClient(
      { cliPath: "pidgeon" },
      capturingRunner([], () => ({ stdout: "", stderr: "No files specified. Usage:", code: 1 }))
    );
    let threw = false;
    try {
      await client.validate("MSH|...");
    } catch (err) {
      threw = true;
      assert(String(err).includes("No files specified"), `the real CLI complaint must surface: ${err}`);
      assert(String(err).includes("exit 1"), "the exit code must surface");
    }
    assert(threw, "an unparseable nonzero exit must throw, never a fabricated result");
  });

  // -------------------------------------------------------------------------
  // deident — the false-Complete regression pin
  // -------------------------------------------------------------------------
  await test("deident round-trips through temp files and returns the engine's real output", async () => {
    const captures: Capture[] = [];
    const runner: CliRunner = async (_cli, args, stdin, _t) => {
      captures.push({ args, stdin });
      // Simulate the engine writing the de-identified output file. Find the out
      // path by content rather than a load-bearing positional index, so this
      // mock survives an argv layout change (the assertions below still pin it).
      const outPath = args.find((a) => a.includes("out.hl7"))!;
      await fs.writeFile(outPath, "MSH|deidentified", "utf8");
      return ok(JSON.stringify({ statistics: { fieldsModified: 5, datesShifted: 2 } }));
    };
    const client = new CliClient({ cliPath: "pidgeon" }, runner);
    const result = await client.deidentify("MSH|original|DOE^JOHN", { salt: "s1", dateShift: "30d" });

    const args = captures[0].args;
    assertArgs(args.slice(0, 3), ["--output-format", "json", "--quiet"]);
    assert(args[3] === "deident", "deident command after the globals");
    assert(args[4].includes("in.hl7") && args[5].includes("out.hl7"), "positional temp file paths");
    assertArgs(args.slice(6), ["--date-shift", "30d", "--salt", "s1"]);
    assert(result.deidentified === "MSH|deidentified", "content must be the engine's real file output");
    assert(result.fieldsModified === 5, "statistics carry through");
  });

  await test("deident propagates a CLI failure instead of reporting Complete with empty content", async () => {
    const client = new CliClient(
      { cliPath: "pidgeon" },
      capturingRunner([], () => ({ stdout: "", stderr: "Input path does not exist", code: 1 }))
    );
    let threw = false;
    try {
      await client.deidentify("MSH|original");
    } catch (err) {
      threw = true;
      assert(String(err).includes("Input path does not exist"), `real complaint must surface: ${err}`);
    }
    assert(threw, "deident failure must throw");
  });

  // -------------------------------------------------------------------------
  // conform — CI exit-code semantics
  // -------------------------------------------------------------------------
  await test("conform builds --output-format json and accepts a FAILED report on exit 1 (the CI contract)", async () => {
    const captures: Capture[] = [];
    const report = JSON.stringify({
      endpoint: "https://api.example/fhir",
      passed: false,
      issues: [{ severity: "Error", ruleId: "US-CORE-1", location: "Patient", message: "identifier required" }],
    });
    const client = new CliClient(
      { cliPath: "pidgeon" },
      capturingRunner(captures, () => ({ stdout: report, stderr: "", code: 1 }))
    );
    const result = await client.conform("https://api.example/fhir", {
      resource: "Patient/example",
      profile: "us-core-patient",
      ci: true,
    });
    assertArgs(captures[0].args, [
      "--output-format", "json", "--quiet", "conform", "--endpoint", "https://api.example/fhir",
      "--resource", "Patient/example", "--profile", "us-core-patient", "--ci",
    ]);
    assert(result.passed === false, "a failed report on exit 1 is a successful probe");
    assert(result.issues.length === 1, "issues normalize");
  });

  // -------------------------------------------------------------------------
  // data packages
  // -------------------------------------------------------------------------
  await test("data list builds --output-format json and maps rows to DataPackageInfo", async () => {
    const captures: Capture[] = [];
    const client = new CliClient(
      { cliPath: "pidgeon" },
      capturingRunner(captures, () =>
        ok(JSON.stringify([{ name: "loinc", dataType: "lab-codes", installed: true, recordCount: 108000, version: "2.77" }]))
      )
    );
    const result = await client.manageDataPackages({ action: "list" });
    assertArgs(captures[0].args, ["--output-format", "json", "--quiet", "data", "list"]);
    assert(Array.isArray(result) && result.length === 1, "one package row");
    const pkg = (result as { name: string; installed: boolean; recordCount?: string }[])[0];
    assert(pkg.name === "loinc" && pkg.installed === true && pkg.recordCount === "108000", "row maps through");
  });

  await test("data install passes the package positionally with --accept-license", async () => {
    const captures: Capture[] = [];
    const client = new CliClient(
      { cliPath: "pidgeon" },
      capturingRunner(captures, () => ok(""))
    );
    const msg = await client.manageDataPackages({ action: "install", packageName: "snomed", acceptLicense: true });
    assertArgs(captures[0].args, ["data", "install", "snomed", "--accept-license"]);
    assert(typeof msg === "string" && msg.includes("snomed"), "success message names the package");
  });

  // -------------------------------------------------------------------------
  // artifact discovery
  // -------------------------------------------------------------------------
  await test("searchArtifacts with terms builds `artifacts search` with every facet flag", async () => {
    const captures: Capture[] = [];
    const client = new CliClient(
      { cliPath: "pidgeon" },
      capturingRunner(captures, () =>
        ok(JSON.stringify({ query: "epic adt", total: 1, truncated: false, items: [{ name: "epic-adt-a01" }] }))
      )
    );
    const result = await client.searchArtifacts({
      query: "epic adt",
      kind: "vendor-profile",
      vendor: "epic",
      standard: "hl7",
      messageType: "ADT^A01",
      installedOnly: true,
      limit: 5,
    });
    assertArgs(captures[0].args, [
      "--output-format", "json", "--quiet", "artifacts", "search", "epic", "adt",
      "--kind", "vendor-profile", "--vendor", "epic", "--standard", "hl7",
      "--message-type", "ADT^A01", "--installed", "--limit", "5",
    ]);
    assert(result.total === 1 && result.items.length === 1, "envelope maps through");
    assert(result.items[0].name === "epic-adt-a01", "item rows pass through unchanged");
  });

  await test("searchArtifacts without terms builds `artifacts list` (the empty-query listing)", async () => {
    const captures: Capture[] = [];
    const client = new CliClient(
      { cliPath: "pidgeon" },
      capturingRunner(captures, () => ok(JSON.stringify({ query: null, total: 0, truncated: false, items: [] })))
    );
    const result = await client.searchArtifacts({ kind: "data-package" });
    assertArgs(captures[0].args, [
      "--output-format", "json", "--quiet", "artifacts", "list", "--kind", "data-package",
    ]);
    assert(result.total === 0 && result.items.length === 0, "an empty catalog is a normal result");
  });

  // -------------------------------------------------------------------------
  // Unsupported-in-CLI-mode operations: typed errors, never empty successes
  // -------------------------------------------------------------------------
  await test("diff/send/loft/analyze/workflow are typed bridge-mode errors, never empty successes", async () => {
    const client = new CliClient({ cliPath: "pidgeon" }, capturingRunner([], () => ok("")));
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["diff", () => client.diff("a", "b")],
      ["send", () => client.sendMessage("MSH|...", "/pickup")],
      ["loft", () => client.loftStatus()],
      ["analyze", () => client.analyzeVendorPattern(["MSH|..."])],
      ["workflow", () => client.runWorkflow("admission-with-labs")],
    ];
    for (const [name, call] of cases) {
      let threw = false;
      try {
        await call();
      } catch (err) {
        threw = true;
        assert(String(err).includes("PIDGEON_MODE=bridge"), `${name}: the error must name the Bridge-mode fix: ${err}`);
      }
      assert(threw, `${name} must throw a typed unsupported error in CLI mode`);
    }
  });

  console.log(`\ncli-args: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
