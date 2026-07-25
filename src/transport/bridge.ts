// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import axios, { AxiosError, AxiosInstance } from "axios";
import {
  PidgeonTransport,
  Tier,
  GenerateOptions,
  ValidateOptions,
  DiffOptions,
  DeidentifyOptions,
  AnalyzePatternOptions,
  WorkflowOptions,
  SendOptions,
  LoftStatusOptions,
  PopulationOptions,
  DataPackageAction,
  ConformOptions,
  ConformResult,
  ValidationResult,
  DiffResult,
  DeidentifyResult,
  VendorAnalysisResult,
  WorkflowResult,
  SendResult,
  LoftStatusResult,
  PopulationStartResult,
  PopulationJobStatus,
  DataPackageInfo,
  ArtifactSearchParams,
  ArtifactSearchResult,
  RefineResult,
  ScopeInfo,
  LockSessionInfo,
  VendorProfileInfo,
  AiModelStatus,
  NarrationRequest,
  NarrationResult,
  TierError,
} from "./types.js";
import { ToolUsageEvent } from "./usage-types.js";
import { ThrottleError, BridgeError } from "./errors.js";
import { GenerateResult } from "./generate-types.js";
import { FieldSpecResult, Icd10Match } from "./reference-types.js";
import { SemanticReviewOptions, SemanticReviewResult, SemanticFinding } from "./semantic.js";
import { normalizeConformReport } from "./conform-normalize.js";
import {
  normalizeValidationResult,
  normalizeDiffResult,
  normalizeLoftStatus,
  normalizeFieldSpec,
} from "./wire-normalize.js";
import {
  BridgeApiResponse,
  unwrap,
  toGenerateBody,
  extractGenerateHeaders,
  toValidateBody,
  toRefineBody,
  toWorkflowBody,
  toSemanticReviewBody,
  toClinicalCheckBody,
  toFlockGenerateBody,
  toSendBody,
  RefineOptions,
} from "./wire.js";
import {
  readScope,
  readLockSessions,
  readAiModelStatus,
  requestNarration,
} from "./bridge-session.js";

export interface BridgeConfig {
  baseUrl: string;
  apiKey?: string;
  timeout?: number;
}

export class BridgeClient implements PidgeonTransport {
  private readonly http: AxiosInstance;
  private cachedTier: Tier | null = null;

