// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Session-context readers for bridge mode — best-effort by design. Each
// returns an "unavailable" sentinel rather than throwing, so the
// pidgeon://session resource degrades gracefully when the Bridge is
// unauthenticated (401) or the endpoint is absent on an older build.

import { AxiosInstance } from "axios";
import {
  ScopeInfo,
  LockSessionInfo,
  AiModelStatus,
  NarrationRequest,
  NarrationResult,
} from "./types.js";
import { BridgeApiResponse } from "./wire.js";

export async function readScope(http: AxiosInstance): Promise<ScopeInfo> {
  try {
    const response = await http.get<BridgeApiResponse<{
      memberships?: Array<{
        organization?: { id?: string; name?: string; tier?: string };
        facilities?: Array<{ id?: string; name?: string; kind?: string }>;
      }>;
      defaultFacilityId?: string;
      lastProduct?: string;
    }>>("/api/scope/me");
    const body = response.data;
    if (!body.success || !body.data) return { available: false, memberships: [] };
    const d = body.data;
    return {
      available: true,
      memberships: (d.memberships ?? []).map((m) => ({
        organizationId: m.organization?.id ?? "",
        organizationName: m.organization?.name ?? "",
        tier: m.organization?.tier,
        facilities: (m.facilities ?? []).map((f) => ({
          id: f.id ?? "",
          name: f.name ?? "",
          kind: f.kind,
        })),
      })),
      defaultFacilityId: d.defaultFacilityId,
      lastProduct: d.lastProduct,
    };
  } catch {
    return { available: false, memberships: [] };
  }
}

export async function readLockSessions(http: AxiosInstance): Promise<LockSessionInfo[]> {
  try {
    const response = await http.get<BridgeApiResponse<Array<{
      name?: string;
      scope?: string;
      description?: string;
      lockedValues?: Record<string, string>;
      createdAt?: string;
    }>>>("/api/lock-sessions");
    const body = response.data;
    if (!body.success || !body.data) return [];
    return body.data.map((s) => ({
      name: s.name ?? "",
      scope: s.scope ?? "Custom",
      description: s.description,
      lockedValues: s.lockedValues ?? {},
      createdAt: s.createdAt,
    }));
  } catch {
    return [];
  }
}

export async function readAiModelStatus(http: AxiosInstance): Promise<AiModelStatus> {
  try {
    const response = await http.get<BridgeApiResponse<{
      ollamaAvailable?: boolean;
      pulledTags?: string[];
      recommendation?: {
        primaryModelId?: string;
        primaryTag?: string;
        fallbackModelId?: string;
        detectedRamGb?: number;
        rationale?: string;
      };
    }>>("/api/ai/models/status");
    const body = response.data;
    if (!body.success || !body.data) {
      return { available: false, ollamaAvailable: false, pulledTags: [], ready: false };
    }
    const d = body.data;
    const ollamaAvailable = Boolean(d.ollamaAvailable);
    const pulledTags = d.pulledTags ?? [];
    return {
      available: true,
      ollamaAvailable,
      pulledTags,
      recommendedModelId: d.recommendation?.primaryModelId,
      recommendedTag: d.recommendation?.primaryTag,
      fallbackModelId: d.recommendation?.fallbackModelId,
      detectedRamGb: d.recommendation?.detectedRamGb,
      rationale: d.recommendation?.rationale,
      ready: ollamaAvailable && pulledTags.length > 0,
    };
  } catch {
    return { available: false, ollamaAvailable: false, pulledTags: [], ready: false };
  }
}

export async function requestNarration(
  http: AxiosInstance,
  request: NarrationRequest
): Promise<NarrationResult | null> {
  try {
    const response = await http.post<BridgeApiResponse<{
      narratedFix?: string;
      providerId?: string;
      tokensUsed?: number;
    }>>("/api/ai/triage/narrate", request);
    const body = response.data;
    if (!body.success || !body.data || !body.data.narratedFix) {
      // Narration unavailable (no on-device model, cloud provider active) —
      // the caller keeps the procedural fix.
      return null;
    }
    return {
      narratedFix: body.data.narratedFix,
      providerId: body.data.providerId,
      tokensUsed: body.data.tokensUsed,
    };
  } catch {
    // Never let a narration failure break the triage — degrade to procedural.
    return null;
  }
}
