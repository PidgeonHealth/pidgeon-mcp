// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFile } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
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
  ArtifactSearchItem,
  ArtifactSearchResult,
  RefineResult,
  ScopeInfo,
  LockSessionInfo,
  VendorProfileInfo,
  AiModelStatus,
  NarrationRequest,
  NarrationResult,
} from "./types.js";
import { SemanticReviewOptions, SemanticReviewResult, SemanticFinding } from "./semantic.js";
import { normalizeConformReport } from "./conform-normalize.js";
import { normalizeValidationResult } from "./wire-normalize.js";
import { GenerateResult } from "./generate-types.js";
import { FieldSpecResult, Icd10Match } from "./reference-types.js";
import { ToolUsageEvent } from "./usage-types.js";

export interface CliConfig {
  cliPath: string;
  timeout?: number;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Executes the CLI once. Resolves with the exit code (never rejects on a
 * nonzero exit — the caller decides); rejects only on spawn-level failures
 * (ENOENT, EACCES, timeout). Injectable so tests can pin the exact argv the
 * transport builds without spawning a real process — the drift class the
 * ergonomics audit found (`--output json` vs `--output-format json`,
 * missing `-` stdin sentinel) is caught by asserting these arrays.
 */
export type CliRunner = (
  cliPath: string,
  args: string[],
  stdin: string | undefined,
  timeoutMs: number
) => Promise<CliRunResult>;

const defaultRunner: CliRunner = (cliPath, args, stdin, timeoutMs) =>
  new Promise<CliRunResult>((resolve, reject) => {
    const child = execFile(
      cliPath,
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code !== "number") {
          // Spawn-level failure (ENOENT/EACCES string codes, timeout kill).
          reject(err);
          return;
        }
        const code = err ? Number((err as NodeJS.ErrnoException).code ?? 1) : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      }
    );
    if (stdin !== undefined) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
  });

/** The typed CLI-mode capability boundary: a named degrade, never a fabricated success. */
function bridgeModeRequired(operation: string, cliAlternative?: string): Error {
  return new Error(
    `CLI mode does not support ${operation} over MCP. ` +
      "Run the Bridge (PIDGEON_MODE=bridge) for the full tool surface" +
      (cliAlternative ? `, or run \`${cliAlternative}\` directly.` : ".")
  );
}

export class CliClient implements PidgeonTransport {
  private readonly cliPath: string;
  private readonly timeout: number;
  private readonly runner: CliRunner;
  private cachedTier: Tier | null = null;

  constructor(config: CliConfig, runner: CliRunner = defaultRunner) {
    this.cliPath = config.cliPath;
    this.timeout = config.timeout ?? 30000;
    this.runner = runner;
  }

  getMode(): string {
    return "cli";
  }

  // No advertisement in CLI mode: the roster authority is the checked-in
  // community allowlist (community-catalog.ts), never a runtime probe of the
  // installed CLI (discovery-based registration is forbidden for the public
  // composition).
  async getAdvertisedTools(): Promise<string[] | null> {
    return null;
  }

  // No Bridge store in CLI mode — the per-tool usage counters live in the Bridge's
  // usage database, so CLI mode simply doesn't record them.
  async recordToolUsage(_event: ToolUsageEvent): Promise<void> {
    return;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const result = await this.runner(this.cliPath, ["--version"], undefined, 5000);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  async getTier(forceRefresh = false): Promise<Tier> {
    if (this.cachedTier && !forceRefresh) return this.cachedTier;
    try {
      const { stdout } = await this.exec(["--quiet", "license", "status", "--output", "json"]);
      const parsed = JSON.parse(stdout.trim());
      this.cachedTier = (parsed.tier as Tier) ?? "free";
    } catch {
      this.cachedTier = "free";
    }
    return this.cachedTier;
  }

  /**
   * Runs the CLI and throws a legible error on any failure: spawn-level errors
   * get setup instructions; a nonzero exit carries the CLI's own stderr so the
   * agent reads the real complaint, never a fabricated result.
   */
  private async exec(args: string[], stdin?: string): Promise<CliRunResult> {
    let result: CliRunResult;
    try {
      result = await this.runner(this.cliPath, args, stdin, this.timeout);
    } catch (err) {
      throw new Error(this.formatSpawnError(err as NodeJS.ErrnoException));
    }

    if (result.code !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim() || "(no output)").slice(0, 2000);
      throw new Error(
        `Pidgeon CLI exited with code ${result.code} for \`pidgeon ${args.join(" ")}\`:\n${detail}`
      );
    }
    return result;
  }

