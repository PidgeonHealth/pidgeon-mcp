// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PidgeonTransport, Tier, TierError, ThrottleError } from "./transport/index.js";
import { TOOL_CATALOG, ToolCatalogEntry } from "./catalog.js";
import { tierSatisfies, tierGateResult, throttleResult, normalizeTier, errorResult } from "./tools/format.js";
import {
  resolveRoster,
  resolveCompositionRoster,
  partitionByCapability,
  installedCapabilitiesFromEnv,
  onCapabilityInstalled,
  ToolRegistrar,
} from "./tools/registration.js";
import { COMMUNITY_TOOL_SET } from "./community-catalog.js";
import { setActiveComposition, isToolActive } from "./composition.js";
import {
  newSessionId,
  emitToolUsage,
  classifyErrorOutcome,
  classifyResultOutcome,
  ToolCallOutcome,
} from "./tools/usage-instrumentation.js";

// Resources
import { createHl7SegmentsResources } from "./resources/hl7-segments.js";
import { createVendorsResource } from "./resources/vendors.js";
import { createSystemVersionResource } from "./resources/system.js";
import { createSetupGuideResource } from "./resources/setup-guide.js";
import { createSessionResource } from "./resources/session.js";

// Prompts — the PROMPT_CATALOG is the single roster (server, manifest, and the
// version resource all read it).
import { PROMPT_CATALOG } from "./prompts/catalog.js";
import { PKG_VERSION } from "./version.js";

export function createServer(): McpServer {
  return new McpServer({
    name: "pidgeon",
    version: PKG_VERSION,
  });
}

export async function registerCapabilities(server: McpServer, transport: PidgeonTransport): Promise<void> {
  await registerTools(server, transport);
  registerResources(server, transport);
  registerPrompts(server, transport);
}

// ---------------------------------------------------------------------------
// Tool registration with tier gating
// ---------------------------------------------------------------------------

// The one canonical entitlement-cache TTL for the MCP vector. Deliberately
// matched to the Bridge SubscriptionTierResolver.CacheTtl (60s) so every vector
// resolves tier through one contract with one freshness bound — a mid-session
// upgrade unlocks within a single TTL on every vector. No shared literal exists
// across the C#/TS runtimes, so tier-cache.test.ts pins this against drift.
export const TIER_TTL_MS = 60_000;

/**
 * Tier resolution for the tool gate. Two refresh triggers:
 *   - TTL expiry (60s) on the next tool call, so routine upgrades surface
 *     within a minute;
 *   - a forced refresh when a gate is about to deny — the one moment
 *     staleness costs the user money. A user who upgrades mid-session and
 *     immediately retries the Pro tool gets unlocked on that retry, not
 *     after an MCP restart.
 * Resolution is non-blocking: transports default to "free" when tier
 * lookup fails (e.g. CLI mode without the license command).
 */
export function createTierResolver(
  transport: PidgeonTransport,
  ttlMs: number = TIER_TTL_MS,
  now: () => number = Date.now,
): (forceRefresh?: boolean) => Promise<Tier> {
  let resolvedTier: Tier | null = null;
  let resolvedAt = 0;

  return async (forceRefresh = false): Promise<Tier> => {
    const fresh = resolvedTier !== null && now() - resolvedAt < ttlMs;
    if (fresh && !forceRefresh) return resolvedTier as Tier;
    resolvedTier = await transport.getTier(forceRefresh);
    resolvedAt = now();
    return resolvedTier;
  };
}

/**
 * The client gate's allow decision. The caller's resolved tier must satisfy the
 * tool's requirement; environment variables cannot bypass this boundary.
 */
export function clientGateAllows(userTier: Tier, requiredTier: Tier): boolean {
  return tierSatisfies(userTier, requiredTier);
}

/**
 * Register one catalog entry as a live MCP tool with the full tier gate. Shared
 * by the initial roster loop and the capability-install hook so a tool that
 * arrives later (a package-gated X12/C-CDA validator) gets the identical gate as
 * one present at cold start — the projection never forks (H-1). `getTier` is the
 * shared, cached resolver so every tool resolves tier through one 60s window.
 */
