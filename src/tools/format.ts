// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { Tier } from "../transport/index.js";

/**
 * Shared tier-gating + result helpers for the MCP tool surface.
 *
 * Every tool returns the classic `{ content: [{ type: "text", text }] }` shape.
 * For failures and tier gates we additionally embed a machine-parseable JSON
 * envelope inside the text so an agent can branch on a stable typed code
 * (TIER_REQUIRED, BRIDGE_REQUIRED, TOOL_ERROR) instead of regexing prose — the
 * "agent reads the code, the human reads the line" requirement from the agentic
 * surface spec. The envelope is fenced as ```json so it is unambiguous to parse
 * and harmless to a human reader.
 *
 * The fenced-block approach is deliberate: returning `structuredContent` over
 * MCP requires every tool to declare an `outputSchema`, which is out of scope
 * here. The fenced envelope is transport- and SDK-version-independent.
 */

export type ToolResult = { content: Array<{ type: "text"; text: string }> };

/** Stable error codes an agent can branch on. */
export type ErrorCode = "TIER_REQUIRED" | "BRIDGE_REQUIRED" | "TOOL_ERROR" | "THROTTLED";

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    tier?: { current: string; required: string };
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Tier comparison — the single decision of whether a gate fires.
// ---------------------------------------------------------------------------

const TIER_RANK: Record<Tier, number> = { free: 0, pro: 1, enterprise: 2 };

export function tierSatisfies(userTier: Tier, requiredTier: Tier): boolean {
  return TIER_RANK[userTier] >= TIER_RANK[requiredTier];
}

/**
 * Canonicalize a tier string from the entitlement contract into the MCP's
 * vocabulary. The contract speaks a wider dialect than the gate ranks: the
 * Bridge emits the C# `SubscriptionTier` enum name lowercased
 * (`"professional"`, `"consolefree"`), and Supabase/JWT claims use `"trial"`.
 * The gate only ranks `free | pro | enterprise`, so an un-normalized
 * `"professional"` ranks as `undefined` and a paying caller is wrongly denied.
 * One vocabulary, one contract: every alias collapses to a canonical {@link Tier},
 * and any unrecognized value fails safe to `"free"` — a gate, never a crash.
 *
 * Bridge peer: the canonical TierClaims normalization contract.
 * There is no shared literal across the runtimes, so keep the alias set in sync.
 */
export function normalizeTier(raw: string | null | undefined): Tier {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "pro":
    case "professional":
    case "trial":
      return "pro";
    case "enterprise":
      return "enterprise";
    default:
      // "free", "consolefree", "", and any unknown string fail safe to free.
      return "free";
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** First sentence of a description — a one-line summary for the roster/manifest. */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.indexOf(". ");
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}

// ---------------------------------------------------------------------------
// Result envelopes
// ---------------------------------------------------------------------------

const FENCE_OPEN = "```json";
const FENCE_CLOSE = "```";

function withEnvelope(human: string, envelope: ErrorEnvelope): ToolResult {
  const block = `${FENCE_OPEN}\n${JSON.stringify(envelope, null, 2)}\n${FENCE_CLOSE}`;
  return { content: [{ type: "text" as const, text: `${human}\n\n${block}` }] };
}

/**
 * Appends a fenced ```json block carrying a machine-parseable payload after a
 * tool's human-readable text — the success counterpart to the error envelopes.
 * Lets an agent pass one tool's structured output straight into the next tool's
 * input (e.g. validate_message's findings into explain_error) without regexing
 * prose. `ok: true` distinguishes it from the `ok: false` error envelopes.
 */
export function withSuccessEnvelope(human: string, payload: Record<string, unknown>): ToolResult {
  const block = `${FENCE_OPEN}\n${JSON.stringify({ ok: true, ...payload }, null, 2)}\n${FENCE_CLOSE}`;
  return { content: [{ type: "text" as const, text: `${human}\n\n${block}` }] };
}

/**
 * Tier gate — surfaced both when the client-side check fails and when the Bridge
 * returns 402/403. Never a hard error: an agent should read the code and degrade,
 * never crash its loop. `toolName` is optional (unknown at the server-side catch).
 */
export function tierGateResult(opts: {
  toolName?: string;
  currentTier: Tier | string;
  requiredTier: Tier | string;
  message?: string;
}): ToolResult {
  const required = normalizeTier(String(opts.requiredTier));
  const current = normalizeTier(String(opts.currentTier));
  const tierLabel = required === "enterprise" ? "Enterprise" : "Pro";
  const subject = opts.toolName ? `The \`${opts.toolName}\` tool requires` : "This requires";

  const human = [
    `**Pidgeon ${tierLabel} required**`,
    "",
    opts.message ?? `${subject} a ${tierLabel} subscription.`,
    "",
    `Your current tier: ${current}`,
    `Required tier: ${required} or higher`,
    "",
    "Upgrade at: https://pidgeon.health/upgrade",
    "",
    "Already a subscriber? Activate your license and run the Bridge:",
    "  1. Activate the license you received: pidgeon license activate ./license.json",
    "     (or claim the free tier: pidgeon license claim-console-free)",
    "  2. Start a Pidgeon desktop app (Post, Flock, Loft, or Migrate) — it runs the Bridge",
    "  3. Set PIDGEON_MODE=bridge in your MCP config",
  ].join("\n");

  return withEnvelope(human, {
    ok: false,
    error: {
      code: "TIER_REQUIRED",
      message: opts.message ?? `${tierLabel} subscription required`,
      tier: { current, required },
    },
  });
}

/**
 * Free-tier volume cap reached — a graceful, never-fatal signal. Mirrors
 * tierGateResult: an agent reads the typed THROTTLED code (and the structured
 * `throttle` fields, so it can self-pace until `resetsAt`) while a human reads the
 * line. The Bridge degrades to ~1 call/min over the cap, so this is a soft
 * throttle, never a hard 403 that breaks the loop.
 */
export function throttleResult(opts: {
  toolName?: string;
  reason: string;
  remaining: number;
  resetsAt: string;
  message?: string;
}): ToolResult {
  const subject = opts.toolName ? `\`${opts.toolName}\`` : "this tool";
  const human = [
    "**Pidgeon free daily cap reached**",
    "",
    opts.message ?? `You've hit the free daily volume cap on ${subject}.`,
    "",
    `Remaining today: ${opts.remaining} · resets ${opts.resetsAt}`,
    "",
    "This is a soft cap — it degrades to about one call a minute, never a hard failure.",
    "Upgrade for unbounded volume: https://pidgeon.health/upgrade",
  ].join("\n");

  return withEnvelope(human, {
    ok: false,
    error: {
      code: "THROTTLED",
      message: opts.message ?? "Free daily volume cap reached",
      throttle: {
        status: "throttled",
        reason: opts.reason,
        remaining: opts.remaining,
        resetsAt: opts.resetsAt,
        upgradeUrl: "https://pidgeon.health/upgrade",
      },
    },
  });
}

/** A tool-level failure (transport error, generation failure, etc.). */
export function errorResult(message: string, code: ErrorCode = "TOOL_ERROR", context?: Record<string, unknown>): ToolResult {
  return withEnvelope(message, {
    ok: false,
    error: { code, message, ...(context ?? {}) },
  });
}