  /**
   * Runs the CLI, tolerating a nonzero exit (returns the result regardless of
   * code). For commands where a nonzero exit is a legitimate outcome, not an
   * error: `validate` exits 1 when validation FAILS, `conform` exits 1 when the
   * report FAILED — both still carry a parseable JSON report on stdout. Spawn
   * failures still throw with setup instructions.
   */
  private async execPermitNonzero(args: string[], stdin?: string): Promise<CliRunResult> {
    try {
      return await this.runner(this.cliPath, args, stdin, this.timeout);
    } catch (err) {
      throw new Error(this.formatSpawnError(err as NodeJS.ErrnoException));
    }
  }

  private formatSpawnError(err: NodeJS.ErrnoException): string {
    if (err.code === "ENOENT") {
      return (
        `Pidgeon CLI not found at '${this.cliPath}'.\n\n` +
        "To fix this:\n" +
        "  1. Install .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0\n" +
        "  2. Install Pidgeon CLI: dotnet tool install --global Pidgeon.CLI --version 0.1.0-beta.1\n" +
        "  3. Restart your MCP client\n\n" +
        "Or set PIDGEON_CLI_PATH to the full path of the pidgeon executable."
      );
    }
    if (err.code === "EACCES") {
      return (
        `Permission denied running '${this.cliPath}'.\n\n` +
        "Check file permissions or reinstall: dotnet tool install --global Pidgeon.CLI --version 0.1.0-beta.1"
      );
    }
    if (err.message?.includes("ETIMEDOUT") || err.message?.includes("timed out")) {
      return `Pidgeon CLI timed out after ${this.timeout / 1000}s. The operation may need more time; try it directly with the pidgeon CLI.`;
    }
    return `Pidgeon CLI error: ${err.message}`;
  }

  // ---------------------------------------------------------------------------
  // Core tools
  // ---------------------------------------------------------------------------