function registerCatalogTool(
  server: McpServer,
  transport: PidgeonTransport,
  getTier: (forceRefresh?: boolean) => Promise<Tier>,
  entry: ToolCatalogEntry,
  sessionId: string,
): void {
  const def = entry.factory();
  // Register with the tool's ToolAnnotations (H-15): the client harness reads
  // readOnly/destructive/idempotent/openWorld hints to gate approval and run
  // read-only tools in parallel, without parsing the description prose.
  server.tool(
    def.name,
    def.description,
    def.inputSchema.shape,
    def.annotations,
    async (args: Record<string, unknown>) => {
      // Per-tool usage counter (H-§5.3). Recorded once per dispatch with the
      // observed outcome; fire-and-forget so it never affects the result. Never
      // carries argument values (deriveToolEvents reads only the tool name).
      let outcome: ToolCallOutcome = "success";
      const emit = () => emitToolUsage(transport, sessionId, def.name, args, outcome);
      try {
        // Client-side tier gate — checks before calling transport. Returns a
        // graceful upgrade message carrying a typed TIER_REQUIRED envelope, so
        // an agent reads the code while a human reads the line — never a hard 403.
        // normalizeTier canonicalizes the contract's wider vocabulary
        // (the Bridge emits "professional"/"consolefree") into the gate's
        // free|pro|enterprise ranks, so a paying caller is never mis-ranked.
        let userTier = normalizeTier(await getTier());
        if (!clientGateAllows(userTier, entry.requiredTier)) {
          // Re-resolve before denying: the cached tier may predate an
          // upgrade, and a wrong denial here is a broken conversion.
          userTier = normalizeTier(await getTier(true));
        }
        if (!clientGateAllows(userTier, entry.requiredTier)) {
          outcome = "error"; // a policy denial — the tool was selected but gated
          void emit();
          return tierGateResult({
            toolName: def.name,
            currentTier: userTier,
            requiredTier: entry.requiredTier,
          });
        }

        const result = await def.handler(transport, args);
        outcome = classifyResultOutcome(result);
        void emit();
        return result;
      } catch (err) {
        outcome = classifyErrorOutcome(err);
        void emit();
        // Server-side tier gate — Bridge returned 402/403.
        if (err instanceof TierError) {
          return tierGateResult({
            currentTier: err.currentTier,
            requiredTier: err.requiredTier,
            message: err.message,
          });
        }
        // Free-tier volume cap — Bridge returned 429. Demo mode bypasses the
        // cap at the Bridge, so this only fires in production; surface it as a
        // graceful, self-paced upgrade message, never a thrown crash.
        if (err instanceof ThrottleError) {
          return throttleResult({
            toolName: def.name,
            reason: err.reason,
            remaining: err.remaining,
            resetsAt: err.resetsAt,
            message: err.message,
          });
        }
        // Last-resort catch: any other error (a structured BridgeError, a
        // transport failure, an unexpected throw) becomes a typed TOOL_ERROR
        // envelope naming the tool — so an agent never sees a bare SDK stack
        // trace and its loop is never crashed by an unhandled throw.
        return errorResult(
          `The ${def.name} tool failed: ${err instanceof Error ? err.message : String(err)}`,
          "TOOL_ERROR",
          { tool: def.name }
        );
      }
    }
  );
}

/** Minimum spacing between advertisement refresh attempts (Bridge mode). */
export const ADVERTISEMENT_REFRESH_MIN_MS = 30_000;

