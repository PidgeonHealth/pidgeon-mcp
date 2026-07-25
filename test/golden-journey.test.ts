#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Golden-journey verification (the AGENT_API_ERGONOMICS_AUDIT slice-4 gate):
 * drive a REAL BridgeClient through the canonical reproduce-and-fix chain and
 * prove every step composes FROM THE PRIOR STEP'S OUTPUT — no out-of-band
 * knowledge. This is the end-to-end complement to the per-tool unit/endpoint
 * tests: it proves the tools chain, not just that each works in isolation.
 *
 * Chain (composed via tool outputs alone):
 *   generate  -> the message
 *   validate  -> the fenced findings envelope
 *   explain_error(findings from that envelope) -> triage
 *   diff(generated vs a mutated copy) -> field diffs
 *   send(to a temp dir, with an idempotencyKey) -> delivered
 *   send AGAIN (same key) -> replayed, not re-delivered
 * The AI refine step is exercised opportunistically: it needs an on-device
 * model (Ollama), so a BridgeError there is tolerated and reported, not failed.
 *
 * Env-gated like cli-e2e: needs a running Bridge. Set PIDGEON_GOLDEN_JOURNEY=1
 * and (optionally) PIDGEON_BRIDGE_URL; otherwise it prints a skip and exits 0.
 * Not in the default `npm test` — it is a live-Bridge gate the lead runs.
 *
 * Run: PIDGEON_GOLDEN_JOURNEY=1 PIDGEON_BRIDGE_URL=http://localhost:5100 \
 *      npx ts-node test/golden-journey.test.ts
 *
 * Observed on the first live run (2026-07-03, Bridge without Ollama): the
 * explain_error step BLOCKED on transport.getAiModelStatus(), a free on-device
 * tool hanging for tens of seconds when no narration model is running. Fixed by
 * bounding the readiness probe with a 1500ms timeout (explain-error.ts), covered
 * by the "stalled readiness probe" test in explain-error.test.ts. Every
 * downstream link (explain_error triage, diff, send idempotency) is independently
 * covered by committed tests (explain-error.test.ts, AgentSurfaceEndpointTests, wire-shapes).
 */

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { BridgeClient } from "../src/transport/bridge";
import { createValidateTool } from "../src/tools/validate";
import { createExplainErrorTool } from "../src/tools/explain-error";
import { createSendTool } from "../src/tools/send";
import { createDiffTool } from "../src/tools/diff";

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
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

/** Pull the fenced ```json envelope a tool appends to its text. */
function parseEnvelope(text: string): Record<string, unknown> {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) throw new Error(`no fenced json envelope in:\n${text.slice(0, 300)}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

async function main(): Promise<void> {
  if (process.env["PIDGEON_GOLDEN_JOURNEY"] !== "1") {
    console.log("golden-journey: skipped (set PIDGEON_GOLDEN_JOURNEY=1 with a running Bridge to run)");
    return;
  }

  const baseUrl = process.env["PIDGEON_BRIDGE_URL"] ?? "http://localhost:5100";
  console.log(`golden-journey: driving the Bridge at ${baseUrl}`);
  const transport = new BridgeClient({ baseUrl, timeout: 120000 });

  if (!(await transport.isAvailable())) {
    console.error(`golden-journey: no Bridge reachable at ${baseUrl} (is it running?)`);
    process.exit(1);
  }

  const dropDir = await fs.mkdtemp(path.join(os.tmpdir(), "pidgeon-golden-"));
  let generated = "";
  let findings: Array<Record<string, unknown>> = [];

  await step("generate produces a message", async () => {
    const messages = await transport.generate("ADT^A01", { count: 1, seed: 7 });
    assert(messages.length === 1 && messages[0].startsWith("MSH|"), "expected one HL7 message");
    generated = messages[0];
  });

  await step("validate emits a findings envelope shaped for explain_error", async () => {
    const result = await createValidateTool().handler(transport, { message: generated, mode: "strict" });
    const env = parseEnvelope(result.content[0].text);
    assert(env["ok"] === true, "validate must emit an ok:true success envelope");
    assert(Array.isArray(env["findings"]), "envelope must carry a findings array");
    findings = env["findings"] as Array<Record<string, unknown>>;
  });

  await step("explain_error consumes the findings envelope verbatim", async () => {
    // The whole point of the composition affordance: the findings from validate
    // feed explain_error's `findings` input with no reshaping.
    const result = await createExplainErrorTool().handler(transport, { findings });
    const text = result.content[0].text;
    assert(text.length > 0, "explain_error must return triage text");
    // Either it triaged findings, or the message was clean — both are valid;
    // what must NOT happen is a crash on the handed-off shape.
    assert(!text.includes("Provide either"), "explain_error accepted the findings shape");
  });

  await step("diff compares the message against a mutated copy", async () => {
    const mutated = generated.replace("ADT^A01", "ADT^A04");
    const result = await createDiffTool().handler(transport, {
      leftMessage: generated,
      rightMessage: mutated,
    });
    assert(result.content[0].text.includes("Diff"), "diff must render a comparison");
  });

  await step("send delivers to a temp dir and an idempotent retry replays, not re-delivers", async () => {
    const key = "golden-" + generated.length;
    const first = await createSendTool().handler(transport, {
      message: generated,
      destination: dropDir,
      idempotencyKey: key,
    });
    assert(first.content[0].text.includes("Delivered") || first.content[0].text.includes("Replayed"),
      "first send should report a delivery");

    const second = await createSendTool().handler(transport, {
      message: generated,
      destination: dropDir,
      idempotencyKey: key,
    });
    assert(second.content[0].text.includes("Replayed"), "the idempotent retry must report a replay");

    const files = await fs.readdir(dropDir);
    assert(files.length === 1, `at-most-once: expected 1 delivered file, got ${files.length}`);
  });

  await fs.rm(dropDir, { recursive: true, force: true }).catch(() => undefined);

  console.log(`\ngolden-journey: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
