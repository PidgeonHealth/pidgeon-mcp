// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// ---------------------------------------------------------------------------
// Uniform provenance + staleness vocabulary for the agent memory read-surface.
//
// The memory model (AGENTIC_HARNESS_STANDARD.md §4) makes two rules load-bearing
// on every workspace fact an agent retrieves:
//
//   H-32 (provenance is shown, not hidden): every answer names WHICH SUBSTRATE
//   answered — the Bridge's live workspace store vs this server's embedded
//   fallback — so the agent can judge freshness rather than trust silently.
//   This is the same "which substrate answered" labelling already used by
//   lookup_code / get_segment_spec, applied uniformly to workspace facts.
//
//   H-31 (memory is a point-in-time claim; verify before acting): a retrieved
//   fact is evidence, not truth. It carries a staleness signal so anything that
//   would gate a downstream write is re-verified against the live artifact first
//   — the copilot design's "flag a validation report as stale if the message
//   changed" rule, generalized to every retrieved fact.
//
// No new persistence lives here; this only labels reads.
// ---------------------------------------------------------------------------

/** Which store answered a workspace-fact read. */
export type Substrate = "bridge" | "embedded" | "unavailable";

export const SUBSTRATE_LABEL: Record<Substrate, string> = {
  bridge: "Pidgeon Bridge (live workspace store, authenticated session)",
  embedded: "this MCP server's built-in reference data (offline fallback)",
  unavailable: "no substrate answered (Bridge not reachable / CLI mode)",
};

// The one staleness sentence, generalized from the copilot design's
// "flag a validation report as stale if the message changed" rule: a retrieved
// fact is a point-in-time claim, not current truth.
export const POINT_IN_TIME_NOTE =
  "Point-in-time claim, not live truth — read at retrievedAt. Re-verify against " +
  "the live artifact (re-run validate_message, re-read the pane) before this gates a write.";

export interface RetrievalDescriptor {
  /** Machine token for the answering substrate (branch on this). */
  source: Substrate;
  /** Human-readable substrate label. */
  sourceLabel: string;
  /** ISO-8601 time this fact was read. */
  retrievedAt: string;
  /** The staleness contract for the retrieved fact (H-31). */
  staleness: string;
}

/**
 * Build the uniform retrieval descriptor stamped onto every workspace-fact
 * answer. `stalenessAddendum` appends a fact-specific clause after the shared
 * point-in-time note (e.g. vendor profiles are static per Bridge build).
 */
export function retrieval(
  source: Substrate,
  opts: { now?: () => Date; stalenessAddendum?: string } = {}
): RetrievalDescriptor {
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const staleness = opts.stalenessAddendum
    ? `${POINT_IN_TIME_NOTE} ${opts.stalenessAddendum}`
    : POINT_IN_TIME_NOTE;
  return {
    source,
    sourceLabel: SUBSTRATE_LABEL[source],
    retrievedAt: at,
    staleness,
  };
}
