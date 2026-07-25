// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ToolCatalogEntry } from "../catalog.js";
import { CompositionSource } from "../composition.js";

/**
 * Roster resolution for the MCP tool surface — the pure logic behind two H-22
 * mechanisms, kept free of the MCP SDK so it is unit-testable without a live
 * server (server.ts is the thin SDK glue that calls these):
 *
 *   - Toolset narrowing (the H-2 scoping clause): the operator may narrow the
 *     registered roster to their own context budget via env / `.mcpb`
 *     user_config. The DEFAULT is the full roster — H-2's "Pidgeon ships
 *     everything; only the user narrows their own budget". A narrowed roster
 *     still never forks semantics (H-1): it registers a subset of the SAME
 *     tools, never a re-implementation.
 *
 *   - Capability-driven registration (§2.3 part 3): a tool whose substrate is an
 *     installable package (a future X12 / C-CDA validator) registers only when
 *     the package is installed, and its arrival is announced with
 *     `notifications/tools/list_changed`. No current tool is package-gated
 *     (every catalog entry has `requiresCapability` undefined), so this is the
 *     mechanism wired ahead of the need — proven by test, off in production.
 *
 * The budget-driven deferral threshold (H-20/H-21) is a FLAG that is present but
 * OFF: Pidgeon defers nothing at the current roster because visibility is the
 * conversion surface (H-2) and the roster is under the §2.2 budget. The flag
 * exists so growth has a switch, not so it flips today.
 */

// ---------------------------------------------------------------------------
// Toolset narrowing (the H-2 scoping clause) — Part 2
// ---------------------------------------------------------------------------

/** Env var (and `.mcpb` user_config key) that ALLOW-lists tools by name or tier. */
export const TOOLS_INCLUDE_ENV = "PIDGEON_TOOLS";
/** Env var (and `.mcpb` user_config key) that DENY-lists tools by name or tier, applied after the include. */
export const TOOLS_EXCLUDE_ENV = "PIDGEON_EXCLUDE_TOOLS";

/**
 * Split a comma-separated toolset spec into normalized tokens. Each token is a
 * tool name (`generate_message`) or a tier keyword (`free` / `pro` /
 * `enterprise`). Empty / whitespace tokens are dropped; matching is
 * case-insensitive.
 */
