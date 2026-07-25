// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Shared interfaces for the transport layer.
// Both BridgeClient and CliClient implement PidgeonTransport so tools can use either.

import type { SemanticReviewOptions, SemanticReviewResult, SemanticFinding } from "./semantic.js";
import type { LockedValue, GenerateResult } from "./generate-types.js";
import type { FieldSpecResult, Icd10Match } from "./reference-types.js";
import type { ToolUsageEvent } from "./usage-types.js";

export type Tier = "free" | "pro" | "enterprise";

export interface GenerateOptions {
  count?: number;
  vendor?: string;
  hl7Version?: string;
  seed?: number;
  standard?: string;
  lockedValues?: LockedValue[];   // pins; mutually exclusive with lockSessionName
  lockSessionName?: string;       // a saved pin session's name
}

export interface ValidateOptions {
  mode?: "strict" | "compatibility";
  standard?: string;
  vendorProfile?: string;
}

export interface DiffOptions {
  standard?: string;
  ignoredFields?: string[];
}

export interface DeidentifyOptions {
  dateShift?: string;
  salt?: string;
}

export interface AnalyzePatternOptions {
  save?: string;
  vendor?: string;
}

export interface WorkflowOptions {
  vendor?: string;
  count?: number;
  output?: string;
}

export interface SendOptions {
  protocol?: "sftp" | "local";
  filename?: string;
  /**
   * Retrying a send with the same key within the Bridge's replay window returns
   * the recorded outcome instead of delivering again (at-most-once semantics).
   */
  idempotencyKey?: string;
}

export interface LoftStatusOptions {
  path?: string;
  since?: string;
}

export interface PopulationOptions {
  population?: number;
  location?: string;
  format?: "sql" | "csv" | "hl7" | "fhir";
  seed?: number;
  output?: string;
}

export interface DataPackageAction {
  action: "list" | "install" | "remove" | "status";
  packageName?: string;
  acceptLicense?: boolean;
}

export interface ConformOptions {
  resource?: string;
  profile?: string;
  walk?: boolean;
  ig?: string;
  onlyResources?: string[];
  auth?: string;
  ci?: boolean;
}

export interface ConformIssue {
  severity: "error" | "warning" | "info";
  ruleId?: string;
  location?: string;
  message: string;
  suggestion?: string;
}

export interface ConformResult {
  endpoint: string;
  mode: "single" | "walk";
  passed: boolean;
  profileRequested?: string;
  resourceType?: string;
  resourceId?: string;
  httpStatusCode?: number;
  resourcesPassed?: number;
  resourcesTotal?: number;
  totalErrors?: number;
  totalWarnings?: number;
  issues: ConformIssue[];
  summary: string;
}

