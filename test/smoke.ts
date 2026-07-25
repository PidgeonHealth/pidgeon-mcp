#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Smoke tests for Pidgeon MCP server — all 18 tools + workflow prompts + resources.
 * Validates tools return well-formed output using a mock transport.
 * Run: npx ts-node test/smoke.ts
 */

// Free tier tools
import { createGenerateTool } from "../src/tools/generate";
import { createValidateTool } from "../src/tools/validate";
import { createExplainTool } from "../src/tools/explain";
import { createExplainErrorTool } from "../src/tools/explain-error";
import { createLookupTool } from "../src/tools/lookup";
import { createSegmentSpecTool } from "../src/tools/segment-spec";
import { createDeidentifyTool } from "../src/tools/deidentify";
import { createDataPackagesTool } from "../src/tools/data-packages";
import { createSearchArtifactsTool } from "../src/tools/search-artifacts";
import { createStatusTool } from "../src/tools/status";
import { createSemanticReviewTool } from "../src/tools/semantic-review";
import { createClinicalCheckTool } from "../src/tools/clinical-check";

// Pro tier tools
import { createDiffTool } from "../src/tools/diff";
import { createAnalyzeVendorTool } from "../src/tools/analyze-vendor";
import { createWorkflowTool } from "../src/tools/workflow";
import { createSendTool } from "../src/tools/send";
import { createLoftStatusTool } from "../src/tools/loft-status";
import { createGeneratePopulationTool } from "../src/tools/generate-population";
import { createPopulationStatusTool } from "../src/tools/population-status";
import { createRefineHl7SegmentTool } from "../src/tools/refine_hl7_segment";
import { createConformTool } from "../src/tools/conform";

// Prompts
import { createStandUpInterfacePrompt } from "../src/prompts/stand-up-interface";
import { createReproduceAndFixPrompt } from "../src/prompts/reproduce-and-fix";
import { createSeedValidateMonitorPrompt } from "../src/prompts/seed-validate-monitor";

// Resources
import { createSetupGuideResource } from "../src/resources/setup-guide";
import { createSessionResource } from "../src/resources/session";

// Prompt catalog
import { PROMPT_CATALOG, promptTierBreakdown } from "../src/prompts/catalog";

import { GenerateResult } from "../src/transport/generate-types";
import { FieldSpecResult, Icd10Match } from "../src/transport/reference-types";
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
  ConformOptions,
  ConformResult,
  ScopeInfo,
  LockSessionInfo,
  VendorProfileInfo,
  AiModelStatus,
  NarrationResult,
} from "../src/transport/types";

// ---------------------------------------------------------------------------
// Mock transport — returns realistic static output for all tool testing
// ---------------------------------------------------------------------------

const SAMPLE_HL7 =
  "MSH|^~\\&|PIDGEON|TESTFAC|RECV|RECVFAC|20260309120000||ADT^A01|MSG001|P|2.5.1\r" +
  "EVN|A01|20260309120000\r" +
  "PID|1||12345^^^TESTFAC||DOE^JOHN^A||19800101|M|||123 MAIN ST^^ANYTOWN^ST^12345\r" +
  "PV1|1|I|ICU^101^A|E|||1234567890^SMITH^JANE|||MED||||||||1234567890^SMITH^JANE|S||||||||||||||||||||||||||20260309120000";

class MockTransport implements PidgeonTransport {
  getMode(): string { return "mock"; }
  async isAvailable(): Promise<boolean> { return true; }
  async getTier(): Promise<Tier> { return "pro"; }
  async getAdvertisedTools(): Promise<string[] | null> { return null; }
  async recordToolUsage(): Promise<void> { return; }

  async generate(messageType: string, _options?: GenerateOptions): Promise<GenerateResult> {
    return {
      messages: [SAMPLE_HL7.replace("ADT^A01", messageType)],
      effectiveSeed: 4242,
      volume: { limit: 100, remaining: 5, resetsAt: "2026-07-04T00:00:00Z" },
    };
  }

  async validate(_message: string, _options?: ValidateOptions): Promise<ValidationResult> {
    return {
      isValid: true,
      errors: [],
      warnings: [{ message: "PV1.44 recommended", severity: "warning", segment: "PV1", field: "44" }],
      conformanceScore: 0.95,
      standard: "hl7",
      messageType: "ADT^A01",
    };
  }

  async diff(_left: string, _right: string, _options?: DiffOptions): Promise<DiffResult> {
    return {
      differences: [
        { path: "MSH.7", leftValue: "20260301", rightValue: "20260302", severity: "cosmetic", description: "Timestamp changed" },
        { path: "PID.3", leftValue: "MRN001", rightValue: "MRN002", severity: "major", description: "Patient ID changed" },
      ],
      summary: "2 differences found: 1 major, 1 cosmetic.",
      leftSegmentCount: 4,
      rightSegmentCount: 4,
    };
  }