  async generate(messageType: string, options: GenerateOptions = {}): Promise<GenerateResult> {
    // Pins (lockedValues / lockSessionName) are a Bridge composer feature; the
    // CLI generate command has no flag for them. Fail loudly rather than
    // silently emit an un-pinned message the agent asked to constrain.
    if (options.lockedValues?.length || options.lockSessionName) {
      throw bridgeModeRequired("field pinning (lockedValues / lockSessionName)");
    }
    // Global flags go BEFORE the subcommand: placed after it, subcommands with
    // open positionals bind them as positional VALUES (validate treated
    // `--quiet` as a file to validate). --output-format json (the global
    // stdout-format flag; the per-command --output is an output FILE path)
    // yields the agent envelope { standard, messageType, seed, ..., messages }.
    const args = ["--output-format", "json", "--quiet", "generate", messageType];
    args.push("--count", String(options.count ?? 1));
    if (options.vendor) args.push("--vendor", options.vendor);
    if (options.hl7Version) args.push("--hl7-version", options.hl7Version);
    if (options.seed !== undefined) args.push("--seed", String(options.seed));

    const { stdout } = await this.exec(args);

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      throw new Error(
        `The CLI returned unparseable generate output (expected the JSON envelope from --output-format json):\n${stdout.trim().slice(0, 500)}`
      );
    }
    const envelope = parsed as { messages?: unknown; seed?: unknown };
    if (!Array.isArray(envelope.messages)) {
      throw new Error("The CLI generate envelope carried no messages array.");
    }
    // The CLI envelope carries the effective seed; there is no free-tier volume
    // in CLI mode (no Bridge cap), so only seed is surfaced here.
    const effectiveSeed = typeof envelope.seed === "number" ? envelope.seed : undefined;
    return { messages: envelope.messages as string[], effectiveSeed };
  }

  async validate(message: string, options: ValidateOptions = {}): Promise<ValidationResult> {
    // `-` is the CLI's stdin sentinel (ValidateCommand); the mode enum names
    // are capitalized on the CLI side. Globals go before the subcommand.
    const mode = options.mode === "strict" ? "Strict" : "Compatibility";
    const args = ["--output-format", "json", "--quiet", "validate", "-", "--mode", mode];
    if (options.standard) args.push("--standard", options.standard);
    if (options.vendorProfile) args.push("--profile", options.vendorProfile);

    // `validate` exits 1 when validation FAILS — that is its CI contract, and
    // a failed verdict with parseable JSON is a successful operation here.
    const result = await this.execPermitNonzero(args, message);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.stdout.trim());
    } catch {
      // Never mint a verdict from unparseable output — the pre-repair fallback
      // here reported garbage as VALID (audit §2.3 item 1).
      const detail = (result.stderr.trim() || result.stdout.trim() || "(no output)").slice(0, 1000);
      throw new Error(
        `The CLI returned unparseable validation output (exit ${result.code}):\n${detail}`
      );
    }
    // The CLI emits the same Core ValidationResult shape as the Bridge
    // ({isValid, issues[], statistics}); one canonical normalizer for both.
    return normalizeValidationResult(parsed);
  }

  async diff(
    _leftMessage: string,
    _rightMessage: string,
    _options: DiffOptions = {}
  ): Promise<DiffResult> {
    // The pre-repair stub returned differences: [] which rendered as
    // "Messages are identical." — a false verdict (audit §2.3 item 10).
    throw bridgeModeRequired("in-memory message diff", "pidgeon diff <file1> <file2>");
  }

  async deidentify(message: string, options: DeidentifyOptions = {}): Promise<DeidentifyResult> {
    // The CLI deident is file-based (<input> <output> positionals, no stdin);
    // round-trip through a temp directory and read the real output file —
    // the content returned is what the engine actually wrote, never a
    // fabricated echo (audit §2.3 item 2).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pidgeon-mcp-deident-"));
    const inPath = path.join(dir, "in.hl7");
    const outPath = path.join(dir, "out.hl7");
    try {
      await fs.writeFile(inPath, message, "utf8");

      const args = ["--output-format", "json", "--quiet", "deident", inPath, outPath];
      if (options.dateShift) args.push("--date-shift", options.dateShift);
      if (options.salt) args.push("--salt", options.salt);

      const { stdout } = await this.exec(args);

      const deidentified = await fs.readFile(outPath, "utf8");

      let fieldsModified = 0;
      let summary = "De-identification complete.";
      try {
        // Stdout carries the serialized DeIdentificationResult summary.
        const parsed = JSON.parse(stdout.trim()) as {
          statistics?: { fieldsModified?: number; datesShifted?: number };
        };
        fieldsModified = parsed.statistics?.fieldsModified ?? 0;
        summary =
          `De-identified 1 message: ${parsed.statistics?.fieldsModified ?? 0} field(s) modified, ` +
          `${parsed.statistics?.datesShifted ?? 0} date(s) shifted.`;
      } catch {
        summary = "De-identification complete (statistics unavailable).";
      }

      return { original: message, deidentified, fieldsModified, summary };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async analyzeVendorPattern(
    _messages: string[],
    _options: AnalyzePatternOptions = {}
  ): Promise<VendorAnalysisResult> {
    // `pidgeon config analyze` renders text only (no machine channel yet).
    throw bridgeModeRequired("vendor-pattern analysis", "pidgeon config analyze <samples-dir>");
  }

  async runWorkflow(_scenario: string, _options: WorkflowOptions = {}): Promise<WorkflowResult> {
    // `pidgeon workflow run --name <scenario>` renders text only and takes no
    // vendor/count options — the Bridge is the machine surface for workflows.
    throw bridgeModeRequired("workflow execution", "pidgeon workflow run --name <scenario>");
  }

  async refine(
    _messageContent: string,
    _prompt: string,
    _options: {
      originalMessage?: string;
      standard?: string;
      profile?: string;
      segmentContent?: string;
      segmentIndex?: number;
    } = {}
  ): Promise<RefineResult> {
    // Refinement runs the AI steering + self-healing loop in the Bridge; the
    // file-based CLI has no in-memory message session to mutate.
    throw new Error(
      "CLI mode does not support in-memory segment refinement. " +
        "Run the Bridge (PIDGEON_MODE=bridge) to use refine_hl7_segment."
    );
  }

  async semanticReview(
    _message: string,
    _options: SemanticReviewOptions = {}
  ): Promise<SemanticReviewResult> {
    // The advisory judge runs over the on-device model behind the Bridge; the
    // file-based CLI transport has no judge to drive over MCP. Use Bridge mode,
    // or run `pidgeon validate --semantic` directly.
    throw new Error(
      "CLI mode does not support semantic review over MCP. " +
        "Run the Bridge (PIDGEON_MODE=bridge), or use `pidgeon validate --semantic`."
    );
  }

  async clinicalCheck(_message: string): Promise<SemanticFinding[]> {
    // The deterministic clinical checks run in-process behind the Bridge; over
    // MCP, drive them in Bridge mode. The CLI exposes the same tier directly via
    // `pidgeon validate --clinical`.
    throw new Error(
      "CLI mode does not support clinical checks over MCP. " +
        "Run the Bridge (PIDGEON_MODE=bridge), or use `pidgeon validate --clinical`."
    );
  }

  async getFieldSpec(_segment: string, _position: number, _version?: string): Promise<FieldSpecResult> {
    // No CLI endpoint returns the version-resolved field DTO the oracle serves;
    // the tool falls back to its embedded table when this throws.
    throw bridgeModeRequired("version-resolved field schema");
  }

  async lookupIcd10(_query: string): Promise<Icd10Match[]> {
    // The CLI has no code-lookup endpoint; the tool falls back to embedded codes.
    throw bridgeModeRequired("ICD-10 code lookup");
  }

  async listVendorProfiles(): Promise<VendorProfileInfo[]> {
    // No CLI endpoint lists the loaded vendor profiles; the pidgeon://vendors
    // resource falls back to its embedded common-vendors catalog when this throws.
    throw bridgeModeRequired("vendor profile listing");
  }

  async sendMessage(
    _message: string,
    _destination: string,
    _options: SendOptions = {}
  ): Promise<SendResult> {
    // `pidgeon send` generates-and-delivers its own messages (--type/--scenario);
    // it cannot deliver a caller-supplied message, so this operation has no CLI
    // expression (audit §2.3 item 7).
    throw new Error(
      "CLI mode cannot deliver a caller-supplied message: `pidgeon send` generates its own " +
        "messages from --type/--scenario. Run the Bridge (PIDGEON_MODE=bridge) to use send_message."
    );
  }

  async loftStatus(_options: LoftStatusOptions = {}): Promise<LoftStatusResult> {
    // `pidgeon loft status` renders text only (no machine channel yet).
    throw bridgeModeRequired("Loft interface health", "pidgeon loft status");
  }

  async generatePopulation(options: PopulationOptions): Promise<PopulationStartResult> {
    // The CLI runs population generation synchronously (no job model); a
    // successful run returns `completed` directly, and a failed run throws —
    // never a fabricated zero-patient success.
    const args = ["--quiet", "flock", "generate"];
    args.push("--count", String(options.population ?? 1));
    if (options.location) args.push("--state", options.location);
    if (options.format) args.push("--format", options.format);
    if (options.seed !== undefined) args.push("--seed", String(options.seed));
    if (options.output) args.push("--output", options.output);

    const { stdout } = await this.exec(args);
    return {
      completed: {
        patientCount: options.population ?? 1,
        format: options.format ?? "sql",
        output: options.output,
        summary: stdout.trim() || "Population generation complete.",
      },
    };
  }

  async getPopulationJob(_jobId: string): Promise<PopulationJobStatus> {
    throw new Error(
      "CLI mode runs population generation synchronously — there is no job to poll. " +
        "The generate_population result already carries the completed outcome; " +
        "run the Bridge (PIDGEON_MODE=bridge) for async population jobs."
    );
  }

  async conform(endpoint: string, options: ConformOptions = {}): Promise<ConformResult> {
    const args = ["--output-format", "json", "--quiet", "conform", "--endpoint", endpoint];
    if (options.walk) {
      args.push("--walk");
      if (options.ig) args.push("--ig", options.ig);
      if (options.onlyResources && options.onlyResources.length > 0) {
        args.push("--only-resources", options.onlyResources.join(","));
      }
    } else {
      if (options.resource) args.push("--resource", options.resource);
      if (options.profile) args.push("--profile", options.profile);
    }
    if (options.auth) args.push("--auth", options.auth);
    if (options.ci) args.push("--ci");

    // conform exits 1 when the report FAILED (that is its CI contract), so a
    // nonzero exit with parseable JSON on stdout is still a successful probe.
    const result = await this.execPermitNonzero(args, undefined);

    const raw = result.stdout.trim();
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return normalizeConformReport(parsed, endpoint);
    } catch {
      const detail = (result.stderr.trim() || raw || "(no output)").slice(0, 2000);
      throw new Error(
        `Conformance probe did not return a parseable report (exit ${result.code}):\n${detail}`
      );
    }
  }

  // Session context is a Bridge-only concept (scope, saved pin sessions, and the
  // on-device model status all live behind the authenticated Bridge). In CLI mode
  // there is no session to read — return unavailable sentinels so the
  // pidgeon://session resource degrades to a "use Bridge mode" note.
  async getScope(): Promise<ScopeInfo> {
    return { available: false, memberships: [] };
  }

  async listLockSessions(): Promise<LockSessionInfo[]> {
    return [];
  }

  async getAiModelStatus(): Promise<AiModelStatus> {
    return { available: false, ollamaAvailable: false, pulledTags: [], ready: false };
  }

  // On-device narration is a Bridge-only concept (it runs over the bundled
  // model behind the authenticated Bridge). In CLI mode there is no narrator —
  // return null so explain_error keeps the procedural fix.
  async narrate(_request: NarrationRequest): Promise<NarrationResult | null> {
    return null;
  }

  async manageDataPackages(action: DataPackageAction): Promise<DataPackageInfo[] | string> {
    if (action.action === "list" || action.action === "status") {
      const { stdout } = await this.exec(["--output-format", "json", "--quiet", "data", action.action]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        throw new Error(
          `The CLI returned unparseable data-package output:\n${stdout.trim().slice(0, 500)}`
        );
      }
      if (!Array.isArray(parsed)) {
        throw new Error(`Expected a JSON array from 'data ${action.action}', got: ${stdout.trim().slice(0, 200)}`);
      }
      const rows = parsed as Record<string, unknown>[];
      return rows.map((row) => ({
        name: String(row["name"] ?? ""),
        installed: Boolean(row["installed"]),
        recordCount: row["recordCount"] != null ? String(row["recordCount"]) : undefined,
        dataType: row["dataType"] != null ? String(row["dataType"]) : undefined,
        version: row["version"] != null ? String(row["version"]) : undefined,
      }));
    }

    const args = ["data", action.action];
    if (action.packageName) args.push(action.packageName);
    if (action.acceptLicense) args.push("--accept-license");

    // exec throws on a nonzero exit (license refusal, unknown package), so
    // reaching here means the CLI reported success.
    await this.exec(args);
    return `Package '${action.packageName}' ${action.action} completed.`;
  }

  async searchArtifacts(params: ArtifactSearchParams): Promise<ArtifactSearchResult> {
    // `pidgeon artifacts search <terms…>` for free text, `pidgeon artifacts list`
    // for the empty-query listing — the same two verbs a human runs.
    const args = ["--output-format", "json", "--quiet", "artifacts"];
    const terms = params.query?.trim();
    if (terms) args.push("search", ...terms.split(/\s+/));
    else args.push("list");

    if (params.kind) args.push("--kind", params.kind);
    if (params.vendor) args.push("--vendor", params.vendor);
    if (params.standard) args.push("--standard", params.standard);
    if (params.messageType) args.push("--message-type", params.messageType);
    if (params.installedOnly) args.push("--installed");
    if (params.limit != null) args.push("--limit", String(params.limit));

    const { stdout } = await this.exec(args);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch {
      throw new Error(
        `The CLI returned unparseable artifact-search output:\n${stdout.trim().slice(0, 500)}`
      );
    }
    const body = parsed as {
      query?: string | null;
      total?: number;
      truncated?: boolean;
      items?: ArtifactSearchItem[];
    };
    return {
      query: body.query ?? undefined,
      total: typeof body.total === "number" ? body.total : 0,
      truncated: Boolean(body.truncated),
      items: Array.isArray(body.items) ? body.items : [],
    };
  }
}
