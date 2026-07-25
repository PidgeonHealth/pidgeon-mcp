// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ToolDefinition } from "./tools/types.js";
import { Tier } from "./transport/index.js";

// Tools — Free tier
import { createGenerateTool } from "./tools/generate.js";
import { createValidateTool } from "./tools/validate.js";
import { createExplainTool } from "./tools/explain.js";
import { createExplainErrorTool } from "./tools/explain-error.js";
import { createLookupTool } from "./tools/lookup.js";
import { createSegmentSpecTool } from "./tools/segment-spec.js";
import { createDeidentifyTool } from "./tools/deidentify.js";
import { createDataPackagesTool } from "./tools/data-packages.js";
import { createSearchArtifactsTool } from "./tools/search-artifacts.js";
import { createStatusTool } from "./tools/status.js";
import { createSemanticReviewTool } from "./tools/semantic-review.js";
import { createClinicalCheckTool } from "./tools/clinical-check.js";
import { createDescribeTool } from "./tools/describe-tool.js";

// Tools — Pro tier
import { createDiffTool } from "./tools/diff.js";
import { createAnalyzeVendorTool } from "./tools/analyze-vendor.js";
import { createWorkflowTool } from "./tools/workflow.js";
import { createSendTool } from "./tools/send.js";
import { createLoftStatusTool } from "./tools/loft-status.js";
import { createGeneratePopulationTool } from "./tools/generate-population.js";
import { createPopulationStatusTool } from "./tools/population-status.js";
import { createRefineHl7SegmentTool } from "./tools/refine_hl7_segment.js";
import { createConformTool } from "./tools/conform.js";

/**
 * The single source of truth for the Pidgeon MCP tool roster and its free/Pro
 * split. Tool registration (server.ts), the self-description resource
 * (resources/system.ts), and the generated manifest (scripts/manifest.ts) all
 * read this one list rather than re-deriving the tool-to-tier mapping.
 *
 * `requiredTier` here is authoritative: server.ts gates on the catalog entry's
 * tier, and the manifest drift guard (test/manifest.test.ts) asserts each
 * entry's tier matches the live `factory().requiredTier`, so the catalog cannot
 * silently diverge from the tools it describes.
 */
export interface ToolCatalogEntry {
  name: string;
  requiredTier: Tier;
  factory: () => ToolDefinition;
  /**
   * The installable capability this tool's substrate depends on (§2.3 part 3 /
   * H-22 capability-driven registration). When set, the tool registers only once
   * its package is installed, and its arrival is announced via
   * `notifications/tools/list_changed` (see src/tools/registration.ts). Undefined
   * on every current tool — the roster is fully self-contained — so the mechanism
   * is wired ahead of the need (projected X12 / C-CDA validators), off in practice.
   */
  requiresCapability?: string;
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  // Free tier — always available, no subscription. One valid message is free.
  { name: "generate_message", requiredTier: "free", factory: createGenerateTool },
  { name: "validate_message", requiredTier: "free", factory: createValidateTool },
  { name: "explain_message", requiredTier: "free", factory: createExplainTool },
  { name: "explain_error", requiredTier: "free", factory: createExplainErrorTool },
  { name: "lookup_code", requiredTier: "free", factory: createLookupTool },
  { name: "get_segment_spec", requiredTier: "free", factory: createSegmentSpecTool },
  { name: "deidentify_message", requiredTier: "free", factory: createDeidentifyTool },
  { name: "manage_data_packages", requiredTier: "free", factory: createDataPackagesTool },
  // Local artifact discovery (ARTIFACT_ECOSYSTEM_PROGRAM.md §5.3): search the
  // starter recipe pack, installed recipes, and data packages. Free + read-only
  // — discovery is the funnel into install/activate, never account-gated.
  { name: "search_artifacts", requiredTier: "free", factory: createSearchArtifactsTool },
  { name: "pidgeon_status", requiredTier: "free", factory: createStatusTool },
  // Advisory clinical-sense review (Semantic Validation L5) — single-message,
  // on-device, advisory-only. Free showcase per NORTH_STAR; volume is capped at
  // the Bridge (cappedAiApi), never a hard 403.
  { name: "semantic_review", requiredTier: "free", factory: createSemanticReviewTool },
  // Deterministic clinical-checks tier (Semantic Validation L5) — free, offline,
  // uncapped (no model, no tokens; rides the plain Bridge /api group).
  { name: "clinical_check", requiredTier: "free", factory: createClinicalCheckTool },
  // Meta-tool (H-22 disclosure ladder, §2.3): returns any tool's full contract on
  // demand — the protocol-native, client-agnostic analogue of schema-on-demand.
  // Free and uncapped; a pure read of this catalog (never unlocks a Pro tool).
  { name: "describe_tool", requiredTier: "free", factory: createDescribeTool },
  // Pro tier — production volume, team leverage, and live-interface tools.
  { name: "diff_messages", requiredTier: "pro", factory: createDiffTool },
  { name: "analyze_vendor_pattern", requiredTier: "pro", factory: createAnalyzeVendorTool },
  { name: "run_workflow", requiredTier: "pro", factory: createWorkflowTool },
  { name: "send_message", requiredTier: "pro", factory: createSendTool },
  { name: "loft_status", requiredTier: "pro", factory: createLoftStatusTool },
  { name: "generate_population", requiredTier: "pro", factory: createGeneratePopulationTool },
  // Poll half of the population job model (the Bridge runs Flock generation as
  // async jobs). Pro like its start tool — the pair shares one entitlement.
  { name: "population_status", requiredTier: "pro", factory: createPopulationStatusTool },
  // generate_scenario_stream was merged into run_workflow (they called the
  // identical transport op with contradictory scenario vocabularies); see
  // the agent tool-surface design note.
  { name: "refine_hl7_segment", requiredTier: "pro", factory: createRefineHl7SegmentTool },
  { name: "conform", requiredTier: "pro", factory: createConformTool },
];
