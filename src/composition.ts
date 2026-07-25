// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The active composition roster — which tools this server session actually
 * registered, and on whose authority. Set once by server.ts at registration
 * (and updated when a later advertisement refresh unlocks tools), read by the
 * surfaces that must not describe ghost tools: describe_tool, the
 * pidgeon://version resource, and prompt registration.
 *
 * Default (never set): the full static catalog. That default exists for the
 * manifest builders (scripts/manifest.ts documents the complete surface) and
 * for direct-factory tests; every live server path sets the composition before
 * a client can call anything.
 */

export type CompositionSource =
  /** CLI mode — the checked-in community allowlist (community-catalog.ts). */
  | "community-cli"
  /** Bridge mode — the server-advertised entitled roster. */
  | "bridge-advertised"
  /** Bridge mode, advertisement unavailable — failed closed to the community allowlist. */
  | "bridge-fallback-community";

export interface ActiveComposition {
  source: CompositionSource;
  /** Names of the tools registered (or registerable pending capability install). */
  toolNames: ReadonlySet<string>;
}

let active: ActiveComposition | null = null;

export function setActiveComposition(composition: ActiveComposition): void {
  active = composition;
}

/** The active composition, or null when no server registration has run. */
export function getActiveComposition(): ActiveComposition | null {
  return active;
}

/**
 * Whether a tool is in the active composition. With no composition set
 * (manifest builders, direct-factory tests) every catalog tool is in scope.
 */
export function isToolActive(name: string): boolean {
  return active === null || active.toolNames.has(name);
}

/** Test seam: clear the module state between cases. */
export function resetActiveComposition(): void {
  active = null;
}