  async deidentify(_message: string, _options?: DeidentifyOptions): Promise<DeidentifyResult> {
    return {
      original: _message,
      deidentified: _message.replace("DOE^JOHN", "SMITH^JANE").replace("12345", "99999"),
      fieldsModified: 5,
      summary: "De-identified 5 PHI fields: patient name, MRN, DOB, SSN, address.",
    };
  }

  async analyzeVendorPattern(_messages: string[], _options?: AnalyzePatternOptions): Promise<VendorAnalysisResult> {
    return {
      vendor: "Epic",
      patterns: [
        { field: "MSH.3", frequency: 1.0, example: "EPIC" },
        { field: "PID.3", frequency: 0.95, example: "7-digit MRN" },
      ],
      summary: "Detected Epic vendor pattern. 2 characteristic patterns identified.",
    };
  }

  async runWorkflow(_scenario: string, _options?: WorkflowOptions): Promise<WorkflowResult> {
    return {
      steps: [
        { name: "Admit", messageType: "ADT^A01", message: SAMPLE_HL7 },
        { name: "Lab Order", messageType: "ORM^O01", message: SAMPLE_HL7.replace("ADT^A01", "ORM^O01") },
      ],
      summary: "Workflow complete: 2 steps executed.",
    };
  }

  async refine(messageContent: string, _prompt: string, options: {
    originalMessage?: string;
    standard?: string;
    profile?: string;
    segmentContent?: string;
    segmentIndex?: number;
  } = {}): Promise<{ refinedContent: string; isValid: boolean; errors: string[]; retryCount: number }> {
    const target = options.segmentContent ?? messageContent;
    return {
      refinedContent: target.replace("9.0", "18.5"),
      isValid: true,
      errors: [],
      retryCount: 1,
    };
  }

  async sendMessage(_message: string, destination: string, _options?: SendOptions): Promise<SendResult> {
    return { success: true, destination, summary: `Message delivered to ${destination}.` };
  }

  async loftStatus(_options?: LoftStatusOptions): Promise<LoftStatusResult> {
    return {
      interfaces: [
        { name: "Epic ADT", status: "healthy", messageCount: 1234, errorRate: 0.02 },
        { name: "Cerner Labs", status: "warning", messageCount: 567, errorRate: 0.15 },
      ],
      summary: "2 interfaces monitored. 1 healthy, 1 warning.",
    };
  }

  async generatePopulation(_options: PopulationOptions): Promise<PopulationStartResult> {
    return { jobId: "job_mock_1" };
  }

  async getPopulationJob(jobId: string): Promise<PopulationJobStatus> {
    return {
      id: jobId,
      status: "completed",
      totalCount: 100,
      generatedCount: 100,
      progressPercent: 100,
      startedAt: "2026-07-01T12:00:00Z",
      completedAt: "2026-07-01T12:00:42Z",
      validationErrorCount: 0,
    };
  }

  async conform(endpoint: string, options: ConformOptions = {}): Promise<ConformResult> {
    if (options.walk) {
      return {
        endpoint,
        mode: "walk",
        passed: false,
        resourcesPassed: 3,
        resourcesTotal: 4,
        totalErrors: 1,
        totalWarnings: 2,
        issues: [
          { severity: "error", ruleId: "US-CORE-1", location: "Patient/p1", message: "Patient.identifier is required." },
          { severity: "warning", ruleId: "MUSTSUPPORT-3", location: "Coverage/c1", message: "Coverage.payor must-support gap." },
        ],
        summary: "Endpoint walk FAILED: 3/4 resources passed, 1 errors, 2 warnings.",
      };
    }
    return {
      endpoint,
      mode: "single",
      passed: true,
      profileRequested: options.profile ?? "us-core-patient",
      resourceType: "Patient",
      resourceId: "example",
      httpStatusCode: 200,
      issues: [
        { severity: "warning", ruleId: "MUSTSUPPORT-1", location: "Patient.communication", message: "Patient.communication is a must-support element.", suggestion: "Populate communication if the data exists." },
      ],
      summary: "Patient/example against us-core-patient: PASSED (0 errors, 1 warning).",
    };
  }

  async manageDataPackages(action: DataPackageAction): Promise<DataPackageInfo[] | string> {
    if (action.action === "list" || action.action === "status") {
      return [
        { name: "loinc", installed: true, recordCount: "108,000", license: "LOINC License" },
        { name: "icd10", installed: true, recordCount: "74,719", license: "Public domain" },
        { name: "snomed", installed: false, recordCount: "20,000+", license: "UMLS" },
      ];
    }
    return `Package '${action.packageName}' ${action.action}ed successfully.`;
  }

