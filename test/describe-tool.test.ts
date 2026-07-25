#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the describe_tool meta-tool (H-22, §2.3 part 1).
 *
 * Why this matters: describe_tool is Pidgeon's protocol-native, client-agnostic
 * analogue of schema-on-demand — the disclosure-ladder level that lets an agent
 * fetch any tool's FULL contract (description, input schema, output-envelope
 * keys, typed error codes, worked-prompt examples) without a client-side tool
 * search. It reads the one TOOL_CATALOG, so it can never drift from what the
 * server registers. These pin: (a) it returns a machine ok:true envelope, (b)
 * the contract is complete + tier-correct, (c) it's free and describes Pro tools
 * without unlocking them, (d) unknown/empty inputs are self-correcting, and (e)
 * it fits the H-21 per-tool budget.
 */
import { createDescribeTool } from "../src/tools/describe-tool";
import { TOOL_CATALOG } from "../src/catalog";
import { PidgeonTransport } from "../src/transport/index";

let passed = 0;
let failed = 0;
const cases: Array<[string, () => void | Promise<void>]> = [];

function test(name: string, fn: () => void | Promise<void>): void {
  cases.push([name, fn]);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** describe_tool ignores the transport entirely — it is a pure read of the catalog. */
const stubTransport = {} as unknown as PidgeonTransport;

/** Pull the fenced ```json envelope out of a tool's text result. */
function envelope(text: string): Record<string, unknown> {
  const start = text.indexOf("```json");
  assert(start !== -1, "result carries no fenced json envelope");
  const body = text.slice(start + "```json".length);
  const end = body.indexOf("```");
  assert(end !== -1, "fenced json envelope is not closed");
  return JSON.parse(body.slice(0, end).trim());
}

async function callDescribe(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = createDescribeTool();
  const result = await tool.handler(stubTransport, args);
  return envelope(result.content[0].text);
}

const def = createDescribeTool();

test("registers as a free, read-only tool named describe_tool", () => {
  assert(def.name === "describe_tool", `name is ${def.name}`);
  assert(def.requiredTier === "free", `tier is ${def.requiredTier}`);
  assert(def.annotations.readOnlyHint === true, "must declare readOnlyHint: true (pure read, H-15)");
});

test("describe_tool is in the catalog exactly once, as free", () => {
  const entries = TOOL_CATALOG.filter((e) => e.name === "describe_tool");
  assert(entries.length === 1, `expected 1 describe_tool entry, got ${entries.length}`);
  assert(entries[0].requiredTier === "free", "describe_tool must be free");
});

test("no name -> lists every tool with tier + summary (ok:true)", async () => {
  const env = await callDescribe({});
  assert(env["ok"] === true, "roster listing must be ok:true");
  assert(env["count"] === TOOL_CATALOG.length, `count ${env["count"]} != catalog ${TOOL_CATALOG.length}`);
  const tools = env["tools"] as Array<{ name: string; tier: string; summary: string }>;
  assert(Array.isArray(tools) && tools.length === TOOL_CATALOG.length, "roster must list every catalog tool");
  for (const entry of TOOL_CATALOG) {
    assert(tools.some((t) => t.name === entry.name), `roster is missing ${entry.name}`);
  }
});

test("a free tool's full contract (generate_message) is complete", async () => {
  const env = await callDescribe({ name: "generate_message" });
  assert(env["ok"] === true, "must be ok:true");
  const tool = env["tool"] as Record<string, unknown>;
  assert(tool["name"] === "generate_message", "name echoed");
  assert(tool["tier"] === "free", "generate_message is free");
  assert(typeof tool["description"] === "string" && (tool["description"] as string).length > 0, "carries the full description");
  const schema = tool["inputSchema"] as Record<string, unknown>;
  assert(schema && schema["type"] === "object", "carries the JSON input schema");
  assert((schema["properties"] as Record<string, unknown>)["messageType"] !== undefined, "schema shows messageType");
  // generate_message is a chaining tool — its output envelope must be surfaced.
  const oe = tool["outputEnvelope"] as { keys: Array<{ key: string }> };
  assert(oe && oe.keys.some((k) => k.key === "messages"), "output-envelope keys must include 'messages'");
});

test("a free tool's error codes are THROTTLED + TOOL_ERROR, not TIER_REQUIRED", async () => {
  const env = await callDescribe({ name: "validate_message" });
  const codes = ((env["tool"] as Record<string, unknown>)["possibleErrorCodes"] as Array<{ code: string }>).map((c) => c.code);
  assert(codes.includes("THROTTLED"), "free tool can THROTTLED (free daily cap)");
  assert(codes.includes("TOOL_ERROR"), "any tool can TOOL_ERROR");
  assert(!codes.includes("TIER_REQUIRED"), "a free tool never denies with TIER_REQUIRED");
});

test("a Pro tool's error codes include TIER_REQUIRED (described, not unlocked)", async () => {
  const env = await callDescribe({ name: "send_message" });
  const tool = env["tool"] as Record<string, unknown>;
  assert(tool["tier"] === "pro", "send_message is Pro");
  const codes = (tool["possibleErrorCodes"] as Array<{ code: string }>).map((c) => c.code);
  assert(codes.includes("TIER_REQUIRED"), "a Pro tool can deny with TIER_REQUIRED");
  assert(codes.includes("TOOL_ERROR"), "any tool can TOOL_ERROR");
});

test("describe_tool describes itself (meta, no recursion)", async () => {
  const env = await callDescribe({ name: "describe_tool" });
  const tool = env["tool"] as Record<string, unknown>;
  assert(tool["name"] === "describe_tool", "self-describes");
  assert(tool["tier"] === "free", "self-reports free");
});

test("chaining tools surface usedByPrompts (worked examples)", async () => {
  const env = await callDescribe({ name: "generate_message" });
  const used = (env["tool"] as Record<string, unknown>)["usedByPrompts"] as string[];
  assert(Array.isArray(used) && used.length > 0, "generate_message is chained by prompts");
});

test("unknown tool -> self-correcting error naming the valid tools", async () => {
  const env = await callDescribe({ name: "no_such_tool" });
  assert(env["ok"] === false, "unknown tool is an error envelope");
  const error = env["error"] as Record<string, unknown>;
  assert(error["code"] === "TOOL_ERROR", "typed code");
  const avail = error["availableTools"] as string[];
  assert(Array.isArray(avail) && avail.includes("generate_message"), "lists valid tool names for recovery (H-10)");
});

test("describe_tool fits the H-21 per-tool budget (< 2000 chars full)", () => {
  const cold = JSON.stringify({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema.shape,
    annotations: def.annotations,
  });
  assert(cold.length < 2000, `describe_tool cold-start def is ${cold.length} chars (>= 2000)`);
});

async function main(): Promise<void> {
  console.log("Running describe_tool tests...\n");
  for (const [name, fn] of cases) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