export interface ValidationError {
  field?: string;
  segment?: string;
  message: string;
  severity: "error" | "warning" | "info";
  ruleId?: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  conformanceScore?: number;
  standard?: string;
  messageType?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface FieldDifference {
  path: string;
  leftValue?: string;
  rightValue?: string;
  severity: "critical" | "major" | "minor" | "cosmetic";
  description?: string;
}

export interface DiffResult {
  differences: FieldDifference[];
  summary: string;
  leftSegmentCount?: number;
  rightSegmentCount?: number;
  [key: string]: unknown;
}

export interface DeidentifyResult {
  original: string;
  deidentified: string;
  fieldsModified: number;
  summary: string;
}

export interface VendorAnalysisResult {
  vendor?: string;
  patterns: Array<{ field: string; frequency: number; example?: string }>;
  summary: string;
}

export interface WorkflowResult {
  steps: Array<{ name: string; messageType: string; message: string }>;
  summary: string;
}

export interface RefineResult {
  refinedContent: string;
  isValid: boolean;
  errors: string[];
  retryCount: number;
}

export interface SendResult {
  success: boolean;
  destination: string;
  summary: string;
  /** Filename the message was delivered under (Bridge mode).*/
  filename?: string;
  /** True when the outcome was replayed from the idempotency cache instead of re-delivering. */
  replayed?: boolean;
}

export interface LoftStatusResult {
  interfaces: Array<{
    name: string;
    status: "healthy" | "warning" | "error" | "unknown";
    messageCount?: number;
    errorRate?: number;
    lastMessage?: string;
  }>;
  summary: string;
}

export interface PopulationResult {
  patientCount: number;
  format: string;
  output?: string;
  summary: string;
}

/**
 * Outcome of starting a population generation. The Bridge runs populations as
 * async jobs (POST /api/flock/generate returns a jobId; progress via
 * GET /api/flock/generate/{id}); the CLI transport runs synchronously and
 * returns `completed` directly. Exactly one of the two fields is set.
 */
export interface PopulationStartResult {
  jobId?: string;
  completed?: PopulationResult;
}

/** Mirrors the Bridge FlockJobResponse (camelCase wire). */
export interface PopulationJobStatus {
  id: string;
  status: string;
  totalCount: number;
  generatedCount: number;
  progressPercent: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  validationErrorCount?: number;
}

export interface DataPackageInfo {
  name: string;
  installed: boolean;
  recordCount?: string;
  license?: string;
  size?: string;
  // Catalog metadata the Bridge /api/data endpoint also emits (DataPackageInfoDto).
  // Optional so the CLI transport (formats from `pidgeon data --output json`) stays
  // compatible if it hasn't surfaced these yet.
  requiresLicense?: boolean;
  dataType?: string;
  description?: string;
  version?: string;
}

// ---------------------------------------------------------------------------
// Local artifact discovery (ARTIFACT_ECOSYSTEM_PROGRAM.md §5.3) — one search
// over the artifact sources already on the machine: the embedded starter
// recipe pack, installed recipes, and the data-package registry. Both
// transports project the same Core IArtifactCatalogService (H-1): the CLI
// shells `pidgeon artifacts search/list`, the Bridge GETs /api/artifacts/search.
// ---------------------------------------------------------------------------

export interface ArtifactSearchParams {
  /** Free-text terms; omit (or blank) to list everything the facets admit. */
  query?: string;
  /** vendor-profile | generation-config | data-package. */
  kind?: string;
  vendor?: string;
  standard?: string;
  messageType?: string;
  installedOnly?: boolean;
  limit?: number;
}

/** One discovered artifact (the agent-legible projection every surface renders). */
export interface ArtifactSearchItem {
  id: string;
  name: string;
  kind: string;
  title: string;
  description: string;
  vendor?: string | null;
  standard?: string | null;
  messageType?: string | null;
  source: string;
  installed: boolean;
  installCommand: string;
  forkedFrom?: string | null;
}

export interface ArtifactSearchResult {
  query?: string | null;
  total: number;
  truncated: boolean;
  items: ArtifactSearchItem[];
}

// ---------------------------------------------------------------------------
// Session context (Bridge-only, read-only) — the durable workbench context an
// agent reads to orient itself in the same world the human is working in.
// Live in-pane state (active message, version, vendor) is client-held and not
// Bridge-readable; what IS server-held and readable is the user's scope, their
// saved field-pin sessions, and the on-device AI posture. See
// the one-surface audit note.
// ---------------------------------------------------------------------------

export interface ScopeFacilityInfo {
  id: string;
  name: string;
  kind?: string;
}

export interface ScopeMembershipInfo {
  organizationId: string;
  organizationName: string;
  tier?: string;
  facilities: ScopeFacilityInfo[];
}

export interface ScopeInfo {
  // false in CLI mode or when the Bridge is unauthenticated (401) — the agent
  // should read this before trusting the rest of the block.
  available: boolean;
  memberships: ScopeMembershipInfo[];
  defaultFacilityId?: string;
  lastProduct?: string;
}

export interface LockSessionInfo {
  name: string;
  scope: string;
  description?: string;
  lockedValues: Record<string, string>;
  createdAt?: string;
}

// A loaded vendor interface profile summary — a durable workspace fact read from
// the Bridge's GET /api/vendor-profiles surface. Metadata only: the read surface
// never carries a sample-message BODY (message content is not surfaced as memory;
// H-29/H-33). Mirrors the Bridge VendorProfileSummaryDto.
export interface VendorProfileInfo {
  key: string;            // "epic/adt_outbound"
  vendor: string;
  interfaceName: string;
  standard: string;       // hl7 | fhir | ncpdp
  version: string;
  direction: string;      // inbound | outbound | bidirectional
  messageTypes: string[];
  marketCategory?: string;
}

// A finding plus its procedural triage, sent to the on-device narrator to be
// reworded. Mirrors the C# NarrateRequest. All domain phrasing is pre-composed
// by the caller (explain_error) — the Bridge/narrator never parses the standard.
export interface NarrationRequest {
  findingMessage?: string;
  proceduralWhat?: string;
  proceduralWhy?: string;
  proceduralFix: string;
  location?: string;
  standard?: string;
  messageType?: string;
}

export interface NarrationResult {
  narratedFix: string;
  providerId?: string;
  tokensUsed?: number;
}

export interface AiModelStatus {
  // false in CLI mode or when the status read fails — distinct from `ready`.
  available: boolean;
  ollamaAvailable: boolean;
  pulledTags: string[];
  recommendedModelId?: string;
  recommendedTag?: string;
  fallbackModelId?: string;
  detectedRamGb?: number;
  rationale?: string;
  // Ollama is up AND at least one bundled model is pulled — AI-assisted tools
  // (refine) can run on-device with no key. When false, the agent degrades.
  ready: boolean;
}

export interface PidgeonTransport {
  // Auth. forceRefresh bypasses the transport's tier cache — used by the
  // tool gate when a denial is imminent, so a mid-session upgrade takes
  // effect without an MCP restart.
  getTier(forceRefresh?: boolean): Promise<Tier>;