async function registerTools(server: McpServer, transport: PidgeonTransport): Promise<void> {
  const baseGetTier = createTierResolver(transport);
  const mode = transport.getMode();

  // One session id per MCP connection — the reach / describe→call / first-call
  // grouping key for the §5.3 counters. Random, so it carries no content.
  const sessionId = newSessionId();

  // The fail-closed composition boundary (PREP-PUBLIC-MCP): CLI mode registers
  // exactly the checked-in community allowlist; Bridge mode registers exactly
  // the server-advertised entitled roster; Bridge mode without an advertisement
  // (older build, unreachable at startup) fails closed to the community set.
  const advertised = mode === "bridge" ? await transport.getAdvertisedTools() : null;
  const composition = resolveCompositionRoster({
    mode,
    catalog: TOOL_CATALOG,
    communityNames: COMMUNITY_TOOL_SET,
    advertised,
  });
  if (composition.source === "bridge-fallback-community") {
    process.stderr.write(
      "[pidgeon-mcp] The Bridge did not advertise a tool roster (older build or unreachable); " +
        "registering the community tool set. The roster refreshes automatically once the Bridge advertises.\n"
    );
  }
  if (composition.unknownAdvertised.length > 0) {
    process.stderr.write(
      `[pidgeon-mcp] The Bridge advertised ${composition.unknownAdvertised.length} capability(ies) this adapter ` +
        `version has no definition for (skipped): ${composition.unknownAdvertised.join(", ")}. ` +
        "Update @pidgeonhealth/pidgeon-mcp to register them.\n"
    );
  }

  // Toolset narrowing (H-2 scoping clause): the operator may narrow the roster to
  // their own context budget via PIDGEON_TOOLS / PIDGEON_EXCLUDE_TOOLS (or the
  // `.mcpb` user_config). The DEFAULT is the full composition roster; narrowing
  // only ever removes tools — it can never widen past the composition boundary.
  const { roster, warning } = resolveRoster(composition.roster, process.env);
  if (warning) process.stderr.write(`[pidgeon-mcp] ${warning}\n`);

  setActiveComposition({ source: composition.source, toolNames: new Set(roster.map((e) => e.name)) });

  // Capability-driven registration (§2.3 part 3): a tool gated on an installable
  // package registers only once that package is present. No current tool is
  // gated, so `deferred` is empty today; the hook + list_changed emit path exist
  // for the projected X12 / C-CDA validators. `registered` tracks live names so a
  // later install (onCapabilityInstalled) never double-registers.
  const installed = installedCapabilitiesFromEnv(process.env);
  const { available, deferred } = partitionByCapability(roster, installed);
  const registered = new Set<string>();

  // Advertisement refresh: when the resolved tier changes mid-session (an
  // upgrade), or while the roster is the fallback set because the Bridge had not
  // advertised yet, re-fetch the advertisement and register anything newly
  // entitled, announcing it with tools/list_changed — the upgrade unlocks
  // without an MCP restart, mirroring the tier-resolver's own refresh triggers.
  // De-advertised tools are NOT torn down mid-session (the Bridge still enforces
  // every call server-side); the next session applies the shrink.
  let compositionSource = composition.source;
  let lastRefreshAt = 0;
  let refreshing = false;
  const refreshAdvertised = async (now: () => number = Date.now): Promise<void> => {
    if (refreshing || mode !== "bridge") return;
    if (now() - lastRefreshAt < ADVERTISEMENT_REFRESH_MIN_MS) return;
    refreshing = true;
    lastRefreshAt = now();
    try {
      const fresh = await transport.getAdvertisedTools();
      if (fresh === null) return;
      const freshComposition = resolveCompositionRoster({
        mode,
        catalog: TOOL_CATALOG,
        communityNames: COMMUNITY_TOOL_SET,
        advertised: fresh,
      });
      const { roster: freshRoster } = resolveRoster(freshComposition.roster, process.env);
      const { available: freshAvailable } = partitionByCapability(freshRoster, installed);
      const newly = freshAvailable.filter((e) => !registered.has(e.name));
      compositionSource = freshComposition.source;
      if (newly.length === 0) return;
      for (const entry of newly) registrar.registerTool(entry);
      setActiveComposition({
        source: freshComposition.source,
        toolNames: new Set([...registered]),
      });
      registrar.notifyListChanged();
      process.stderr.write(
        `[pidgeon-mcp] The Bridge advertisement unlocked ${newly.length} tool(s): ` +
          `${newly.map((e) => e.name).join(", ")}.\n`
      );
    } catch {
      // Best-effort; the next trigger retries.
    } finally {
      refreshing = false;
    }
  };

  // Tier watch: piggyback on every tool call's tier resolution. An observed
  // tier transition, or any resolution while still on the fallback roster,
  // schedules an advertisement refresh (fire-and-forget — never delays a call).
  let lastTier: Tier | null = null;
  const getTier = async (forceRefresh?: boolean): Promise<Tier> => {
    const tier = await baseGetTier(forceRefresh);
    const normalized = normalizeTier(tier);
    if (mode === "bridge" && ((lastTier !== null && normalized !== lastTier) || compositionSource === "bridge-fallback-community")) {
      void refreshAdvertised();
    }
    lastTier = normalized;
    return tier;
  };

  const registrar: ToolRegistrar = {
    registerTool: (entry) => {
      registerCatalogTool(server, transport, getTier, entry, sessionId);
      registered.add(entry.name);
    },
    // McpServer.sendToolListChanged is connection-guarded internally, so this is
    // safe to call whenever a capability install unlocks new tools.
    notifyListChanged: () => server.sendToolListChanged(),
  };

  // The TOOL_CATALOG is the authoritative roster AND the authoritative tier — the
  // gate reads `entry.requiredTier`, not the tool's own field. The drift guard
  // (test/manifest.test.ts) asserts the two agree, so they cannot diverge.
  for (const entry of available) registrar.registerTool(entry);

  if (deferred.length > 0) {
    const names = deferred.map((e) => `${e.name} (needs ${e.requiresCapability})`).join(", ");
    process.stderr.write(
      `[pidgeon-mcp] ${deferred.length} capability-gated tool(s) deferred until their package installs: ${names}. ` +
        `They register + emit tools/list_changed on install.\n`
    );
  }

  // The runtime seam a future `manage_data_packages install <pkg>` calls to bring
  // a package-gated tool online mid-session (registers it + emits list_changed).
  // Exposed on the server so the install path can reach it without re-deriving
  // the gate; unused today because nothing is package-gated. Scoped to the
  // composition roster — a capability install can never register past the
  // community/advertised boundary.
  (server as unknown as { activateCapability?: (capability: string) => string[] }).activateCapability = (capability: string) =>
    onCapabilityInstalled(registrar, roster, capability, registered);
}