  async searchArtifacts(params: ArtifactSearchParams): Promise<ArtifactSearchResult> {
    const items = [
      {
        id: "c34a4d788c4dd59b",
        name: "epic-adt-a01",
        kind: "vendor-profile",
        title: "Epic ADT^A01 — admissions interface baseline",
        description: "Structural field-population patterns for an Epic ADT^A01 interface.",
        vendor: "Epic",
        standard: "HL7v2",
        messageType: "ADT^A01",
        source: "starter",
        installed: false,
        installCommand: "pidgeon data install starter-recipes && pidgeon recipe install epic-adt-a01",
        forkedFrom: null,
      },
      {
        id: "loinc",
        name: "loinc",
        kind: "data-package",
        title: "loinc",
        description: "LOINC laboratory codes",
        source: "package-registry",
        installed: true,
        installCommand: "pidgeon data install loinc",
        forkedFrom: null,
      },
    ];
    const limit = params.limit ?? 10;
    return {
      query: params.query ?? null,
      total: items.length,
      truncated: items.length > limit,
      items: items.slice(0, limit),
    };
  }

  async getScope(): Promise<ScopeInfo> {
    return {
      available: true,
      memberships: [
        {
          organizationId: "org_1",
          organizationName: "Fusion Health",
          tier: "pro",
          facilities: [{ id: "fac_1", name: "FCH Main", kind: "hospital" }],
        },
      ],
      defaultFacilityId: "fac_1",
      lastProduct: "post",
    };
  }

  async listLockSessions(): Promise<LockSessionInfo[]> {
    return [
      {
        name: "smoke-patient",
        scope: "Custom",
        description: "Pinned demo patient",
        lockedValues: { "PID.5": "DOE^JOHN", "PID.3": "12345" },
        createdAt: "2026-06-05T00:00:00Z",
      },
    ];
  }

  async getAiModelStatus(): Promise<AiModelStatus> {
    return {
      available: true,
      ollamaAvailable: true,
      pulledTags: ["qwen3:4b"],
      recommendedModelId: "qwen3-4b",
      recommendedTag: "qwen3:4b",
      fallbackModelId: "smollm2-1.7b",
      detectedRamGb: 16,
      rationale: "16 GB detected — Qwen3-4B fits comfortably.",
      ready: true,
    };
  }

  async narrate(): Promise<NarrationResult | null> {
    // Default mock: no narration — explain_error keeps the procedural triage.
    return null;
  }

  async semanticReview() {
    // Default mock: an empty advisory review — no clinical-sense concerns flagged.
    return { findings: [], ranFamilies: [], skippedFamilies: [], wasTruncated: false };
  }

  async clinicalCheck() {
    // Default mock: no deterministic clinical-sense concerns.
    return [];
  }

  async getFieldSpec(): Promise<FieldSpecResult> {
    // Default mock has no Bridge oracle (simulates CLI mode); the tool falls
    // back to its embedded table, which is what the embedded-path tests assert.
    throw new Error("no bridge oracle in the default mock");
  }

  async lookupIcd10(): Promise<Icd10Match[]> {
    // Default mock has no Bridge oracle; the tool falls back to embedded codes.
    throw new Error("no bridge oracle in the default mock");
  }

  async listVendorProfiles(): Promise<VendorProfileInfo[]> {
    // Default mock has no Bridge; the vendors resource falls back to embedded.
    throw new Error("no bridge in the default mock");
  }
}

// Transport that simulates the on-device model not being set up yet — refine fails
// with the Bridge's "no settings for active provider" signal.
class NoModelTransport extends MockTransport {
  async getAiModelStatus(): Promise<AiModelStatus> {
    return { available: true, ollamaAvailable: false, pulledTags: [], ready: false };
  }
  async refine(): Promise<{ refinedContent: string; isValid: boolean; errors: string[]; retryCount: number }> {
    throw new Error("No settings found for active provider 'local'. Run 'pidgeon ai configure' first.");
  }
}

// Unavailable transport — simulates missing CLI / Bridge
class UnavailableTransport extends MockTransport {
  getMode(): string { return "cli"; }
  async isAvailable(): Promise<boolean> { return false; }
  async getTier(): Promise<Tier> { return "free"; }
}

// ---------------------------------------------------------------------------
// Test definitions
// ---------------------------------------------------------------------------

interface TestCase {
  name: string;
  run: () => Promise<void>;
}

const transport = new MockTransport();
let passed = 0;
let failed = 0;

