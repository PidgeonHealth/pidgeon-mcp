// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { PidgeonTransport, Tier } from "../transport/index.js";

/**
 * MCP `ToolAnnotations` (spec §Tool) — behavioural hints a client harness reads
 * to gate approval and parallelism without parsing prose (H-15). Structurally
 * matches the SDK's ToolAnnotations, kept local so the pure manifest path does
 * not depend on the SDK at type level. All fields are hints, never guarantees.
 *
 * Encoding is minimal-but-honest (the bytes ride in every cold-start tools/list,
 * so they are charged against the H-20 budget):
 *   - readOnlyHint: always set.
 *   - destructiveHint / idempotentHint: default false per spec, so set only when
 *     they carry signal (meaningful only when readOnlyHint is false).
 *   - openWorldHint: default true per spec, so set false on the local/on-device
 *     tools and true on the ones that reach an external system (send, conform,
 *     package install).
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * Documents the machine-envelope a chaining tool appends to its result via
 * `withSuccessEnvelope` (H-16) — the `ok: true` fenced JSON block whose keys are
 * stable API so one tool's output feeds the next tool's input without re-parsing
 * prose. This is pure documentation metadata: it is surfaced in the manifest
 * (MANIFEST.md / manifest.json) so an agent can learn the output contract, but it
 * is NOT part of the tool's `tools/list` definition ({ name, description,
 * inputSchema, annotations }). It therefore costs zero cold-start budget (H-20)
 * and never counts against the per-tool char ceiling (H-21).
 */
export interface OutputEnvelope {
  /** Stable keys carried under `ok: true`, each with a one-line contract. */
  keys: Array<{ key: string; description: string }>;
  /** Downstream tools whose input this envelope is shaped to feed. */
  feeds: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  requiredTier: Tier;
  /**
   * Retry-class + side-effect hints (H-15). Required: a new tool cannot register
   * without declaring its class, and the annotation↔catalog parity test
   * (test/manifest.test.ts) fails on an empty object.
   */
  annotations: ToolAnnotations;
  /**
   * Output-envelope contract (H-16) — declared by every tool whose result plausibly
   * feeds a downstream tool. Documents the stable `ok: true` keys the handler emits
   * via `withSuccessEnvelope`. Optional: terminal tools (whose output does not chain)
   * omit it. Surfaced only in the manifest, so it is off the cold-start budget.
   */
  outputEnvelope?: OutputEnvelope;
  inputSchema: z.ZodObject<any>;
  handler: (
    transport: PidgeonTransport,
    args: Record<string, unknown>
  ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}