export function parseToolTokens(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/** True when a token names this entry — either its exact tool name or its tier. */
function tokenMatches(entry: ToolCatalogEntry, token: string): boolean {
  return token === entry.name.toLowerCase() || token === entry.requiredTier.toLowerCase();
}

export interface RosterResolution {
  /** The entries to register, in catalog order. */
  roster: ToolCatalogEntry[];
  /** True when the operator narrowed the roster (an include or exclude was set and took effect). */
  narrowed: boolean;
  /** A stderr-worthy note when a narrowing was a no-op or was reverted to the full roster. */
  warning?: string;
}

/**
 * Resolve the registered roster from the full catalog + the operator's env.
 * Include first (allow-list), then exclude (deny-list). The DEFAULT — neither
 * var set — is the full roster (H-2). A narrowing that removes every tool is
 * treated as a misconfiguration and reverted to the full roster with a warning,
 * so the server is never uselessly empty and the default-full invariant holds.
 */
export function resolveRoster(
  catalog: readonly ToolCatalogEntry[],
  env: Record<string, string | undefined> = process.env,
): RosterResolution {
  const include = parseToolTokens(env[TOOLS_INCLUDE_ENV]);
  const exclude = parseToolTokens(env[TOOLS_EXCLUDE_ENV]);

  if (include.length === 0 && exclude.length === 0) {
    return { roster: [...catalog], narrowed: false };
  }

  const included = include.length > 0 ? catalog.filter((e) => include.some((t) => tokenMatches(e, t))) : [...catalog];
  const roster = exclude.length > 0 ? included.filter((e) => !exclude.some((t) => tokenMatches(e, t))) : included;

  if (roster.length === 0) {
    return {
      roster: [...catalog],
      narrowed: false,
      warning:
        `Toolset narrowing (${TOOLS_INCLUDE_ENV}/${TOOLS_EXCLUDE_ENV}) removed every tool; ` +
        `restoring the full roster (H-2 default-full). Check the tool names / tier keywords.`,
    };
  }

  return { roster, narrowed: true };
}

// ---------------------------------------------------------------------------
// Composition resolution — the public-boundary roster (PREP-PUBLIC-MCP)
// ---------------------------------------------------------------------------

export interface CompositionInput {
  /** Transport mode: "bridge" registers advertised capabilities; anything else is the community CLI surface. */
  mode: string;
  /** The full static catalog (definitions available to this build). */
  catalog: readonly ToolCatalogEntry[];
  /** The checked-in community allowlist (community-catalog.ts). */
  communityNames: ReadonlySet<string>;
  /**
   * The server-advertised entitled tool names (Bridge mode), or null when no
   * advertisement is available — endpoint missing on an older Bridge, Bridge
   * unreachable, or CLI mode where advertisement does not apply.
   */
  advertised: readonly string[] | null;
}

export interface CompositionResolution {
  roster: ToolCatalogEntry[];
  source: CompositionSource;
  /**
   * Advertised names with no local definition (a newer Bridge advertising a
   * capability this adapter version doesn't know). Skipped — the adapter cannot
   * register a tool without a schema — and surfaced so the operator learns an
   * adapter upgrade would unlock them.
   */
  unknownAdvertised: string[];
}

/**
 * Resolve which catalog entries this composition may register. This is the
 * fail-closed public boundary (OPEN_CORE_COMPILE_BOUNDARIES.md §3):
 *
 *   - CLI mode registers EXACTLY the checked-in community allowlist. A catalog
 *     entry outside it — including a planted private/ghost tool — never
 *     registers, whatever its tier label says.
 *   - Bridge mode registers EXACTLY what the authenticated Bridge advertises
 *     as entitled (GET /api/mcp/tools). Client-side tier labels do not
 *     materialize a tool.
 *   - Bridge mode WITHOUT an advertisement (older Bridge build, Bridge down at
 *     startup) fails closed to the community allowlist — never "register
 *     everything and hope".
 */
export function resolveCompositionRoster(input: CompositionInput): CompositionResolution {
  const { mode, catalog, communityNames, advertised } = input;

  if (mode !== "bridge") {
    return {
      roster: catalog.filter((e) => communityNames.has(e.name)),
      source: "community-cli",
      unknownAdvertised: [],
    };
  }

  if (advertised === null) {
    return {
      roster: catalog.filter((e) => communityNames.has(e.name)),
      source: "bridge-fallback-community",
      unknownAdvertised: [],
    };
  }

  const advertisedSet = new Set(advertised);
  const known = new Set(catalog.map((e) => e.name));
  return {
    roster: catalog.filter((e) => advertisedSet.has(e.name)),
    source: "bridge-advertised",
    unknownAdvertised: advertised.filter((name) => !known.has(name)),
  };
}

// ---------------------------------------------------------------------------
// Capability-driven registration + list_changed (§2.3 part 3) — Part 3
// ---------------------------------------------------------------------------

/** Env var listing installed capabilities (comma-separated), mirroring installed packages. */
export const CAPABILITIES_ENV = "PIDGEON_CAPABILITIES";

/**
 * The set of capabilities the server currently treats as installed. Today this
 * reads an env hook (ops override / test seam); the eventual source is the
 * installed-package registry (`manage_data_packages`), at which point an install
 * event drives {@link onCapabilityInstalled}. Default: empty — no capability
 * assumed present, so a capability-gated tool defers until its package installs.
 */
export function installedCapabilitiesFromEnv(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set(parseToolTokens(env[CAPABILITIES_ENV]));
}

export interface CapabilityPartition {
  /** Entries registerable now — no capability required, or their capability is installed. */
  available: ToolCatalogEntry[];
  /** Entries whose backing package is not installed; they register on a later list_changed. */
  deferred: ToolCatalogEntry[];
}

/**
 * Split a roster into the tools registerable now versus those gated on an
 * uninstalled capability. A tool with no `requiresCapability` is always
 * available; a gated tool is available only when its capability is installed.
 */
export function partitionByCapability(
  entries: readonly ToolCatalogEntry[],
  installed: ReadonlySet<string>,
): CapabilityPartition {
  const available: ToolCatalogEntry[] = [];
  const deferred: ToolCatalogEntry[] = [];
  for (const e of entries) {
    if (!e.requiresCapability || installed.has(e.requiresCapability)) available.push(e);
    else deferred.push(e);
  }
  return { available, deferred };
}

/**
 * The registration seam the SDK glue (server.ts) implements. Kept abstract so
 * the capability mechanism is testable with a fake that records registrations
 * and list_changed emissions, without standing up a real McpServer + transport.
 */
export interface ToolRegistrar {
  /** Register one catalog entry as a live MCP tool. */
  registerTool(entry: ToolCatalogEntry): void;
  /** Emit `notifications/tools/list_changed` so clients re-fetch `tools/list`. */
  notifyListChanged(): void;
}

/**
 * Handle a capability becoming installed: register every catalog tool gated on
 * that capability that is not already registered, then emit ONE
 * `tools/list_changed` if anything new appeared (never a spurious notification
 * when the install unlocks nothing). Idempotent — a duplicate install event
 * registers nothing twice and emits no notification. Returns the names newly
 * registered so the caller can log/observe the change.
 *
 * This is the hook a future `manage_data_packages install x12-5010` calls; it is
 * proven by list-changed.test.ts against a synthetic gated tool, because no
 * current tool is package-gated.
 */
export function onCapabilityInstalled(
  registrar: ToolRegistrar,
  catalog: readonly ToolCatalogEntry[],
  capability: string,
  registered: Set<string>,
): string[] {
  const newlyAvailable = catalog.filter((e) => e.requiresCapability === capability && !registered.has(e.name));
  for (const entry of newlyAvailable) {
    registrar.registerTool(entry);
    registered.add(entry.name);
  }
  if (newlyAvailable.length > 0) registrar.notifyListChanged();
  return newlyAvailable.map((e) => e.name);
}

// ---------------------------------------------------------------------------
// Budget-driven deferral threshold (H-20/H-21) — FLAG PRESENT, POLICY OFF
// ---------------------------------------------------------------------------

/**
 * The disclosure-ladder deferral switch (H-22). OFF by design: Pidgeon keeps the
 * whole roster eager because the roster is under the §2.2 budget and visibility
 * is the conversion surface (H-2). The corpus defers at 90–250 tools; nothing in
 * it defers at ~20. This flag exists so growth has somewhere to go, not so it
 * flips today. Flipping it on is a deliberate §2.3 decision, not accretion.
 */
export const DEFERRAL_ENABLED = false;

/**
 * The roster size at which the disclosure ladder WOULD flip on if
 * {@link DEFERRAL_ENABLED} were true. Documentary while the flag is off; a
 * projected trip point well below the point the §2.2 token budget is at risk.
 */
export const DEFERRAL_TOOL_THRESHOLD = 40;

/**
 * Whether budget-driven deferral applies to a roster of this size. Always false
 * while {@link DEFERRAL_ENABLED} is off — no current tool is deferred, whatever
 * the count. Wired so a future flip is one constant, and pinned false by test.
 */
export function shouldDeferForBudget(rosterSize: number): boolean {
  return DEFERRAL_ENABLED && rosterSize > DEFERRAL_TOOL_THRESHOLD;
}
