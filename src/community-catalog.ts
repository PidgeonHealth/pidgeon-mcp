// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The checked-in, fail-closed community tool allowlist — the MCP analogue of the
 * public CLI's community command catalog (config/public-compositions/community.yaml,
 * Pidgeon.CLI artifact). CLI mode registers EXACTLY this set, nothing more
 * (OPEN_CORE_COMPILE_BOUNDARIES.md §3: "Public command and MCP catalogs are
 * checked-in, fail-closed allowlists. Registration by reflection or filesystem
 * discovery is forbidden for the public composition.").
 *
 * Membership rule: a tool is community when the community CLI (`pidgeon` .NET
 * tool: generate, validate, deident, data, artifacts, lookup, find, path, run,
 * session, completions — see
 * Pidgeon.CLI/PublicProgram.cs) or the adapter's own embedded reference data can
 * honestly service it end to end. A tool whose CLI-mode transport op throws
 * `bridgeModeRequired`, or whose CLI command is absent from the community
 * command catalog, is NOT community — advertising it would recreate the 0.2.0
 * ghost-tool finding (containment receipt, finding F4).
 *
 * Deliberately excluded (and why):
 *   - semantic_review, clinical_check — Bridge-only substrates (the CLI-mode
 *     transport throws), and AI/semantic judgment is excluded from the community
 *     compile graph (OPEN_CORE_COMPILE_BOUNDARIES.md §4).
 *   - every Pro tool — paid capabilities are server-advertised after
 *     authentication (Bridge mode); a client-side tier label never materializes
 *     a tool.
 *
 * Changing this list is a public-surface change under the §7 change protocol:
 * state the capability change, update the drift tests, and keep the generated
 * references in sync.
 */
export const COMMUNITY_TOOL_NAMES: readonly string[] = [
  // `pidgeon generate` is in the community command catalog.
  "generate_message",
  // Structural validation, including the public built-in vendor-name lane.
  "validate_message",
  // HIPAA Safe Harbor de-identification over the public Core engine.
  "deidentify_message",
  // Public package registry, explicit CC0 fetch, and local/member-supplied package operations.
  "manage_data_packages",
  // Package-backed discovery; private recipe sources stay private.
  "search_artifacts",
  // Local parse + embedded segment knowledge with community validation annotations.
  "explain_message",
  // Findings triage and message validation are fully local.
  "explain_error",
  // Embedded code tables; the Bridge oracle is an optional upgrade, never load-bearing.
  "lookup_code",
  // Embedded segment/field reference tables with the same optional-oracle pattern.
  "get_segment_spec",
  // Local environment diagnostics.
  "pidgeon_status",
  // Pure read of the active tool roster.
  "describe_tool",
];

/** Fast membership check for composition resolution and tests. */
export const COMMUNITY_TOOL_SET: ReadonlySet<string> = new Set(COMMUNITY_TOOL_NAMES);