// ---------------------------------------------------------------------------
// Resource registration
// ---------------------------------------------------------------------------

function registerResources(server: McpServer, transport: PidgeonTransport): void {
  // HL7 segments: two resources — index list and per-segment template
  const hl7Resources = createHl7SegmentsResources();
  for (const res of hl7Resources) {
    if (res.uri.includes("{")) {
      const template = new ResourceTemplate(res.uri, { list: undefined });
      server.resource(
        res.name,
        template,
        { description: res.description, mimeType: res.mimeType },
        async (uri, variables) => {
          const params: Record<string, string> = {};
          for (const [k, v] of Object.entries(variables ?? {})) {
            params[k] = Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
          }
          const result = await res.handler(transport, params);
          return {
            contents: result.contents.map((c) => ({
              uri: c.uri,
              mimeType: c.mimeType,
              text: c.text,
            })),
          };
        }
      );
    } else {
      server.resource(
        res.name,
        res.uri,
        { description: res.description, mimeType: res.mimeType },
        async (uri) => {
          const result = await res.handler(transport, {});
          return {
            contents: result.contents.map((c) => ({
              uri: uri.href,
              mimeType: c.mimeType,
              text: c.text,
            })),
          };
        }
      );
    }
  }

  // Vendor profiles resource
  const vendorsRes = createVendorsResource();
  server.resource(
    vendorsRes.name,
    vendorsRes.uri,
    { description: vendorsRes.description, mimeType: vendorsRes.mimeType },
    async (uri) => {
      const result = await vendorsRes.handler(transport, {});
      return {
        contents: result.contents.map((c) => ({
          uri: uri.href,
          mimeType: c.mimeType,
          text: c.text,
        })),
      };
    }
  );

  // System version resource
  const versionRes = createSystemVersionResource();
  server.resource(
    versionRes.name,
    versionRes.uri,
    { description: versionRes.description, mimeType: versionRes.mimeType },
    async (uri) => {
      const result = await versionRes.handler(transport, {});
      return {
        contents: result.contents.map((c) => ({
          uri: uri.href,
          mimeType: c.mimeType,
          text: c.text,
        })),
      };
    }
  );

  // Setup guide resource
  const setupRes = createSetupGuideResource();
  server.resource(
    setupRes.name,
    setupRes.uri,
    { description: setupRes.description, mimeType: setupRes.mimeType },
    async (uri) => {
      const result = await setupRes.handler(transport, {});
      return {
        contents: result.contents.map((c) => ({
          uri: uri.href,
          mimeType: c.mimeType,
          text: c.text,
        })),
      };
    }
  );

  // Session context resource — Bridge-held scope, saved pin sessions, AI status
  const sessionRes = createSessionResource();
  server.resource(
    sessionRes.name,
    sessionRes.uri,
    { description: sessionRes.description, mimeType: sessionRes.mimeType },
    async (uri) => {
      const result = await sessionRes.handler(transport, {});
      return {
        contents: result.contents.map((c) => ({
          uri: uri.href,
          mimeType: c.mimeType,
          text: c.text,
        })),
      };
    }
  );
}

// ---------------------------------------------------------------------------
// Prompt registration
// ---------------------------------------------------------------------------

function registerPrompts(server: McpServer, _transport: PidgeonTransport): void {
  const skipped: string[] = [];
  for (const entry of PROMPT_CATALOG) {
    // A guided workflow registers only when every tool it chains is in the
    // active composition — a prompt steering an agent to an unregistered tool
    // is a ghost surface by another door (unknown-tool errors mid-workflow).
    // Bridge sessions whose advertisement covers the chain get the full set;
    // community CLI sessions get the workflows the community roster can run.
    if (!entry.tools.every((toolName) => isToolActive(toolName))) {
      skipped.push(entry.name);
      continue;
    }
    const def = entry.factory();
    server.prompt(
      def.name,
      def.description,
      def.argsSchema.shape,
      async (args: Record<string, string>) => {
        const result = def.handler(args);
        return {
          messages: result.messages.map((msg) => ({
            role: msg.role,
            content: { type: "text" as const, text: msg.content },
          })),
        };
      }
    );
  }
  if (skipped.length > 0) {
    process.stderr.write(
      `[pidgeon-mcp] ${skipped.length} guided workflow(s) not registered — they chain tools outside ` +
        `this composition's roster: ${skipped.join(", ")}.\n`
    );
  }
}