  // The server-advertised entitled MCP tool roster (GET /api/mcp/tools). The
  // registration boundary for Bridge mode: the adapter registers exactly these
  // names — a client-side tier label never materializes a tool. Returns null
  // when no advertisement is available (CLI mode, an older Bridge build without
  // the endpoint, or the Bridge unreachable), and the caller fails closed to
  // the community allowlist. Never throws.
  getAdvertisedTools(): Promise<string[] | null>;

  // Core tools (existing)
  generate(messageType: string, options?: GenerateOptions): Promise<GenerateResult>;
  validate(message: string, options?: ValidateOptions): Promise<ValidationResult>;
  diff(leftMessage: string, rightMessage: string, options?: DiffOptions): Promise<DiffResult>;

  // New tools
  deidentify(message: string, options?: DeidentifyOptions): Promise<DeidentifyResult>;
  analyzeVendorPattern(messages: string[], options?: AnalyzePatternOptions): Promise<VendorAnalysisResult>;
  runWorkflow(scenario: string, options?: WorkflowOptions): Promise<WorkflowResult>;
  sendMessage(message: string, destination: string, options?: SendOptions): Promise<SendResult>;
  loftStatus(options?: LoftStatusOptions): Promise<LoftStatusResult>;
  generatePopulation(options: PopulationOptions): Promise<PopulationStartResult>;
  // Poll a population job started by generatePopulation (Bridge mode). Throws in
  // CLI mode, where generation completes synchronously and there is no job.
  getPopulationJob(jobId: string): Promise<PopulationJobStatus>;
  conform(endpoint: string, options?: ConformOptions): Promise<ConformResult>;
  manageDataPackages(action: DataPackageAction): Promise<DataPackageInfo[] | string>;
  // Local artifact discovery (free, read-only): starter recipes, installed
  // recipes, and data packages via the one Core catalog search (H-1).
  searchArtifacts(params: ArtifactSearchParams): Promise<ArtifactSearchResult>;
  refine(messageContent: string, prompt: string, options?: {
    originalMessage?: string;
    standard?: string;
    profile?: string;
    segmentContent?: string;
    segmentIndex?: number;
  }): Promise<RefineResult>;

  // Session context (Bridge-only reads; CLI degrades to unavailable sentinels)
  getScope(): Promise<ScopeInfo>;
  listLockSessions(): Promise<LockSessionInfo[]>;
  getAiModelStatus(): Promise<AiModelStatus>;

  // On-device triage narration. Returns null when narration is unavailable —
  // no Bridge (CLI mode), no on-device model, or a cloud provider is active —
  // so the caller keeps the procedural fix. Never throws for those cases.
  narrate(request: NarrationRequest): Promise<NarrationResult | null>;

  // Advisory clinical-sense review (on-device LLM judge). Throws when the judge
  // is unavailable — no Bridge (CLI mode), no on-device model, or the PHI guard
  // refusing the active provider — so the tool degrades to an advisory note.
  semanticReview(message: string, options?: SemanticReviewOptions): Promise<SemanticReviewResult>;

  // Deterministic clinical-checks tier (free, offline, dataset-fed rules). Returns
  // the advisory rule findings (Source = Rule). Throws in CLI mode (Bridge-only here).
  clinicalCheck(message: string): Promise<SemanticFinding[]>;

  // Reference lookups against the Bridge oracle. Throw in CLI mode / when the
  // Bridge is down; the tools fall back to their embedded reference tables.
  getFieldSpec(segment: string, position: number, version?: string): Promise<FieldSpecResult>;
  lookupIcd10(query: string): Promise<Icd10Match[]>;

  // Loaded vendor interface profiles (workspace facts). Throws in CLI mode /
  // when the Bridge is down so the pidgeon://vendors resource falls back to its
  // embedded common-vendors catalog with honest "which substrate answered"
  // provenance (the reference-lookup fallback pattern, applied to workspace facts).
  listVendorProfiles(): Promise<VendorProfileInfo[]>;

  // Per-tool usage counters (H-§5.3). Fire-and-forget: the MCP surface records one
  // enumerated, content-free event per tool dispatch; the Bridge stores it under
  // telemetry consent (off by default). Never load-bearing — implementations
  // swallow failures so a telemetry outage can't affect a tool result. The CLI
  // transport no-ops (no Bridge store to write to).
  recordToolUsage(event: ToolUsageEvent): Promise<void>;

  // Transport meta
  isAvailable(): Promise<boolean>;
  getMode(): string;
}

export interface TransportConfig {
  mode: "bridge" | "cli";
  bridge?: {
    baseUrl: string;
    apiKey?: string;
    timeout?: number;
  };
  cli?: {
    cliPath: string;
    timeout?: number;
  };
}

// Thrown when the Bridge rejects a request due to insufficient subscription tier.
// Caught in server.ts to surface a friendly upgrade message instead of a raw error.
export class TierError extends Error {
  readonly currentTier: string;
  readonly requiredTier: string;

  constructor(message: string, currentTier = "free", requiredTier = "pro") {
    super(message);
    this.name = "TierError";
    this.currentTier = currentTier;
    this.requiredTier = requiredTier;
  }
}
