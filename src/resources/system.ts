// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { PidgeonTransport } from "../transport/index.js";
import { ResourceDefinition } from "./hl7-segments.js";
import { aiStatusBlock } from "./session.js";
import { TOOL_CATALOG } from "../catalog.js";
import { PROMPT_CATALOG, promptTierBreakdown } from "../prompts/catalog.js";
import { getActiveComposition, isToolActive } from "../composition.js";
import { firstSentence } from "../tools/format.js";
import { PKG_VERSION } from "../version.js";

// ---------------------------------------------------------------------------
// Resource factory
// ---------------------------------------------------------------------------

export function createSystemVersionResource(): ResourceDefinition {
  return {
    uri: "pidgeon://version",
    name: "Pidgeon Version Info",
    description:
      "Machine-readable self-description: server version, transport mode, resolved tier, " +
      "the full tool roster with per-tool tier, free-tier volume state, and the prompt/resource catalog. " +
      "An agent reads this once to learn what Pidgeon can do, at what tier, in what state.",
    mimeType: "application/json",
    handler: async (transport: PidgeonTransport, _uriParams: Record<string, string>) => {
      const bridgeAvailable = await transport.isAvailable();
      const mode = transport.getMode();

      let version = PKG_VERSION;
      let tier: string | undefined;
      type VolumeState = {
        enforced: boolean;
        freeGenerate: { dailyCap: number; remaining: number; resetsAt: string };
      };
      let volume: VolumeState | undefined;

      if (bridgeAvailable && mode === "bridge") {
        try {
          // BridgeClient exposes getHealth() beyond the PidgeonTransport interface.
          // Access it via duck-typing to avoid a hard dependency on BridgeClient.
          const bridgeExtended = transport as unknown as {
            getHealth?: () => Promise<{ status?: string; version?: string; tier?: string; volume?: VolumeState }>;
            getAuthProfile?: () => Promise<{
              isAuthenticated: boolean;
              tier?: string;
            }>;
          };

          if (bridgeExtended.getHealth) {
            const health = await bridgeExtended.getHealth();
            if (health.version) version = health.version;
            if (health.tier) tier = health.tier;
            if (health.volume) volume = health.volume;
          }

          if (!tier && bridgeExtended.getAuthProfile) {
            const auth = await bridgeExtended.getAuthProfile();
            if (auth.tier) tier = auth.tier;
          }
        } catch {
          // Bridge health check failed; continue with defaults.
        }
      }

      // The tool roster is the ACTIVE composition (community allowlist in CLI
      // mode, the server-advertised entitled set in Bridge mode) — this list
      // cannot drift from what the server actually registered, and it never
      // describes a tool the session cannot call.
      const activeCatalog = TOOL_CATALOG.filter((e) => isToolActive(e.name));
      const tools = activeCatalog.map((entry) => {
        const def = entry.factory();
        return {
          name: entry.name,
          tier: entry.requiredTier,
          summary: firstSentence(def.description),
        };
      });
      const freeCount = activeCatalog.filter((e) => e.requiredTier === "free").length;
      const composition = getActiveComposition();

      // Prompt roster + per-workflow free/Pro split, from the one PROMPT_CATALOG —
      // filtered the same way registration filters (a workflow appears only when
      // every tool it chains is in the active roster).
      const prompts = PROMPT_CATALOG.filter((entry) => entry.tools.every((t) => isToolActive(t))).map((entry) => {
        const def = entry.factory();
        const split = promptTierBreakdown(entry);
        return {
          name: entry.name,
          summary: firstSentence(def.description),
          tiers: { free: split.free, pro: split.pro },
          freePaidNote: entry.freePaidNote,
        };
      });

      // On-device AI posture + live model status (sentinel in CLI mode).
      const ai = aiStatusBlock(await transport.getAiModelStatus());

      const result = {
        server: "pidgeon-mcp",
        version,
        mode,
        bridgeAvailable,
        tier: tier ?? (bridgeAvailable ? "unknown" : "offline"),
        // How this session's roster was resolved: the checked-in community
        // allowlist (CLI mode / Bridge fallback) or the Bridge's authenticated
        // entitled-capability advertisement. Tools outside the roster are not
        // registered here — paid capabilities appear when the Bridge advertises
        // them for your subscription. Upgrade at https://pidgeon.health/upgrade.
        composition: composition?.source ?? "full-catalog",
        toolCounts: {
          total: activeCatalog.length,
          free: freeCount,
          pro: activeCatalog.length - freeCount,
        },
        tools,
        // Free-tier volume state. The soft cap (warn at 80%, throttle to ~1/min at
        // the ceiling, never a hard 403) is enforced by the Bridge on /api/generate;
        // an agent reads `remaining`/`resetsAt` here to self-pace before hitting it.
        // When the Bridge reports state (bridge mode), it's live; otherwise (cli mode
        // / no Bridge) it falls back to the not-yet-enforced shape — one message is
        // always free.
        volume: {
          rule: "One valid message is free; production volume, team leverage, and live-interface tools are paid.",
          enforced: volume?.enforced ?? false,
          freeGenerate: volume?.freeGenerate ?? { dailyCap: null, remaining: null, resetsAt: null },
        },
        promptCount: prompts.length,
        prompts,
        ai,
        resources: [
          "pidgeon://hl7/segments — HL7 segment index",
          "pidgeon://hl7/segments/{segmentCode} — per-segment field specifications",
          "pidgeon://vendors — loaded vendor interface profiles (Bridge) or embedded catalog, with provenance + staleness",
          "pidgeon://version — this document",
          "pidgeon://session — durable session context (scope, saved pins, AI status; provenance + staleness; Bridge mode)",
          "pidgeon://setup-guide — install + troubleshooting guide",
        ],
        transports: {
          cli: "PIDGEON_MODE=cli — spawns the pidgeon CLI; zero-auth showcase surface",
          bridge: "PIDGEON_MODE=bridge — authenticated HTTP Bridge capability surface",
        },
        manifest: "See MANIFEST.md / manifest.json for the full machine-readable tool + input-schema contract.",
      };

      return {
        contents: [
          {
            uri: "pidgeon://version",
            mimeType: "application/json",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  };
}
