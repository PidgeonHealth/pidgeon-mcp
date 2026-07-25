// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { BridgeClient } from "./bridge.js";
import { CliClient } from "./cli.js";
import { PidgeonTransport, TransportConfig } from "./types.js";

export { BridgeClient } from "./bridge.js";
export { CliClient } from "./cli.js";
export type {
  PidgeonTransport,
  TransportConfig,
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
  ConformIssue,
  ConformResult,
  ValidationResult,
  ValidationError,
  DiffResult,
  FieldDifference,
  DeidentifyResult,
  VendorAnalysisResult,
  WorkflowResult,
  SendResult,
  LoftStatusResult,
  PopulationResult,
  DataPackageInfo,
  ArtifactSearchParams,
  ArtifactSearchItem,
  ArtifactSearchResult,
  ScopeInfo,
  ScopeMembershipInfo,
  ScopeFacilityInfo,
  LockSessionInfo,
  VendorProfileInfo,
  AiModelStatus,
  NarrationRequest,
  NarrationResult,
} from "./types.js";
export type { LockedValue, GenerateResult } from "./generate-types.js";
export type { ToolUsageEvent, ToolEventKind, ToolCallOutcome } from "./usage-types.js";
export type { FieldSpecResult, Icd10Match } from "./reference-types.js";
export type {
  SemanticReviewOptions,
  SemanticFinding,
  SemanticReviewResult,
} from "./semantic.js";
export { normalizeConformReport } from "./conform-normalize.js";
export { TierError } from "./types.js";
export { ThrottleError } from "./errors.js";

export function createTransport(config: TransportConfig): PidgeonTransport {
  if (config.mode === "cli") {
    return new CliClient({
      cliPath: config.cli?.cliPath ?? "pidgeon",
      timeout: config.cli?.timeout,
    });
  }

  return new BridgeClient({
    baseUrl: config.bridge?.baseUrl ?? "http://localhost:5100",
    apiKey: config.bridge?.apiKey,
    timeout: config.bridge?.timeout,
  });
}

export function createTransportFromEnv(): PidgeonTransport {
  const mode = (process.env["PIDGEON_MODE"] ?? "bridge") as "bridge" | "cli";

  return createTransport({
    mode,
    bridge: {
      baseUrl: process.env["PIDGEON_BRIDGE_URL"] ?? "http://localhost:5100",
      apiKey: process.env["PIDGEON_API_KEY"],
    },
    cli: {
      cliPath: process.env["PIDGEON_CLI_PATH"] ?? "pidgeon",
    },
  });
}
