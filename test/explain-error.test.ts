#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for explain_error's on-device narration seam.
 *
 * Why this matters: narration is an optional, on-device-only layer on top of the
 * deterministic procedural triage. The contract is that the tool returns the
 * SAME triage with zero model present — narration only rewords the Fix when a
 * local model is ready. These tests pin three invariants an agent depends on:
 *   1. no model ready  → output is byte-identical to the procedural triage
 *   2. model ready      → the Fix line carries the model's reworded text
 *   3. narrate throws   → the tool falls back to the procedural Fix, never crashes
 */
import { createExplainErrorTool } from "../src/tools/explain-error";
import { AiModelStatus, NarrationRequest, NarrationResult } from "../src/transport/types";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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

// A minimal transport stub — explain_error only touches getAiModelStatus and
// narrate on the findings path (validate is never called when findings given).
function makeTransport(opts: {
  ready: boolean;
  narrate?: (req: NarrationRequest) => Promise<NarrationResult | null>;
  onNarrate?: () => void;
  stallStatus?: boolean;
}) {
  return {
    async getAiModelStatus(): Promise<AiModelStatus> {
      // Simulate a Bridge/Ollama probe that never answers (the hang the timeout guards).
      if (opts.stallStatus) return new Promise<AiModelStatus>(() => {});
      return { available: opts.ready, ollamaAvailable: opts.ready, pulledTags: opts.ready ? ["qwen3:4b"] : [], ready: opts.ready };
    },
    async narrate(req: NarrationRequest): Promise<NarrationResult | null> {
      opts.onNarrate?.();
      return opts.narrate ? opts.narrate(req) : null;
    },
  } as any;
}

const FINDINGS = [{ message: "PID.3 patient identifier is required but missing", severity: "error" as const }];

async function runTool(transport: unknown, args: Record<string, unknown>): Promise<string> {
  const tool = createExplainErrorTool();
  const result = await tool.handler(transport as never, args);
  return result.content[0].text;
}

async function main() {
  console.log("Running explain_error narration tests...\n");

  await test("explain_error stays a free-tier tool", () => {
    assert(createExplainErrorTool().requiredTier === "free", "explain_error must remain free");
  });

  await test("no on-device model → output is identical to forced-procedural", async () => {
    const notReady = await runTool(makeTransport({ ready: false }), { findings: FINDINGS });
    const forcedProcedural = await runTool(makeTransport({ ready: true }), { findings: FINDINGS, narrate: false });
    assert(notReady === forcedProcedural, "an absent model must yield the procedural triage verbatim");
    assert(notReady.includes("- Fix: Populate PID.3"), "procedural fix should be present");
  });

  await test("narrate=false never calls the narrator even when a model is ready", async () => {
    let called = false;
    const text = await runTool(
      makeTransport({ ready: true, onNarrate: () => (called = true) }),
      { findings: FINDINGS, narrate: false }
    );
    assert(!called, "narrate:false must skip the on-device call");
    assert(text.includes("- Fix: Populate PID.3"), "procedural fix should be present");
  });

  await test("model ready → the Fix line carries the reworded narration", async () => {
    const narratedFix = "Set PID.3 to the patient's MRN, e.g. PID|||MRN123^^^HOSP^MR, before sending.";
    const text = await runTool(
      makeTransport({ ready: true, narrate: async () => ({ narratedFix }) }),
      { findings: FINDINGS }
    );
    assert(text.includes(`- Fix: ${narratedFix}`), "the narrated fix should replace the procedural fix");
    assert(!text.includes("- Fix: Populate PID.3"), "the procedural fix should not also appear");
    // What/Why are the procedural contract and must be unchanged.
    assert(text.includes("- What: "), "What line should remain");
    assert(text.includes("- Why: "), "Why line should remain");
  });

  await test("narrate returning null → procedural fix is kept", async () => {
    const text = await runTool(makeTransport({ ready: true, narrate: async () => null }), { findings: FINDINGS });
    assert(text.includes("- Fix: Populate PID.3"), "a null narration must fall back to procedural");
  });

  await test("narrate throwing → tool degrades to procedural, never crashes", async () => {
    const text = await runTool(
      makeTransport({ ready: true, narrate: async () => { throw new Error("ollama died mid-stream"); } }),
      { findings: FINDINGS }
    );
    assert(text.includes("- Fix: Populate PID.3"), "a thrown narration must fall back to procedural");
  });

  await test("stalled readiness probe → tool degrades to procedural within the timeout, never hangs", async () => {
    const started = Date.now();
    const text = await runTool(makeTransport({ ready: true, stallStatus: true }), { findings: FINDINGS });
    const elapsed = Date.now() - started;
    // The 1500ms probe timeout must fire; a regression to Promise.all/no-timeout hangs forever.
    assert(elapsed < 5000, `explain_error must not hang on a stalled probe (took ${elapsed}ms)`);
    assert(text.includes("- Fix: Populate PID.3"), "a stalled probe must fall back to procedural");
  });

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main();
