// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Wire types for the per-tool agent-harness usage counters (H-§5.3). Posted by the
// MCP surface to the Bridge, which stores them under telemetry consent. The shape
// is enumerated dimensions ONLY — there is deliberately no field for message
// content or argument values, so a counter cannot carry PHI.

/** A tool dispatch, or a describe_tool lookup of a named tool. */
export type ToolEventKind = "call" | "describe";

/**
 * The outcome of a tool call. `arg_error` is the caller's arguments failing (a
 * schema/validation error) — the §5.3 signal that a tool's selection/arg guidance
 * is failing. Policy denials (tier/throttle) and infra failures are `error`.
 */
export type ToolCallOutcome = "success" | "arg_error" | "error";

/** One usage event. Dimensions only: no args, no content. */
export interface ToolUsageEvent {
  sessionId: string;
  toolName: string;
  kind: ToolEventKind;
  outcome: ToolCallOutcome;
}
