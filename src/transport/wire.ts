// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Bridge wire mapping — the single place where MCP-canonical parameter names
// are translated to the Bridge HTTP contract's wire names.
//
// The cross-surface naming map lives in the Bridge contract design note § 3.
// Canonical names at the MCP/agent layer:
//   - `vendorProfile` — a vendor interface profile ("epic" / "epic.adt_outbound")
//   - `message`       — the message under operation
//
// Bridge wire names (camelCase of the C# contract DTOs in
// the authenticated Bridge API contract):
//
//   MCP name        Bridge wire field      Endpoint
//   --------------  ---------------------  -------------------------------
//   message      →  messageContent         POST /api/validate, /api/refine
//   vendorProfile → vendorProfile          POST /api/validate (ValidateRequest.VendorProfile)
//   profile       → vendorProfile          POST /api/refine   (RefineRequest.VendorProfile;
//                                          the refine tool's input is still named `profile`)
//   vendor        → vendor                 POST /api/generate, /api/workflow/run
//                                          (generate/workflow wire names stay `vendor` — frozen
//                                          until their own coordinated rename)
//
// Every translation is explicit here — do NOT build request bodies inline in
// bridge.ts; extend this module instead so the map stays complete.

import {
  GenerateOptions,
  ValidateOptions,
  WorkflowOptions,
  PopulationOptions,
  SendOptions,
} from "./types.js";
import { GenerateResult } from "./generate-types.js";
import { SemanticReviewOptions } from "./semantic.js";

/** Standard Bridge response envelope: `{ success, data, error }`. */
export interface BridgeApiResponse<T> {
  success: boolean;
  data: T | null;
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Unwraps a Bridge envelope, throwing the server's error message (or the
 * caller's fallback) when the call did not succeed.
 */
export function unwrap<T>(body: BridgeApiResponse<T>, fallbackMessage: string): T {
  if (!body.success || body.data === null || body.data === undefined) {
    throw new Error(body.error?.message ?? fallbackMessage);
  }
  return body.data;
}

/** Body for POST /api/generate (GenerateRequest). */
export function toGenerateBody(messageType: string, options: GenerateOptions) {
  return {
    messageType,
    standard: options.standard,
    count: options.count ?? 1,
    hl7Version: options.hl7Version,
    seed: options.seed,
    vendor: options.vendor,
    // Pins: the Bridge accepts LockedValues (inline) or LockSessionName (saved
    // set), mutually exclusive — mirrors the agent-loop generate schema.
    lockedValues: options.lockedValues,
    lockSessionName: options.lockSessionName,
  };
}

/**
 * Reads the generate response headers the Bridge rides alongside the string[]
 * body: X-Pidgeon-Effective-Seed (GenerateEndpoints) and X-RateLimit-*
 * (FreeTierCapFilter). Header names are Bridge wire names, so their string
 * literals live here with the rest of the contract, not inline in bridge.ts.
 * Non-numeric values are treated as absent rather than surfacing NaN.
 */
export function extractGenerateHeaders(
  headers: Record<string, string | undefined>
): Pick<GenerateResult, "effectiveSeed" | "volume"> {
  const num = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const effectiveSeed = num(headers["x-pidgeon-effective-seed"]);
  const limit = num(headers["x-ratelimit-limit"]);
  const remaining = num(headers["x-ratelimit-remaining"]);
  const volume =
    limit !== undefined && remaining !== undefined
      ? { limit, remaining, resetsAt: headers["x-ratelimit-reset"] }
      : undefined;
  return { effectiveSeed, volume };
}

/** Body for POST /api/validate (ValidateRequest). */
export function toValidateBody(message: string, options: ValidateOptions) {
  return {
    // MCP-canonical `message` → Bridge wire `messageContent`.
    messageContent: message,
    standard: options.standard,
    mode: options.mode ?? "compatibility",
    // MCP-canonical `vendorProfile` crosses under the same name
    // (ValidateRequest.VendorProfile). Forwarding this is what makes
    // profile-scoped validation work in bridge mode — it was silently
    // dropped before W2b.
    vendorProfile: options.vendorProfile,
  };
}

/** Options bag for POST /api/refine (RefineRequest). */
export interface RefineOptions {
  originalMessage?: string;
  standard?: string;
  profile?: string;
  segmentContent?: string;
  segmentIndex?: number;
}

/** Body for POST /api/refine (RefineRequest). */
export function toRefineBody(messageContent: string, prompt: string, options: RefineOptions) {
  return {
    // MCP-canonical `message` → Bridge wire `messageContent`.
    messageContent,
    originalMessage: options.originalMessage,
    prompt,
    standard: options.standard ?? "hl7",
    // Refine tool input `profile` → Bridge wire `vendorProfile` (RefineRequest.VendorProfile).
    vendorProfile: options.profile,
    segmentContent: options.segmentContent,
    segmentIndex: options.segmentIndex,
  };
}

/** Body for POST /api/workflow/run (WorkflowRunRequest). */
export function toWorkflowBody(scenario: string, options: WorkflowOptions) {
  return {
    scenario,
    vendor: options.vendor,
    count: options.count,
  };
}

/**
 * Body for POST /api/flock/generate (FlockGenerateRequest). The Bridge wire
 * names differ from the MCP-canonical options: `population` → `count`,
 * `location` → `geographicFocus`. Sending the MCP names silently fell back to
 * the C# defaults (Count = 1000) before this mapping existed.
 */
export function toFlockGenerateBody(options: PopulationOptions) {
  return {
    count: options.population,
    format: options.format,
    geographicFocus: options.location,
    seed: options.seed,
  };
}

/** Body for POST /api/send (SendMessageRequest). */
export function toSendBody(message: string, destination: string, options: SendOptions) {
  return {
    message,
    destination,
    protocol: options.protocol,
    filename: options.filename,
    idempotencyKey: options.idempotencyKey,
  };
}

/**
 * Body for POST /api/ai/semantic-review (SemanticReviewRequest). Note this
 * endpoint's message field is `message`, not the `messageContent` that
 * /api/validate and /api/refine use — it predates that rename.
 */
export function toSemanticReviewBody(message: string, options: SemanticReviewOptions) {
  return {
    message,
    contentIsSynthetic: options.contentIsSynthetic ?? false,
    families: options.families,
    maxLatencyMs: options.maxLatencyMs,
  };
}

/** Body for POST /api/clinical-checks (ClinicalCheckRequest) — deterministic, message only. */
export function toClinicalCheckBody(message: string) {
  return { message };
}