  constructor(config: BridgeConfig) {
    this.http = axios.create({
      baseURL: config.baseUrl.replace(/\/$/, ""),
      timeout: config.timeout ?? 30000,
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
    });

    // Intercept 402/403 responses and convert them to TierError so tool handlers
    // can surface a consistent upgrade message instead of a raw HTTP error.
    // Also intercept connection errors to surface actionable setup instructions.
    this.http.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const isConnError =
          error.code === "ECONNREFUSED" || error.code === "ECONNRESET" || error.code === "ENOTFOUND";

        // The Bridge may be mid-startup: auto-start polls only ~10s, and a cold
        // `dotnet run` (JIT + build) can exceed that. Retry a connection error a few
        // times with backoff before surfacing the "not running" guidance, so a slow
        // cold start on the first tool call is not reported as dead.
        const cfg = error.config;
        if (isConnError && cfg) {
          const cfgWithRetry = cfg as typeof cfg & { _pidgeonRetry?: number };
          const attempt = cfgWithRetry._pidgeonRetry ?? 0;
          if (attempt < 3) {
            cfgWithRetry._pidgeonRetry = attempt + 1;
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
            return this.http.request(cfg);
          }
        }

        // Connection refused / unreachable after retries — Bridge is not running
        if (isConnError) {
          const url = config.baseUrl;
          throw new Error(
            `Pidgeon Bridge is not running at ${url}.\n\n` +
            "To fix this:\n" +
            "  1. Start a Pidgeon desktop app (Post, Flock, Loft, or Migrate) — it runs the Bridge\n" +
            "  2. Or switch to CLI mode: set PIDGEON_MODE=cli in your MCP config\n\n" +
            "Call the pidgeon_status tool for full environment diagnostics."
          );
        }

        const status = error.response?.status;
        // Free-tier volume cap (429). The Bridge degraded the loop, not broke it:
        // surface a typed ThrottleError the tool handler turns into a graceful,
        // self-paced upgrade message — never a thrown crash.
        if (status === 429) {
          const body = error.response?.data as BridgeApiResponse<unknown> | undefined;
          const t = (body?.data ?? {}) as { reason?: string; remaining?: number; resetsAt?: string };
          const msg = body?.error?.message ?? "Free daily volume cap reached.";
          throw new ThrottleError(msg, t.reason ?? "daily_cap_reached", t.remaining ?? 0, t.resetsAt ?? "");
        }
        const body = error.response?.data as BridgeApiResponse<unknown> | undefined;
        const code = body?.error?.code ?? "";

        if (status === 402 || status === 403) {
          const isTierRelated =
            status === 402 ||
            /subscription|tier|pro_required|license|upgrade|feature_gated|gated/i.test(code);

          if (isTierRelated) {
            const msg = body?.error?.message ?? "This feature requires a Pro subscription.";
            throw new TierError(msg, "free", "pro");
          }
        }

        // Any other non-2xx that carried the standard Bridge envelope: throw a
        // structured BridgeError with the server's own message + code, so every
        // tool inherits the actionable reason instead of axios prose
        // ("Request failed with status code 400"). This generalizes the
        // per-method unwraps that refine/semanticReview/dataPackages did by hand.
        if (body?.error?.message) {
          throw new BridgeError(body.error.message, code, status);
        }

        // A non-enveloped error (e.g. a 404 for an endpoint this Bridge build
        // does not expose yet): name the shape rather than leaking axios prose.
        if (status === 404) {
          throw new BridgeError(
            `The Bridge at ${config.baseUrl} returned 404 for ${error.config?.url ?? "the request"} — ` +
              "this operation may not be available in this Bridge build. " +
              "Call pidgeon_status for environment diagnostics.",
            "NOT_FOUND",
            404
          );
        }

        return Promise.reject(error);
      }
    );
  }

  getMode(): string {
    return "bridge";
  }

  // Fire-and-forget per-tool usage counter (H-§5.3). The Bridge decides — under
  // telemetry consent, off by default — whether to store it. Any failure (an
  // older Bridge without the endpoint, a transport hiccup) is swallowed: telemetry
  // is observation, never load-bearing, and must never affect a tool result.
  async recordToolUsage(event: ToolUsageEvent): Promise<void> {
    try {
      await this.http.post("/api/telemetry/tool-usage", {
        sessionId: event.sessionId,
        toolName: event.toolName,
        kind: event.kind,
        outcome: event.outcome,
      });
    } catch {
      // Intentionally ignored.
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.http.get("/api/health");
      return true;
    } catch {
      return false;
    }
  }

  async getTier(forceRefresh = false): Promise<Tier> {
    if (this.cachedTier && !forceRefresh) return this.cachedTier;
    try {
      const profile = await this.getAuthProfile();
      this.cachedTier = (profile.tier as Tier) ?? "free";
    } catch {
      this.cachedTier = "free";
    }
    return this.cachedTier;
  }

  async getAdvertisedTools(): Promise<string[] | null> {
    try {
      // GET /api/mcp/tools — the Bridge's entitled-capability advertisement
      // (McpEndpoints). The server resolves the caller's tier and returns
      // exactly the tool names that entitlement services; registration follows
      // the server, never a client-side tier label. A 404 (older Bridge build)
      // or any transport failure returns null so the caller fails closed to
      // the community allowlist.
      const response = await this.http.get<BridgeApiResponse<{ tools?: unknown }>>("/api/mcp/tools");
      const data = response.data?.data;
      if (!response.data?.success || !Array.isArray(data?.tools)) return null;
      return (data.tools as unknown[]).map(String);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Core tools — request bodies are built by the wire-mapping module (wire.ts),
  // which owns every MCP-name → Bridge-wire-name translation.
  // ---------------------------------------------------------------------------

  async generate(messageType: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    const response = await this.http.post<BridgeApiResponse<string[]>>(
      "/api/generate",
      toGenerateBody(messageType, options)
    );
    const messages = unwrap(response.data, "Generation failed");

    // The effective seed (drawn for an unseeded run) and the free-tier volume
    // ride response headers so the tool can surface reproducibility and a
    // self-pacing signal without reshaping the string[] body. Header→value
    // translation lives in wire.ts with the rest of the Bridge contract.
    const { effectiveSeed, volume } = extractGenerateHeaders(
      response.headers as Record<string, string | undefined>
    );
    return { messages, effectiveSeed, volume };
  }

  async validate(message: string, options: ValidateOptions = {}): Promise<ValidationResult> {
    // The Bridge returns the Core ValidationResult shape ({isValid, issues[],
    // statistics}); normalize to the transport contract ({errors[], warnings[]}).
    const response = await this.http.post<BridgeApiResponse<Record<string, unknown>>>(
      "/api/validate",
      toValidateBody(message, options)
    );
    return normalizeValidationResult(unwrap(response.data, "Validation failed"));
  }

  async diff(leftMessage: string, rightMessage: string, options: DiffOptions = {}): Promise<DiffResult> {
    // The Bridge returns the Core MessageDiff shape ({fieldDifferences[],
    // similarityScore}); normalize to the transport contract ({differences[]}).
    const response = await this.http.post<BridgeApiResponse<Record<string, unknown>>>("/api/diff", {
      leftMessage,
      rightMessage,
      standard: options.standard,
      ignoredFields: options.ignoredFields,
    });
    return normalizeDiffResult(unwrap(response.data, "Diff failed"));
  }

  // ---------------------------------------------------------------------------
  // New tools
  // ---------------------------------------------------------------------------

  async deidentify(message: string, options: DeidentifyOptions = {}): Promise<DeidentifyResult> {
    // Bridge wire: {deidentified, fieldsModified, summary}; the transport
    // contract additionally carries the original for diff-style rendering.
    const response = await this.http.post<BridgeApiResponse<Omit<DeidentifyResult, "original">>>(
      "/api/deidentify",
      {
        message,
        dateShift: options.dateShift,
        salt: options.salt,
      }
    );
    const result = unwrap(response.data, "De-identification failed");
    return { original: message, ...result };
  }

  async analyzeVendorPattern(
    messages: string[],
    options: AnalyzePatternOptions = {}
  ): Promise<VendorAnalysisResult> {
    const response = await this.http.post<BridgeApiResponse<VendorAnalysisResult>>("/api/config/analyze", {
      messages,
      save: options.save,
      vendor: options.vendor,
    });
    return unwrap(response.data, "Vendor analysis failed");
  }

  async runWorkflow(scenario: string, options: WorkflowOptions = {}): Promise<WorkflowResult> {
    const response = await this.http.post<BridgeApiResponse<WorkflowResult>>(
      "/api/workflow/run",
      toWorkflowBody(scenario, options)
    );
    return unwrap(response.data, "Workflow execution failed");
  }

  async refine(messageContent: string, prompt: string, options: RefineOptions = {}): Promise<RefineResult> {
    // The interceptor surfaces the Bridge's structured message on a BridgeError
    // (e.g. AI_STEER_FAILED "No settings found for active provider..." when the
    // on-device model isn't set up), so the refine tool's NO_MODEL_SIGNAL check
    // on err.message still fires and degrades gracefully.
    const response = await this.http.post<BridgeApiResponse<RefineResult>>(
      "/api/refine",
      toRefineBody(messageContent, prompt, options)
    );
    return unwrap(response.data, "Refinement failed");
  }

  async semanticReview(message: string, options: SemanticReviewOptions = {}): Promise<SemanticReviewResult> {
    // The Bridge returns 400 SEMANTIC_REVIEW_UNAVAILABLE (no on-device model, or
    // the PHI guard refused the provider) as a structured envelope; the
    // interceptor surfaces its message on a BridgeError so the tool degrades to
    // an advisory note. Tier/throttle errors stay their own types for server.ts.
    const response = await this.http.post<BridgeApiResponse<SemanticReviewResult>>(
      "/api/ai/semantic-review",
      toSemanticReviewBody(message, options)
    );
    return unwrap(response.data, "Semantic review failed");
  }

  async clinicalCheck(message: string): Promise<SemanticFinding[]> {
    const response = await this.http.post<BridgeApiResponse<{ findings: SemanticFinding[] }>>(
      "/api/clinical-checks",
      toClinicalCheckBody(message)
    );
    return unwrap(response.data, "Clinical checks failed").findings;
  }

  async getFieldSpec(segment: string, position: number, version?: string): Promise<FieldSpecResult> {
    // GET /api/lookup/field — version-aware single-field schema over the oracle,
    // covering every segment the version defines (not just the embedded subset).
    const params: Record<string, string> = { segment, position: String(position) };
    if (version) params.version = version;
    const response = await this.http.get<BridgeApiResponse<Record<string, unknown>>>(
      "/api/lookup/field",
      { params }
    );
    const dto = unwrap(response.data, `No field spec for ${segment}.${position}`);
    // Mirror the Bridge's ResolveVersion default (omitted → 2.3) in the echoed version.
    return normalizeFieldSpec(dto, segment, position, version ?? "2.3");
  }

  async lookupIcd10(query: string): Promise<Icd10Match[]> {
    // GET /api/lookup/icd10 — case-insensitive substring match over the full
    // ICD-10-CM set (code + description), so an exact code or a term both work.
    const response = await this.http.get<BridgeApiResponse<Record<string, unknown>[]>>(
      "/api/lookup/icd10",
      { params: { q: query } }
    );
    const rows = unwrap(response.data, "ICD-10 lookup failed");
    return rows.map((r) => ({
      code: String(r.code ?? ""),
      description: String(r.description ?? ""),
      category: r.category ? String(r.category) : undefined,
    }));
  }

  async listVendorProfiles(): Promise<VendorProfileInfo[]> {
    // GET /api/vendor-profiles — the loaded vendor interface profiles (a durable
    // workspace fact). Metadata only; the summary DTO carries no message bodies.
    // Throws when the Bridge is down so pidgeon://vendors falls back to the
    // embedded common-vendors catalog with honest provenance (lookup pattern).
    const response = await this.http.get<BridgeApiResponse<Record<string, unknown>[]>>(
      "/api/vendor-profiles"
    );
    const rows = unwrap(response.data, "Vendor profile listing failed");
    return rows.map((r) => ({
      key: String(r.key ?? ""),
      vendor: String(r.vendor ?? ""),
      interfaceName: String(r.interfaceName ?? ""),
      standard: String(r.standard ?? ""),
      version: String(r.version ?? ""),
      direction: String(r.direction ?? ""),
      messageTypes: Array.isArray(r.messageTypes) ? r.messageTypes.map(String) : [],
      marketCategory: r.marketCategory != null ? String(r.marketCategory) : undefined,
    }));
  }

  async sendMessage(
    message: string,
    destination: string,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const response = await this.http.post<BridgeApiResponse<SendResult>>(
      "/api/send",
      toSendBody(message, destination, options)
    );
    return unwrap(response.data, "Send failed");
  }

  async loftStatus(options: LoftStatusOptions = {}): Promise<LoftStatusResult> {
    const params: Record<string, string> = {};
    if (options.since) params.since = options.since;
    if (options.path) params.path = options.path;

    // The aggregate (LoftStatusResponse) carries overall health; the
    // per-interface table comes from /api/loft/interfaces (best-effort — the
    // aggregate alone still yields a valid summary).
    const response = await this.http.get<BridgeApiResponse<Record<string, unknown>>>(
      "/api/loft/status",
      { params }
    );
    const aggregate = unwrap(response.data, "Loft status unavailable");

    let interfaceList: Record<string, unknown>[] | undefined;
    try {
      const interfaces = await this.http.get<BridgeApiResponse<Record<string, unknown>[]>>(
        "/api/loft/interfaces"
      );
      interfaceList = interfaces.data?.data ?? undefined;
    } catch {
      // Aggregate-only summary.
    }

    return normalizeLoftStatus(aggregate, interfaceList);
  }

  async generatePopulation(options: PopulationOptions): Promise<PopulationStartResult> {
    // The Bridge runs populations as async jobs: this returns { jobId }.
    const response = await this.http.post<BridgeApiResponse<{ jobId?: string }>>(
      "/api/flock/generate",
      toFlockGenerateBody(options)
    );
    const data = unwrap(response.data, "Population generation failed");
    if (!data.jobId) {
      throw new Error("The Bridge did not return a population job id.");
    }
    return { jobId: data.jobId };
  }

  async getPopulationJob(jobId: string): Promise<PopulationJobStatus> {
    const response = await this.http.get<BridgeApiResponse<PopulationJobStatus>>(
      `/api/flock/generate/${encodeURIComponent(jobId)}`
    );
    return unwrap(response.data, `Population job '${jobId}' not found`);
  }

  async conform(endpoint: string, options: ConformOptions = {}): Promise<ConformResult> {
    // The interceptor surfaces a structured BridgeError (with the server's
    // message) for any failure, including a 404 if a build lacks the endpoint.
    const response = await this.http.post<BridgeApiResponse<Record<string, unknown>>>(
      options.walk ? "/api/conform/walk" : "/api/conform/probe",
      {
        endpoint,
        resource: options.resource,
        profile: options.profile,
        ig: options.ig,
        onlyResources: options.onlyResources,
        auth: options.auth,
        ci: options.ci ?? false,
      }
    );
    const data = unwrap(response.data, "Conformance probe failed");
    return normalizeConformReport(data, endpoint);
  }

  async manageDataPackages(action: DataPackageAction): Promise<DataPackageInfo[] | string> {
    // Install refused pending --accept-license, an unknown package, etc. arrive
    // as a structured BridgeError from the interceptor — the agent sees the
    // license / needs-acceptance reason, not axios prose.
    if (action.action === "list" || action.action === "status") {
      const response = await this.http.get<BridgeApiResponse<DataPackageInfo[]>>(
        `/api/data/${action.action}`
      );
      return unwrap(response.data, "Failed to list packages");
    }

    const response = await this.http.post<BridgeApiResponse<{ message: string }>>(
      `/api/data/${action.action}`,
      {
        packageName: action.packageName,
        acceptLicense: action.acceptLicense,
      }
    );
    return unwrap(response.data, `Failed to ${action.action} package`).message;
  }

  async searchArtifacts(params: ArtifactSearchParams): Promise<ArtifactSearchResult> {
    const query: Record<string, string> = {};
    if (params.query) query.query = params.query;
    if (params.kind) query.kind = params.kind;
    if (params.vendor) query.vendor = params.vendor;
    if (params.standard) query.standard = params.standard;
    if (params.messageType) query.messageType = params.messageType;
    if (params.installedOnly) query.installedOnly = "true";
    if (params.limit != null) query.limit = String(params.limit);

    // The artifact route rides the flat recipe/run response posture — a plain
    // result body, and a 400 as flat `{ error: "<reason>" }` rather than the
    // standard Bridge envelope — so the interceptor passes its errors through.
    // Surface the flat reason instead of axios prose.
    try {
      const response = await this.http.get<ArtifactSearchResult>(
        "/api/artifacts/search",
        { params: query }
      );
      return response.data;
    } catch (err) {
      const flat = (err as AxiosError).response?.data as { error?: unknown } | undefined;
      if (typeof flat?.error === "string") throw new Error(flat.error);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Auth helpers
  // ---------------------------------------------------------------------------

  async getHealth(): Promise<{
    status: string;
    version?: string;
    tier?: string;
    volume?: {
      enforced: boolean;
      freeGenerate: { dailyCap: number; remaining: number; resetsAt: string };
    };
  }> {
    const response = await this.http.get("/api/health");
    return response.data;
  }

  async getAuthProfile(): Promise<{
    isAuthenticated: boolean;
    tier?: string;
    profile?: { username?: string; email?: string };
  }> {
    try {
      // W2b: /api/auth/profile rides the standard ApiResponse envelope.
      const response = await this.http.get<BridgeApiResponse<{
        isAuthenticated?: boolean;
        tier?: string;
        profile?: { username?: string; email?: string };
      }>>("/api/auth/profile");
      const data = response.data?.data;
      if (!response.data?.success || !data) return { isAuthenticated: false };
      return {
        isAuthenticated: Boolean(data.isAuthenticated),
        tier: data.tier,
        profile: data.profile,
      };
    } catch {
      return { isAuthenticated: false };
    }
  }

  // ---------------------------------------------------------------------------
  // Session context (read-only) — best-effort readers live in bridge-session.ts.
  // ---------------------------------------------------------------------------

  async getScope(): Promise<ScopeInfo> {
    return readScope(this.http);
  }

  async listLockSessions(): Promise<LockSessionInfo[]> {
    return readLockSessions(this.http);
  }

  async getAiModelStatus(): Promise<AiModelStatus> {
    return readAiModelStatus(this.http);
  }

  async narrate(request: NarrationRequest): Promise<NarrationResult | null> {
    return requestNarration(this.http, request);
  }
}
