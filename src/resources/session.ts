// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { PidgeonTransport, AiModelStatus } from "../transport/index.js";
import { ResourceDefinition } from "./hl7-segments.js";
import { retrieval, SUBSTRATE_LABEL } from "./provenance.js";

// ---------------------------------------------------------------------------
// On-device AI posture — the single source of truth for how Pidgeon's
// AI-assisted tools are powered. Surfaced in pidgeon://session, pidgeon://version,
// and the generated manifest so an agent learns the posture from any of them.
//
// On-device is the free default lane: AI-assisted tools run a bundled local model
// (no API key, no PHI to the cloud). BYOK is optional and never required. The
// always-free `explain_error` tool needs no model at all.
// ---------------------------------------------------------------------------

export const AI_POSTURE = {
  default: "on-device",
  model: "Qwen3-4B (bundled, served via Ollama)",
  byok: "optional — never required",
  noPhiToCloud: true,
  setupCommand: "pidgeon ai download qwen3-4b",
  note:
    "AI-assisted tools (refine_hl7_segment) default to a bundled on-device model — no API key, " +
    "no PHI leaves the machine. Run `pidgeon ai download qwen3-4b` once to set it up; BYOK is " +
    "optional. The free explain_error tool needs no model at all.",
} as const;

/** Merge the static on-device posture with live Bridge model status (Bridge mode only). */
export function aiStatusBlock(status: AiModelStatus): Record<string, unknown> {
  return {
    ...AI_POSTURE,
    bridgeStatus: status.available
      ? {
          ollamaAvailable: status.ollamaAvailable,
          modelsPulled: status.pulledTags,
          recommendedModel: status.recommendedModelId ?? null,
          recommendedTag: status.recommendedTag ?? null,
          fallbackModel: status.fallbackModelId ?? null,
          detectedRamGb: status.detectedRamGb ?? null,
          ready: status.ready,
          rationale: status.rationale ?? null,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Session context resource
// ---------------------------------------------------------------------------

export function createSessionResource(): ResourceDefinition {
  return {
    uri: "pidgeon://session",
    name: "Pidgeon Session Context",
    description:
      "The durable, server-held context an agent shares with the human at the workbench: the " +
      "active organization/facility scope, the user's saved field-pin sessions, and the on-device " +
      "AI model status. Bridge-mode only — live in-pane state (current message, version, vendor) " +
      "is client-held and not read here. One surface, two drivers: read this to orient before acting.",
    mimeType: "application/json",
    handler: async (transport: PidgeonTransport, _uriParams: Record<string, string>) => {
      const mode = transport.getMode();

      const [scope, lockSessions, ai] = await Promise.all([
        transport.getScope(),
        transport.listLockSessions(),
        transport.getAiModelStatus(),
      ]);

      const hasBridgeContext = scope.available || lockSessions.length > 0 || ai.available;

      // Uniform provenance + staleness for the whole workspace-fact read (H-31/H-32):
      // name WHICH SUBSTRATE answered and stamp the point-in-time contract, so an
      // agent knows this is a snapshot to re-verify before it gates a write.
      const retrievedFrom = hasBridgeContext ? "bridge" : "unavailable";

      const result = {
        server: "pidgeon-mcp",
        mode,
        ...retrieval(retrievedFrom, {
          stalenessAddendum:
            "Saved pins are a snapshot the human curated; the live message in the pane may differ.",
        }),
        description:
          "Server-held context shared between the human at the workbench and an agent. " +
          "Read this to orient: who/where the user is scoped to, what field pins they have saved, " +
          "and whether on-device AI is ready. Live in-pane state is client-held and not surfaced here.",
        note: hasBridgeContext
          ? undefined
          : "Session context (scope, saved field-pin sessions, on-device model status) is served only " +
            "in Bridge mode with an authenticated session. Set PIDGEON_MODE=bridge and run `pidgeon auth login`.",
        scope: {
          source: scope.available ? "bridge" : "unavailable",
          sourceLabel: SUBSTRATE_LABEL[scope.available ? "bridge" : "unavailable"],
          available: scope.available,
          organizations: scope.memberships.map((m) => ({
            id: m.organizationId,
            name: m.organizationName,
            tier: m.tier ?? null,
            facilities: m.facilities.map((f) => ({ id: f.id, name: f.name, kind: f.kind ?? null })),
          })),
          defaultFacilityId: scope.defaultFacilityId ?? null,
          lastProduct: scope.lastProduct ?? null,
        },
        lockSessions: {
          source: lockSessions.length > 0 ? "bridge" : "unavailable",
          sourceLabel: SUBSTRATE_LABEL[lockSessions.length > 0 ? "bridge" : "unavailable"],
          // A saved pin set is a point-in-time claim: re-verify the live message
          // before a pinned value gates a downstream action (H-31).
          staleness:
            "Pinned values are a saved snapshot the human curated — re-verify against the live " +
            "message (validate_message) before a pin gates a downstream write.",
          count: lockSessions.length,
          // Saved field-pin sets the human curated — an agent can pass one by name
          // to generate_message (lockSessionName) to reproduce the human's pinned data.
          sessions: lockSessions.map((s) => ({
            name: s.name,
            scope: s.scope,
            description: s.description ?? null,
            pinnedFields: Object.keys(s.lockedValues),
            lockedValues: s.lockedValues,
            createdAt: s.createdAt ?? null,
          })),
        },
        ai: {
          source: ai.available ? "bridge" : "unavailable",
          sourceLabel: SUBSTRATE_LABEL[ai.available ? "bridge" : "unavailable"],
          ...aiStatusBlock(ai),
        },
      };

      return {
        contents: [
          {
            uri: "pidgeon://session",
            mimeType: "application/json",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  };
}
