#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the per-tool usage instrumentation (AGENTIC_HARNESS_STANDARD.md §5.3).
 *
 * Why this matters: these counters turn tool placement into a refutable
 * prediction. The load-bearing properties are (1) outcomes are classified so
 * first-call argument errors are distinguishable from policy denials, (2) a
 * describe_tool(name=X) yields the describe→call linkage event, and (3) the events
 * carry enumerated dimensions ONLY — never argument values or message content.
 */
import { z } from "zod";
import {
  classifyErrorOutcome,
  classifyResultOutcome,
  deriveToolEvents,
  emitToolUsage,
  newSessionId,
} from "../src/tools/usage-instrumentation";
import { TierError } from "../src/transport/types";
import { ThrottleError, BridgeError } from "../src/transport/errors";
import type { PidgeonTransport, ToolUsageEvent } from "../src/transport";
import type { ToolResult } from "../src/tools/format";

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

function successResult(): ToolResult {
  return { content: [{ type: "text", text: 'ok\n\n```json\n{\n  "ok": true\n}\n```' }] };
}

function errorResultWithCode(code: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `nope\n\n\`\`\`json\n${JSON.stringify({ ok: false, error: { code, message: "x" } }, null, 2)}\n\`\`\``,
      },
    ],
  };
}

/** A transport stub that records every event recordToolUsage receives. */
function recordingTransport(): { transport: PidgeonTransport; events: ToolUsageEvent[] } {
  const events: ToolUsageEvent[] = [];
  const transport = {
    recordToolUsage: (evt: ToolUsageEvent) => {
      events.push(evt);
      return Promise.resolve();
    },
  } as unknown as PidgeonTransport;
  return { transport, events };
}

console.log("Running usage-instrumentation tests...\n");

async function main(): Promise<void> {
  await test("classifyErrorOutcome: a Zod schema failure is an argument error", () => {
    let zodErr: unknown;
    try {
      z.object({ n: z.number() }).parse({ n: "not-a-number" });
    } catch (e) {
      zodErr = e;
    }
    assert(classifyErrorOutcome(zodErr) === "arg_error", "ZodError → arg_error");
  });

  await test("classifyErrorOutcome: a Bridge validation code is an argument error", () => {
    assert(
      classifyErrorOutcome(new BridgeError("bad type", "INVALID_TYPE", 400)) === "arg_error",
      "INVALID_TYPE → arg_error",
    );
    assert(
      classifyErrorOutcome(new BridgeError("missing", "MISSING_MESSAGE_TYPE", 400)) === "arg_error",
      "MISSING_MESSAGE_TYPE → arg_error",
    );
  });

  await test("classifyErrorOutcome: tier/throttle/infra failures are NOT argument errors", () => {
    assert(classifyErrorOutcome(new TierError("pro", "free", "pro")) === "error", "TierError → error");
    assert(classifyErrorOutcome(new ThrottleError("cap")) === "error", "ThrottleError → error");
    assert(classifyErrorOutcome(new BridgeError("boom", "INTERNAL_ERROR", 500)) === "error", "infra → error");
    assert(classifyErrorOutcome(new Error("weird")) === "error", "generic → error");
  });

  await test("classifyResultOutcome: reads the fenced envelope", () => {
    assert(classifyResultOutcome(successResult()) === "success", "ok:true → success");
    assert(classifyResultOutcome(errorResultWithCode("INVALID_PARAMETER")) === "arg_error", "arg code → arg_error");
    assert(classifyResultOutcome(errorResultWithCode("TOOL_ERROR")) === "error", "TOOL_ERROR → error");
    assert(
      classifyResultOutcome({ content: [{ type: "text", text: "plain text, no envelope" }] }) === "success",
      "no envelope → success",
    );
  });

  await test("deriveToolEvents: a plain call yields exactly one call event", () => {
    const evts = deriveToolEvents("generate_message", { messageType: "ADT^A01" }, "success", "sess-1");
    assert(evts.length === 1, `expected 1 event, got ${evts.length}`);
    assert(evts[0].kind === "call" && evts[0].toolName === "generate_message", "call event for the tool");
    assert(evts[0].outcome === "success", "outcome carried");
  });

  await test("deriveToolEvents: describe_tool(name=X) yields the call + a describe event for X", () => {
    const evts = deriveToolEvents("describe_tool", { name: "conform" }, "success", "sess-2");
    assert(evts.length === 2, `expected 2 events, got ${evts.length}`);
    assert(evts[0].toolName === "describe_tool" && evts[0].kind === "call", "records the describe_tool call itself");
    assert(evts[1].toolName === "conform" && evts[1].kind === "describe", "records the describe of the named tool");
  });

  await test("deriveToolEvents: describe_tool with no name yields only the call event", () => {
    const evts = deriveToolEvents("describe_tool", {}, "success", "sess-3");
    assert(evts.length === 1, `expected 1 event, got ${evts.length}`);
    assert(evts[0].kind === "call", "just the call event");
  });

  await test("NO CONTENT: derived events carry only the four enumerated dimensions", () => {
    // A hostile call whose arguments carry PHI-shaped content and secrets.
    const args = {
      message: "MSH|^~\\&|SENDER|John^Doe^19800101|...",
      patientName: "DOE^JOHN",
      secret: "ssn-123-45-6789",
      ssn: "123-45-6789",
    };
    const evts = deriveToolEvents("validate_message", args, "arg_error", "sess-phi");
    for (const evt of evts) {
      const keys = Object.keys(evt).sort();
      assert(
        JSON.stringify(keys) === JSON.stringify(["kind", "outcome", "sessionId", "toolName"]),
        `event carries exactly the 4 dimensions, got ${keys.join(",")}`,
      );
      const serialized = JSON.stringify(evt);
      for (const value of Object.values(args)) {
        assert(!serialized.includes(value), `no argument value leaks into the event (leaked: ${value})`);
      }
    }
  });

  await test("emitToolUsage: forwards the derived events to the transport", async () => {
    const { transport, events } = recordingTransport();
    await emitToolUsage(transport, "sess-x", "describe_tool", { name: "flock_generate" }, "success");
    assert(events.length === 2, `expected 2 recorded events, got ${events.length}`);
    assert(events[0].toolName === "describe_tool", "first is the describe_tool call");
    assert(events[1].toolName === "flock_generate" && events[1].kind === "describe", "second is the describe linkage");
  });

  await test("emitToolUsage: a throwing transport is swallowed (telemetry is never load-bearing)", async () => {
    const transport = {
      recordToolUsage: () => Promise.reject(new Error("bridge down")),
    } as unknown as PidgeonTransport;
    // Must resolve, never reject.
    await emitToolUsage(transport, "sess-y", "generate_message", {}, "success");
    assert(true, "did not throw");
  });

  await test("newSessionId: returns a distinct opaque id per call", () => {
    const a = newSessionId();
    const b = newSessionId();
    assert(a.length > 0 && b.length > 0 && a !== b, "distinct non-empty ids");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