const tests: TestCase[] = [
  // ---- Free tier tools ----
  {
    name: "generate_message returns content, the effective seed, and a low-volume line",
    run: async () => {
      const tool = createGenerateTool();
      const result = await tool.handler(transport, { messageType: "ADT^A01", count: 1 });
      assertHasContent(result);
      assertContains(result.content[0].text, "ADT^A01");
      // Reproducibility echo + self-pacing line (mock: seed 4242, 5/100 remaining).
      assertContains(result.content[0].text, "Effective seed: 4242");
      assertContains(result.content[0].text, "5 of 100 remaining");
    },
  },
  {
    name: "generate_message rejects lockedValues + lockSessionName together (mutually exclusive pins)",
    run: async () => {
      const tool = createGenerateTool();
      const result = await tool.handler(transport, {
        messageType: "ADT^A01",
        lockedValues: [{ fieldPath: "PID.5.1", value: "DOE" }],
        lockSessionName: "epic_er",
      });
      assertHasContent(result);
      assertContains(result.content[0].text, "mutually exclusive");
    },
  },
  {
    name: "generate_message handles count > 1",
    run: async () => {
      const tool = createGenerateTool();
      const result = await tool.handler(transport, { messageType: "ORU^R01", count: 3 });
      assertHasContent(result);
    },
  },
  {
    name: "validate_message returns structured output",
    run: async () => {
      const tool = createValidateTool();
      const result = await tool.handler(transport, { message: SAMPLE_HL7, mode: "compatibility" });
      assertHasContent(result);
      assertContains(result.content[0].text, "VALID");
      assertContains(result.content[0].text, "95%");
    },
  },
  {
    name: "validate_message appends a findings envelope shaped for explain_error.findings",
    run: async () => {
      const tool = createValidateTool();
      const result = await tool.handler(transport, { message: SAMPLE_HL7 });
      // The fenced json block must carry a findings array whose shape feeds
      // explain_error verbatim (segment/field/ruleId/message/severity).
      const match = result.content[0].text.match(/```json\n([\s\S]*?)\n```/);
      if (!match) throw new Error("validate_message must append a fenced json envelope");
      const env = JSON.parse(match[1]) as { ok: boolean; findings: Array<Record<string, unknown>> };
      if (env.ok !== true) throw new Error("success envelope must be ok:true");
      if (!Array.isArray(env.findings) || env.findings.length !== 1) {
        throw new Error(`expected 1 finding (the mock's PV1.44 warning), got ${env.findings?.length}`);
      }
      const f = env.findings[0];
      if (f.segment !== "PV1" || f.field !== "44" || f.severity !== "warning") {
        throw new Error(`finding not shaped for explain_error: ${JSON.stringify(f)}`);
      }
    },
  },
  {
    name: "explain_message parses HL7",
    run: async () => {
      const tool = createExplainTool();
      const result = await tool.handler(transport, { message: SAMPLE_HL7 });
      assertHasContent(result);
      assertContains(result.content[0].text, "ADT^A01");
      assertContains(result.content[0].text, "Patient Admission");
      assertContains(result.content[0].text, "DOE");
    },
  },
  {
    name: "explain_message numbers every segment 0-based (feeds refine_hl7_segment.segmentIndex)",
    run: async () => {
      const tool = createExplainTool();
      const result = await tool.handler(transport, { message: SAMPLE_HL7 });
      const text = result.content[0].text;
      // SAMPLE_HL7 is MSH/EVN/PID/PV1 — indices 0..3 must be present and named.
      assertContains(text, "[0] MSH");
      assertContains(text, "[2] PID");
      assertContains(text, "refine_hl7_segment");
    },
  },
  {
    name: "semantic_review returns advisory output (clean review)",
    run: async () => {
      const tool = createSemanticReviewTool();
      const result = await tool.handler(transport, { message: SAMPLE_HL7 });
      assertHasContent(result);
      assertContains(result.content[0].text, "Semantic review");
    },
  },
  {
    name: "clinical_check returns advisory output (clean check)",
    run: async () => {
      const tool = createClinicalCheckTool();
      const result = await tool.handler(transport, { message: SAMPLE_HL7 });
      assertHasContent(result);
      assertContains(result.content[0].text, "Clinical checks");
    },
  },
  {
    name: "explain_message handles FHIR JSON",
    run: async () => {
      const tool = createExplainTool();
      const fhir = JSON.stringify({ resourceType: "Patient", id: "example", name: [{ family: "Doe" }] });
      const result = await tool.handler(transport, { message: fhir });
      assertHasContent(result);
      assertContains(result.content[0].text, "Patient");
    },
  },
  {
    name: "explain_message rejects non-HL7/FHIR",
    run: async () => {
      const tool = createExplainTool();
      const result = await tool.handler(transport, { message: "random text" });
      assertHasContent(result);
      assertContains(result.content[0].text, "Could not detect");
    },
  },
  {
    name: "explain_error triages findings passed directly",
    run: async () => {
      const tool = createExplainErrorTool();
      const result = await tool.handler(transport, {
        findings: [
          { segment: "PID", field: "3", ruleId: "REQUIRED-1", message: "PID.3 is required but missing" },
          { ruleId: "MUSTSUPPORT-2", message: "Patient.communication must support gap", severity: "warning" },
        ],
      });
      assertHasContent(result);
      assertContains(result.content[0].text, "PID.3");
      assertContains(result.content[0].text, "required");
      assertContains(result.content[0].text, "must-support");
      assertContains(result.content[0].text, "Fix:");
    },
  },
  {
    name: "explain_error validates a message and triages the findings",
    run: async () => {
      const tool = createExplainErrorTool();
      const result = await tool.handler(transport, { message: SAMPLE_HL7 });
      assertHasContent(result);
      // MockTransport.validate returns one PV1.44 warning.
      assertContains(result.content[0].text, "Triaged");
      assertContains(result.content[0].text, "PV1.44");
    },
  },
  {
    name: "explain_error requires message or findings",
    run: async () => {
      const tool = createExplainErrorTool();
      const result = await tool.handler(transport, {});
      assertHasContent(result);
      assertContains(result.content[0].text, "either");
    },
  },
  {
    name: "lookup_code returns LOINC data",
    run: async () => {
      const tool = createLookupTool();
      const result = await tool.handler(transport, { code: "2823-3", codeSystem: "loinc" });
      assertHasContent(result);
      assertContains(result.content[0].text, "Potassium");
    },
  },
  {
    name: "lookup_code returns ICD-10 data",
    run: async () => {
      const tool = createLookupTool();
      const result = await tool.handler(transport, { code: "I10", codeSystem: "icd10" });
      assertHasContent(result);
      assertContains(result.content[0].text, "hypertension");
    },
  },
  {
    name: "lookup_code fuzzy search works",
    run: async () => {
      const tool = createLookupTool();
      const result = await tool.handler(transport, { code: "glucose", codeSystem: "loinc", fuzzySearch: true });
      assertHasContent(result);
      assertContains(result.content[0].text, "Glucose");
    },
  },
  {
    name: "lookup_code does not over-promise a dataset that does not exist (rxnorm)",
    run: async () => {
      // The old message claimed "run Pidgeon Bridge to access the full dataset"
      // for systems the Bridge cannot serve. The honest message must not.
      const tool = createLookupTool();
      const result = await tool.handler(transport, { code: "12345", codeSystem: "rxnorm" });
      assertHasContent(result);
      assertContains(result.content[0].text, "no RXNORM code-lookup endpoint yet");
      const text = result.content[0].text;
      if (text.includes("pidgeon data install") || text.includes("full dataset")) {
        throw new Error("not-found message still over-promises a nonexistent RxNorm dataset");
      }
    },
  },
  {
    name: "get_segment_spec returns PID fields",
    run: async () => {
      const tool = createSegmentSpecTool();
      const result = await tool.handler(transport, { segment: "PID" });
      assertHasContent(result);
      assertContains(result.content[0].text, "Patient Identification");
      assertContains(result.content[0].text, "Patient Name");
    },
  },
  {
    name: "get_segment_spec returns single field",
    run: async () => {
      const tool = createSegmentSpecTool();
      const result = await tool.handler(transport, { segment: "PID", field: 5 });
      assertHasContent(result);
      assertContains(result.content[0].text, "Patient Name");
      assertContains(result.content[0].text, "XPN");
    },
  },
  {
    name: "get_segment_spec handles unknown segment",
    run: async () => {
      const tool = createSegmentSpecTool();
      const result = await tool.handler(transport, { segment: "ZZZ" });
      assertHasContent(result);
      assertContains(result.content[0].text, "not in this MCP server's embedded summary");
    },
  },
  {
    name: "deidentify_message returns de-identified output",
    run: async () => {
      const tool = createDeidentifyTool();
      const result = await tool.handler(transport, { message: SAMPLE_HL7 });
      assertHasContent(result);
      assertContains(result.content[0].text, "5");
    },
  },
  {
    name: "manage_data_packages lists packages",
    run: async () => {
      const tool = createDataPackagesTool();
      const result = await tool.handler(transport, { action: "list" });
      assertHasContent(result);
      assertContains(result.content[0].text, "loinc");
      assertContains(result.content[0].text, "icd10");
    },
  },
  {
    name: "manage_data_packages install requires name",
    run: async () => {
      const tool = createDataPackagesTool();
      const result = await tool.handler(transport, { action: "install" });
      assertHasContent(result);
      assertContains(result.content[0].text, "required");
    },
  },
  {
    name: "search_artifacts renders the local catalog and the ok envelope",
    run: async () => {
      const tool = createSearchArtifactsTool();
      const result = await tool.handler(transport, { query: "epic" });
      assertHasContent(result);
      const text = result.content[0].text;
      assertContains(text, "epic-adt-a01");
      assertContains(text, "vendor-profile");
      assertContains(text, '"ok": true');
      assertContains(text, '"total": 2');
      assertContains(text, '"installCommand"');
    },
  },
  {
    name: "search_artifacts detailed mode surfaces the install command as the next step",
    run: async () => {
      const tool = createSearchArtifactsTool();
      const result = await tool.handler(transport, { query: "epic", detail: "detailed" });
      assertContains(result.content[0].text, "Next step: pidgeon data install starter-recipes");
    },
  },
  {
    name: "search_artifacts announces truncation and points at the limit",
    run: async () => {
      const tool = createSearchArtifactsTool();
      const result = await tool.handler(transport, { limit: 1 });
      const text = result.content[0].text;
      assertContains(text, "Truncated: showing 1 of 2");
      assertContains(text, '"truncated": true');
    },
  },

  // ---- Pro tier tools ----
  {
    name: "diff_messages returns field differences",
    run: async () => {
      const tool = createDiffTool();
      const result = await tool.handler(transport, { leftMessage: SAMPLE_HL7, rightMessage: SAMPLE_HL7 });
      assertHasContent(result);
      assertContains(result.content[0].text, "MSH.7");
      assertContains(result.content[0].text, "PID.3");
    },
  },
  {
    name: "analyze_vendor_pattern detects vendor",
    run: async () => {
      const tool = createAnalyzeVendorTool();
      const result = await tool.handler(transport, { messages: SAMPLE_HL7 + "\n\n" + SAMPLE_HL7 });
      assertHasContent(result);
      assertContains(result.content[0].text, "Epic");
    },
  },
  {
    name: "run_workflow returns steps",
    run: async () => {
      const tool = createWorkflowTool();
      const result = await tool.handler(transport, { scenario: "admit_lab_discharge" });
      assertHasContent(result);
      assertContains(result.content[0].text, "Admit");
      assertContains(result.content[0].text, "Lab Order");
    },
  },
  {
    name: "send_message returns delivery confirmation",
    run: async () => {
      const tool = createSendTool();
      const result = await tool.handler(transport, { message: SAMPLE_HL7, destination: "/tmp/mirth/pickup" });
      assertHasContent(result);
      assertContains(result.content[0].text, "delivered");
    },
  },
  {
    name: "loft_status returns interface health",
    run: async () => {
      const tool = createLoftStatusTool();
      const result = await tool.handler(transport, {});
      assertHasContent(result);
      assertContains(result.content[0].text, "Epic ADT");
      assertContains(result.content[0].text, "healthy");
    },
  },
  {
    name: "generate_population starts a job and hands the agent the poll affordance",
    run: async () => {
      const tool = createGeneratePopulationTool();
      const result = await tool.handler(transport, { population: 100, location: "IL" });
      assertHasContent(result);
      assertContains(result.content[0].text, "100");
      assertContains(result.content[0].text, "job_mock_1");
      assertContains(result.content[0].text, "population_status");
    },
  },
  {
    name: "population_status reports job progress and completion",
    run: async () => {
      const tool = createPopulationStatusTool();
      const result = await tool.handler(transport, { jobId: "job_mock_1" });
      assertHasContent(result);
      assertContains(result.content[0].text, "job_mock_1");
      assertContains(result.content[0].text, "100/100");
      assertContains(result.content[0].text, "completed");
    },
  },
  {
    name: "refine_hl7_segment returns refined content and validation status",
    run: async () => {
      const tool = createRefineHl7SegmentTool();
      const result = await tool.handler(transport, {
        originalMessage: SAMPLE_HL7,
        segmentIndex: 2,
        segmentContent: "OBX|1|NM|6690-2^WBC||9.0|K/uL",
        prompt: "Set WBC to 18.5",
      });
      assertHasContent(result);
      assertContains(result.content[0].text, "18.5");
      assertContains(result.content[0].text, "valid");
    },
  },

  {
    name: "conform single probe returns a scorecard",
    run: async () => {
      const tool = createConformTool();
      const result = await tool.handler(transport, {
        endpoint: "https://api.payer.example/fhir",
        resource: "Patient/example",
        profile: "us-core-patient",
      });
      assertHasContent(result);
      assertContains(result.content[0].text, "PASSED");
      assertContains(result.content[0].text, "us-core-patient");
    },
  },
  {
    name: "conform walk reports per-resource results",
    run: async () => {
      const tool = createConformTool();
      const result = await tool.handler(transport, {
        endpoint: "https://api.payer.example/fhir",
        walk: true,
        ci: true,
      });
      assertHasContent(result);
      assertContains(result.content[0].text, "FAILED");
      assertContains(result.content[0].text, "3/4");
      assertContains(result.content[0].text, "exit 1");
    },
  },
  {
    name: "conform requires walk or resource+profile",
    run: async () => {
      const tool = createConformTool();
      const result = await tool.handler(transport, { endpoint: "https://api.payer.example/fhir" });
      assertHasContent(result);
      assertContains(result.content[0].text, "walk");
    },
  },

  // ---- Workflow prompts ----
  {
    name: "stand_up_interface prompt chains generate -> validate -> conform -> send",
    run: async () => {
      const prompt = createStandUpInterfacePrompt();
      const result = prompt.handler({ messageType: "ADT^A01", vendor: "epic", endpoint: "https://api.payer.example/fhir" });
      const assistant = result.messages.map((m) => m.content).join("\n");
      assertContains(assistant, "generate_message");
      assertContains(assistant, "conform");
      assertContains(assistant, "send_message");
    },
  },
  {
    name: "reproduce_and_fix prompt triages and fixes",
    run: async () => {
      const prompt = createReproduceAndFixPrompt();
      const result = prompt.handler({ message: SAMPLE_HL7 });
      const assistant = result.messages.map((m) => m.content).join("\n");
      assertContains(assistant, "explain_error");
      assertContains(assistant, "refine_hl7_segment");
      assertContains(assistant, "validate_message");
    },
  },
  {
    name: "seed_validate_monitor prompt spans Flock -> Post -> Loft",
    run: async () => {
      const prompt = createSeedValidateMonitorPrompt();
      const result = prompt.handler({ population: "500" });
      const assistant = result.messages.map((m) => m.content).join("\n");
      assertContains(assistant, "generate_population");
      assertContains(assistant, "loft_status");
    },
  },

  // ---- Status tool ----
  {
    name: "pidgeon_status returns environment info",
    run: async () => {
      const tool = createStatusTool();
      const result = await tool.handler(transport, {});
      assertHasContent(result);
      assertContains(result.content[0].text, "Environment Status");
      assertContains(result.content[0].text, "Mode");
      assertContains(result.content[0].text, "Tier");
    },
  },
  {
    name: "pidgeon_status includes mode reference",
    run: async () => {
      const tool = createStatusTool();
      const result = await tool.handler(transport, {});
      assertHasContent(result);
      assertContains(result.content[0].text, "CLI mode");
      assertContains(result.content[0].text, "Bridge mode");
    },
  },
  {
    name: "pidgeon_status with unavailable transport shows setup instructions",
    run: async () => {
      const unavailable = new UnavailableTransport();
      const tool = createStatusTool();
      const result = await tool.handler(unavailable, {});
      assertHasContent(result);
      assertContains(result.content[0].text, "Setup Instructions");
    },
  },

  // ---- Setup guide resource ----
  {
    name: "setup_guide resource returns markdown content",
    run: async () => {
      const resource = createSetupGuideResource();
      const result = await resource.handler(transport, {});
      if (!result.contents || result.contents.length === 0) throw new Error("Expected contents");
      assertContains(result.contents[0].text, "Quick Start");
      assertContains(result.contents[0].text, "dotnet tool install");
      assertContains(result.contents[0].text, "PIDGEON_MODE");
      assertContains(result.contents[0].text, "Troubleshooting");
    },
  },
  {
    name: "setup_guide resource covers both modes",
    run: async () => {
      const resource = createSetupGuideResource();
      const result = await resource.handler(transport, {});
      assertContains(result.contents[0].text, "CLI Mode");
      assertContains(result.contents[0].text, "Bridge Mode");
    },
  },
  {
    name: "setup_guide resource lists all tools",
    run: async () => {
      const resource = createSetupGuideResource();
      const result = await resource.handler(transport, {});
      assertContains(result.contents[0].text, "generate_message");
      assertContains(result.contents[0].text, "pidgeon_status");
      assertContains(result.contents[0].text, "diff_messages");
    },
  },

  // ---- Session context resource (S2) ----
  {
    name: "session resource surfaces scope, saved pins, and AI status",
    run: async () => {
      const resource = createSessionResource();
      const result = await resource.handler(transport, {});
      if (!result.contents || result.contents.length === 0) throw new Error("Expected contents");
      const text = result.contents[0].text;
      assertContains(text, "Fusion Health");      // scope membership
      assertContains(text, "smoke-patient");        // saved lock session
      assertContains(text, "PID.5");                // pinned field path
      assertContains(text, "qwen3");                // on-device model status
      assertContains(text, "on-device");            // AI posture
    },
  },
  {
    name: "session resource notes Bridge-mode requirement when no context",
    run: async () => {
      // A transport with no scope / no sessions / no AI — the CLI-mode shape.
      class EmptyTransport extends MockTransport {
        async getScope(): Promise<ScopeInfo> { return { available: false, memberships: [] }; }
        async listLockSessions(): Promise<LockSessionInfo[]> { return []; }
        async getAiModelStatus(): Promise<AiModelStatus> {
          return { available: false, ollamaAvailable: false, pulledTags: [], ready: false };
        }
      }
      const resource = createSessionResource();
      const result = await resource.handler(new EmptyTransport(), {});
      assertContains(result.contents[0].text, "Bridge mode");
    },
  },

  // ---- On-device AI graceful degradation (S3) ----
  {
    name: "refine_hl7_segment degrades to an on-device setup hint when no model is configured",
    run: async () => {
      const noModel = new NoModelTransport();
      const tool = createRefineHl7SegmentTool();
      const result = await tool.handler(noModel, {
        originalMessage: SAMPLE_HL7,
        segmentIndex: 2,
        segmentContent: "OBX|1|NM|6690-2^WBC||9.0|K/uL",
        prompt: "Set WBC to 18.5",
      });
      assertHasContent(result);
      assertContains(result.content[0].text, "pidgeon ai download qwen3-4b");
      assertContains(result.content[0].text, "explain_error");
      assertContains(result.content[0].text, "on-device-model-required");
    },
  },

  // ---- Prompt catalog tier annotations (S3) ----
  {
    name: "PROMPT_CATALOG carries a free/Pro breakdown for all 6 workflows",
    run: async () => {
      if (PROMPT_CATALOG.length !== 6) throw new Error(`expected 6 prompts, got ${PROMPT_CATALOG.length}`);
      for (const entry of PROMPT_CATALOG) {
        if (!entry.freePaidNote || entry.freePaidNote.length < 10) {
          throw new Error(`${entry.name} missing a freePaidNote`);
        }
        if (entry.tools.length === 0) throw new Error(`${entry.name} chains no tools`);
      }
    },
  },
  {
    name: "reproduce_and_fix splits free diagnosis from Pro fix-and-deliver",
    run: async () => {
      const entry = PROMPT_CATALOG.find((e) => e.name === "reproduce_and_fix");
      if (!entry) throw new Error("reproduce_and_fix missing from catalog");
      const split = promptTierBreakdown(entry);
      if (!split.free.includes("explain_error")) throw new Error("explain_error should be free");
      if (!split.free.includes("validate_message")) throw new Error("validate_message should be free");
      if (!split.pro.includes("refine_hl7_segment")) throw new Error("refine_hl7_segment should be Pro");
      if (!split.pro.includes("send_message")) throw new Error("send_message should be Pro");
    },
  },

  // ---- Tier metadata ----
  {
    name: "all free tools have requiredTier 'free'",
    run: async () => {
      const freeTools = [createGenerateTool, createValidateTool, createExplainTool, createExplainErrorTool, createLookupTool, createSegmentSpecTool, createDeidentifyTool, createDataPackagesTool, createSearchArtifactsTool, createStatusTool];
      for (const factory of freeTools) {
        const tool = factory();
        if (tool.requiredTier !== "free") {
          throw new Error(`${tool.name} should be free, got ${tool.requiredTier}`);
        }
      }
    },
  },
  {
    name: "all pro tools have requiredTier 'pro'",
    run: async () => {
      const proTools = [createDiffTool, createAnalyzeVendorTool, createWorkflowTool, createSendTool, createLoftStatusTool, createGeneratePopulationTool, createPopulationStatusTool, createRefineHl7SegmentTool, createConformTool];
      for (const factory of proTools) {
        const tool = factory();
        if (tool.requiredTier !== "pro") {
          throw new Error(`${tool.name} should be pro, got ${tool.requiredTier}`);
        }
      }
    },
  },
  {
    name: "status tool is registered as free tier",
    run: async () => {
      const tool = createStatusTool();
      if (tool.requiredTier !== "free") {
        throw new Error(`pidgeon_status should be free, got ${tool.requiredTier}`);
      }
      if (tool.name !== "pidgeon_status") {
        throw new Error(`Expected name 'pidgeon_status', got '${tool.name}'`);
      }
    },
  },
];

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assertHasContent(result: { content: Array<{ type: string; text: string }> }): void {
  if (!result.content || result.content.length === 0) throw new Error("Expected content array");
  if (result.content[0].type !== "text") throw new Error(`Expected 'text', got '${result.content[0].type}'`);
  if (!result.content[0].text) throw new Error("Expected non-empty text");
}

function assertContains(text: string, substring: string): void {
  if (!text.toLowerCase().includes(substring.toLowerCase())) {
    throw new Error(`Expected '${substring}' in: ${text.substring(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  console.log(`Running ${tests.length} smoke tests...\n`);
  for (const test of tests) {
    try {
      await test.run();
      passed++;
      console.log(`  \u2713 ${test.name}`);
    } catch (err) {
      failed++;
      console.log(`  \u2717 ${test.name}`);
      console.log(`    ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
  if (failed > 0) process.exit(1);
}

run();
