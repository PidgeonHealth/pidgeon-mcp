// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomUUID } from "crypto";
import { PidgeonTransport, TierError } from "../transport/index.js";
import { ThrottleError, BridgeError } from "../transport/errors.js";
import { ToolResult } from "./format.js";
import type { ToolCallOutcome, ToolEventKind, ToolUsageEvent } from "../transport/usage-types.js";

export type { ToolCallOutcome, ToolEventKind, ToolUsageEvent } from "../transport/usage-types.js";

/**
 * Per-tool usage instrumentation (AGENTIC_HARNESS_STANDARD.md §5.3). Observes each
 * tool dispatch and emits an enumerated, content-free event to the Bridge, which
 * records it under telemetry consent. Nothing here is load-bearing: emission is
 * fire-and-forget and every error is swallowed, so telemetry never affects a tool
 * result or breaks an agent loop.
 */

/** The Bridge error codes that mean "the caller's arguments were wrong". */
const ARG_ERROR_CODES: ReadonlySet<string> = new Set([
  "VALIDATION_ERROR",
  "INVALID_REQUEST",
  "INVALID_PARAMETER",
  "MISSING_MESSAGE_TYPE",
  "MESSAGE_TYPE_NOT_FOUND",
  "INVALID_TYPE",
  "UNSUPPORTED_STANDARD",
  "UNSUPPORTED_VERSION",
  "INVALID_SCENARIO",
  "INVALID_SCOPE",
  "CONFORM_ENDPOINT_REQUIRED",
  "DDL_PARSE_ERROR",
]);

/** A fresh session id for one MCP connection. Random — carries no content. */
export function newSessionId(): string {
  return randomUUID();
}

/**
 * Classify a thrown error into an outcome. A Zod schema failure or a Bridge
 * argument-class code is `arg_error`; a tier gate, a throttle, or any other
 * failure is `error` (a policy denial or infra failure is not the caller's
 * argument mistake).
 */
export function classifyErrorOutcome(err: unknown): ToolCallOutcome {
  if (isZodError(err)) return "arg_error";
  if (err instanceof BridgeError && ARG_ERROR_CODES.has(err.code)) return "arg_error";
  // TierError / ThrottleError / everything else — the tool was attempted, but the
  // failure is not an argument problem.
  if (err instanceof TierError || err instanceof ThrottleError) return "error";
  return "error";
}

/**
 * Classify a returned tool result into an outcome by reading its fenced ```json
 * envelope. A handler that returned a typed error whose code is argument-class is
 * `arg_error`; any other `ok:false` is `error`; otherwise `success`.
 */
export function classifyResultOutcome(result: ToolResult): ToolCallOutcome {
  const envelope = parseEnvelope(result);
  if (!envelope || envelope.ok !== false) return "success";
  const code = typeof envelope.error?.code === "string" ? envelope.error.code : "";
  return ARG_ERROR_CODES.has(code) ? "arg_error" : "error";
}

/**
 * Derive the usage event(s) for one dispatch. A plain tool call yields one `call`
 * event. A `describe_tool(name=X)` call additionally yields a `describe` event for
 * X — the describe→call linkage §5.3 measures — while still recording the
 * describe_tool call itself (so reach(describe_tool) stays measurable). Only the
 * tool NAME from the args is read (an identifier from the fixed catalog), never any
 * other argument value.
 */
export function deriveToolEvents(
  toolName: string,
  args: Record<string, unknown>,
  outcome: ToolCallOutcome,
  sessionId: string,
): ToolUsageEvent[] {
  const events: ToolUsageEvent[] = [
    { sessionId, toolName, kind: "call", outcome },
  ];

  if (toolName === "describe_tool" && typeof args["name"] === "string" && args["name"].length > 0) {
    events.push({
      sessionId,
      toolName: args["name"],
      kind: "describe",
      // The describe lookup itself succeeded if we reached here without the call
      // erroring; the payoff (a subsequent call of the named tool) is derived
      // Bridge-side from later `call` events.
      outcome: "success",
    });
  }

  return events;
}

/**
 * Fire-and-forget: emit the derived events to the Bridge. Never awaited by a tool
 * handler in production and never throws — a transport failure (e.g. an older
 * Bridge without the endpoint) is swallowed so the tool result is unaffected.
 * Returns a promise the tests can await to observe emission.
 */
export async function emitToolUsage(
  transport: PidgeonTransport,
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  outcome: ToolCallOutcome,
): Promise<void> {
  const events = deriveToolEvents(toolName, args, outcome, sessionId);
  for (const evt of events) {
    try {
      await transport.recordToolUsage(evt);
    } catch {
      // Telemetry is observation, never load-bearing.
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface ParsedEnvelope {
  ok?: boolean;
  error?: { code?: unknown };
}

function isZodError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "ZodError" || Array.isArray((err as { issues?: unknown }).issues))
  );
}

/** Extract the fenced ```json envelope a tool result embeds, if present. */
function parseEnvelope(result: ToolResult): ParsedEnvelope | null {
  const text = result?.content?.map((c) => c.text).join("\n") ?? "";
  const start = text.indexOf("```json");
  if (start === -1) return null;
  const bodyStart = text.indexOf("\n", start);
  if (bodyStart === -1) return null;
  const end = text.indexOf("```", bodyStart);
  if (end === -1) return null;
  try {
    return JSON.parse(text.slice(bodyStart + 1, end)) as ParsedEnvelope;
  } catch {
    return null;
  }
}
