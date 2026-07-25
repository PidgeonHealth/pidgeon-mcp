// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Builders for the machine-readable Pidgeon MCP manifest. Pure — importing this
 * module performs no writes, so the drift guard (test/manifest.test.ts) can
 * re-run the builders and compare them to the committed artifacts. The CLI entry
 * that writes the files is scripts/build-manifest.ts (`npm run manifest`).
 *
 * Source of truth:
 *   - tools + tiers      -> src/catalog.ts (TOOL_CATALOG)
 *   - tool input-schemas -> each tool's Zod inputSchema (Zod -> JSON Schema)
 *   - prompts / resources-> the real prompt + resource factories
 *   - version            -> package.json
 *
 * Artifacts (LF, deterministic): manifest.json, MANIFEST.md, bundle/manifest.json.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { zodToJsonSchema } from "zod-to-json-schema";

import { firstSentence } from "../src/tools/format";
import { ToolAnnotations, OutputEnvelope } from "../src/tools/types";
import { TOOL_CATALOG } from "../src/catalog";
import { PROMPT_CATALOG, promptTierBreakdown } from "../src/prompts/catalog";
import { createHl7SegmentsResources } from "../src/resources/hl7-segments";
import { createVendorsResource } from "../src/resources/vendors";
import { createSystemVersionResource } from "../src/resources/system";
import { createSetupGuideResource } from "../src/resources/setup-guide";
import { createSessionResource, AI_POSTURE } from "../src/resources/session";

const ROOT = resolve(__dirname, "..");

function pkgVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

function toInputSchema(schema: unknown): Record<string, unknown> {
  const json = zodToJsonSchema(schema as never, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}

export interface ManifestTool {
  name: string;
  tier: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>;
  /**
   * Output-envelope contract (H-16) for chaining tools. Documented here beside
   * the input schema so an agent learns the `ok: true` keys one tool's output
   * carries into the next. It rides the manifest only — never the cold-start
   * `tools/list` definition — so it is off the H-20/H-21 budget (see
   * {@link coldStartDefinition}). Absent on terminal (non-chaining) tools.
   */
  outputEnvelope?: OutputEnvelope;
}

export interface ManifestPrompt {
  name: string;
  description: string;
  tools: string[];
  tiers: { free: string[]; pro: string[] };
  freePaidNote: string;
}

export interface Manifest {
  name: string;
  version: string;
  description: string;
  toolCounts: { total: number; free: number; pro: number };
  freePaidRule: string;
  ai: Record<string, unknown>;
  transports: Record<string, string>;
  env: Array<{ name: string; default: string; description: string }>;
  tools: ManifestTool[];
  prompts: ManifestPrompt[];
  resources: Array<{ uri: string; description: string }>;
}

export function buildManifest(): Manifest {
  const tools: ManifestTool[] = TOOL_CATALOG.map((entry) => {
    const def = entry.factory();
    const tool: ManifestTool = {
      name: entry.name,
      tier: entry.requiredTier,
      description: def.description,
      annotations: def.annotations,
      inputSchema: toInputSchema(def.inputSchema),
    };
    // Only chaining tools declare an output envelope; keep the key absent (not
    // `undefined`) on terminal tools so the serialized manifest stays clean.
    if (def.outputEnvelope) tool.outputEnvelope = def.outputEnvelope;
    return tool;
  });
  const free = TOOL_CATALOG.filter((e) => e.requiredTier === "free").length;

  const prompts: ManifestPrompt[] = PROMPT_CATALOG.map((entry) => {
    const def = entry.factory();
    const split = promptTierBreakdown(entry);
    return {
      name: entry.name,
      description: def.description,
      tools: entry.tools,
      tiers: { free: split.free, pro: split.pro },
      freePaidNote: entry.freePaidNote,
    };
  });

  const resourceDefs = [
    ...createHl7SegmentsResources(),
    createVendorsResource(),
    createSystemVersionResource(),
    createSetupGuideResource(),
    createSessionResource(),
  ];
  const resources = resourceDefs.map((r) => ({ uri: r.uri, description: r.description }));

  return {
    name: "@pidgeonhealth/pidgeon-mcp",
    version: pkgVersion(),
    description:
      "MCP server for the Pidgeon Healthcare Interoperability Platform — generate, validate, " +
      "explain, de-identify, and analyze HL7/FHIR/NCPDP messages from any MCP-compatible AI client.",
    toolCounts: { total: tools.length, free, pro: tools.length - free },
    freePaidRule:
      "One valid message is free; production volume, team leverage, and live-interface tools are paid. " +
      "The MCP transport is the delivery mechanism, not the entitlement — gating is enforced at Bridge auth + subscription.",
    ai: { ...AI_POSTURE },
    transports: {
      cli: "PIDGEON_MODE=cli — spawns the pidgeon CLI; zero-auth showcase surface.",
      bridge: "PIDGEON_MODE=bridge — authenticated HTTP Bridge capability surface.",
    },
    env: [
      { name: "PIDGEON_MODE", default: "bridge", description: "Transport: bridge or cli." },
      { name: "PIDGEON_BRIDGE_URL", default: "http://localhost:5100", description: "Bridge API base URL (Bridge mode)." },
      { name: "PIDGEON_API_KEY", default: "", description: "API key for authenticated Bridge instances." },
      { name: "PIDGEON_CLI_PATH", default: "pidgeon", description: "Path to the pidgeon CLI executable (CLI mode)." },
      { name: "PIDGEON_TOOLS", default: "", description: "Toolset narrowing (H-2): comma-separated tool names or tiers (free/pro) to REGISTER. Empty = full roster (default)." },
      { name: "PIDGEON_EXCLUDE_TOOLS", default: "", description: "Toolset narrowing (H-2): comma-separated tool names or tiers to withhold, applied after the include list. Empty = exclude nothing." },
    ],
    tools,
    prompts,
    resources,
  };
}

// ---------------------------------------------------------------------------
// Token-budget accounting (H-20 / H-21)
// ---------------------------------------------------------------------------
//
// Every token the harness injects at cold start is a token the agent cannot
// spend on the user's problem. This models the exact cost: the per-tool
// definition each `tools/list` ships — `{ name, description, inputSchema,
// annotations }` as compact JSON — plus the roster total. Estimated at 4
// chars/token (the standard's honest-about-being-an-estimate accounting unit).
// The build (test/manifest.test.ts) fails when the total breaches H-20 or any
// single tool breaches the H-21 hard ceiling, so roster growth is a deliberate
// trade rather than silent accretion.

/** The cold-start token budget for the whole surface (H-20): 8,000 tokens. */
export const COLD_START_TOKEN_BUDGET = 8000;
/** Per-tool full-definition hard ceiling (H-21): 2,000 chars (~500 tokens). */
export const PER_TOOL_CHAR_CEILING = 2000;
/** Per-tool full-definition target (H-21): 1,200 chars (~300 tokens). */
export const PER_TOOL_CHAR_TARGET = 1200;
/** The standard's accounting unit: 4 chars per token. */
export const CHARS_PER_TOKEN = 4;

/** Estimated tokens from a char count, at {@link CHARS_PER_TOKEN}. */
export function estTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

/**
 * The exact object a `tools/list` response carries per tool, in the wire's
 * compact form. Fixed key order so the measure is deterministic regardless of
 * the manifest's own key order.
 */
function coldStartDefinition(t: ManifestTool): string {
  return JSON.stringify({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  });
}

export interface ToolCostRow {
  name: string;
  tier: string;
  descChars: number;
  schemaChars: number;
  annotationChars: number;
  fullChars: number;
  tokens: number;
}

export interface TokenBudget {
  rows: ToolCostRow[];
  totalChars: number;
  totalTokens: number;
  coldStartTokenBudget: number;
  perToolCharCeiling: number;
  perToolCharTarget: number;
  /** Tools over the H-21 hard ceiling — the build fails when this is non-empty. */
  overCeiling: ToolCostRow[];
}

/**
 * Per-tool + roster cold-start cost. Deterministic (sorted by cost desc, then
 * name) so the rendered table is byte-stable for the drift guard.
 */
export function buildTokenBudget(m: Manifest): TokenBudget {
  const rows: ToolCostRow[] = m.tools
    .map((t) => {
      const fullChars = coldStartDefinition(t).length;
      return {
        name: t.name,
        tier: t.tier,
        descChars: t.description.length,
        schemaChars: JSON.stringify(t.inputSchema).length,
        annotationChars: JSON.stringify(t.annotations).length,
        fullChars,
        tokens: estTokens(fullChars),
      };
    })
    .sort((a, b) => b.fullChars - a.fullChars || a.name.localeCompare(b.name));

  const totalChars = rows.reduce((sum, r) => sum + r.fullChars, 0);
  return {
    rows,
    totalChars,
    totalTokens: estTokens(totalChars),
    coldStartTokenBudget: COLD_START_TOKEN_BUDGET,
    perToolCharCeiling: PER_TOOL_CHAR_CEILING,
    perToolCharTarget: PER_TOOL_CHAR_TARGET,
    overCeiling: rows.filter((r) => r.fullChars > PER_TOOL_CHAR_CEILING),
  };
}

// ---------------------------------------------------------------------------
// `.mcpb` bundle manifest (Claude Desktop)
// ---------------------------------------------------------------------------

export interface McpbManifest {
  manifest_version: string;
  name: string;
  display_name: string;
  version: string;
  description: string;
  author: { name: string; url: string };
  homepage: string;
  license: string;
  server: {
    type: string;
    entry_point: string;
    mcp_config: { command: string; args: string[]; env: Record<string, string> };
  };
  tools: Array<{ name: string; description: string }>;
  tools_generated: boolean;
  user_config: Record<string, Record<string, unknown>>;
  compatibility: { platforms: string[]; runtimes: Record<string, string> };
}

export function buildMcpbManifest(m: Manifest): McpbManifest {
  const entry = "node_modules/@pidgeonhealth/pidgeon-mcp/dist/index.js";
  return {
    manifest_version: "0.3",
    name: "pidgeon-mcp",
    display_name: "Pidgeon Healthcare MCP",
    version: m.version,
    description: m.description,
    author: { name: "Pidgeon Health", url: "https://pidgeon.health" },
    homepage: "https://pidgeon.health",
    license: "MPL-2.0",
    server: {
      type: "node",
      entry_point: entry,
      mcp_config: {
        command: "node",
        args: [`\${__dirname}/${entry}`],
        env: {
          PIDGEON_MODE: "${user_config.mode}",
          PIDGEON_BRIDGE_URL: "${user_config.bridge_url}",
          PIDGEON_API_KEY: "${user_config.api_key}",
          PIDGEON_TOOLS: "${user_config.tools}",
          PIDGEON_EXCLUDE_TOOLS: "${user_config.exclude_tools}",
        },
      },
    },
    tools: m.tools.map((t) => ({ name: t.name, description: firstSentence(t.description) })),
    tools_generated: false,
    user_config: {
      mode: {
        type: "string",
        title: "Transport mode",
        description: "cli (default, no account, free tools) or bridge (authenticated Pro tools). Valid values: cli, bridge.",
        required: false,
        default: "cli",
      },
      bridge_url: {
        type: "string",
        title: "Bridge URL",
        description: "Pidgeon Bridge base URL. Only used in bridge mode.",
        required: false,
        default: "http://localhost:5100",
      },
      api_key: {
        type: "string",
        title: "API key",
        description: "Pidgeon API key for authenticated Bridge instances. Only required for Pro tools.",
        required: false,
        sensitive: true,
      },
      tools: {
        type: "string",
        title: "Included tools",
        description:
          "Optional toolset narrowing (H-2): comma-separated tool names or tiers (free, pro) to REGISTER. " +
          "Empty = the full roster (default). Narrows only YOUR context budget; never changes tool semantics.",
        required: false,
        default: "",
      },
      exclude_tools: {
        type: "string",
        title: "Excluded tools",
        description:
          "Optional toolset narrowing (H-2): comma-separated tool names or tiers to withhold from registration, " +
          "applied after the include list. Empty = exclude nothing (default).",
        required: false,
        default: "",
      },
    },
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: ">=22.0.0 <23.0.0" },
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/** Deterministic thousands separator (locale-independent, so the artifact is byte-stable). */
function withCommas(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function renderMarkdown(m: Manifest): string {
  const lines: string[] = [];
  lines.push(`# Pidgeon MCP Manifest`);
  lines.push("");
  lines.push(`> Generated from \`src/catalog.ts\` + each tool's Zod input schema by \`npm run manifest\`. Do not edit by hand.`);
  lines.push("");
  lines.push(`**${m.name}** v${m.version} — ${m.toolCounts.total} tools (${m.toolCounts.free} free, ${m.toolCounts.pro} Pro), ${m.prompts.length} prompts, ${m.resources.length} resources.`);
  lines.push("");
  lines.push(m.freePaidRule);
  lines.push("");

  lines.push(`## On-device AI`);
  lines.push("");
  lines.push(String(m.ai["note"]));
  lines.push("");
  lines.push(`- **Default**: ${m.ai["default"]} (${m.ai["model"]})`);
  lines.push(`- **BYOK**: ${m.ai["byok"]}`);
  lines.push(`- **Setup**: \`${m.ai["setupCommand"]}\``);
  lines.push("");

  lines.push(`## Transports`);
  lines.push("");
  for (const [k, v] of Object.entries(m.transports)) lines.push(`- **${k}** — ${v}`);
  lines.push("");

  lines.push(`## Environment variables`);
  lines.push("");
  lines.push(`| Variable | Default | Description |`);
  lines.push(`|---|---|---|`);
  for (const e of m.env) lines.push(`| \`${e.name}\` | ${e.default === "" ? "*(none)*" : `\`${e.default}\``} | ${e.description} |`);
  lines.push("");

  // Token budget (H-20/H-21) — the same accounting the drift guard enforces.
  const budget = buildTokenBudget(m);
  lines.push(`## Token budget (cold-start accounting)`);
  lines.push("");
  lines.push(
    "Per-tool cold-start cost — the `{ name, description, inputSchema, annotations }` object each tool ships in " +
      "`tools/list`, measured as compact JSON, tokens estimated at 4 chars/token. Enforced by `test/manifest.test.ts`: " +
      `the build fails if the cold-start total exceeds ${withCommas(budget.coldStartTokenBudget)} tokens (H-20) or any single ` +
      `tool's full definition exceeds ${withCommas(budget.perToolCharCeiling)} chars (H-21; target ${withCommas(budget.perToolCharTarget)}).`
  );
  lines.push("");
  lines.push(`| Tool | Tier | Desc | Schema | Annot | Full (chars) | ~Tokens |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const r of budget.rows) {
    lines.push(`| \`${r.name}\` | ${r.tier} | ${r.descChars} | ${r.schemaChars} | ${r.annotationChars} | ${r.fullChars} | ${r.tokens} |`);
  }
  lines.push(`| **Total** | | | | | **${withCommas(budget.totalChars)}** | **${withCommas(budget.totalTokens)}** |`);
  lines.push("");
  lines.push(
    `Cold-start total: **${withCommas(budget.totalTokens)} tokens** of the ${withCommas(budget.coldStartTokenBudget)}-token budget ` +
      `(${Math.round((budget.totalTokens / budget.coldStartTokenBudget) * 100)}% used, H-20). Per-tool hard ceiling ` +
      `${withCommas(budget.perToolCharCeiling)} chars, target ${withCommas(budget.perToolCharTarget)} chars (H-21).`
  );
  lines.push("");

  for (const tierLabel of ["free", "pro"] as const) {
    const inTier = m.tools.filter((t) => t.tier === tierLabel);
    lines.push(`## ${tierLabel === "free" ? "Free" : "Pro"} tools (${inTier.length})`);
    lines.push("");
    for (const t of inTier) {
      lines.push(`### \`${t.name}\``);
      lines.push("");
      lines.push(t.description);
      lines.push("");
      lines.push(`**Annotations** (H-15): \`${JSON.stringify(t.annotations)}\``);
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(t.inputSchema, null, 2));
      lines.push("```");
      lines.push("");
      if (t.outputEnvelope) {
        // A terminal handoff (empty feeds) is an artifact the coordinating agent
        // reads directly (H-26), not input to another tool — say so rather than
        // rendering an empty "shaped to feed ." clause.
        const feedsClause =
          t.outputEnvelope.feeds.length > 0
            ? `shaped to feed ${t.outputEnvelope.feeds.map((f) => `\`${f}\``).join(", ")}.`
            : `the journey's terminal artifact — read by the coordinating agent (H-26), not fed to another tool.`;
        lines.push(
          `**Output envelope** (H-16): appends \`ok: true\` + the keys below via \`withSuccessEnvelope\`; ` +
            feedsClause
        );
        lines.push("");
        lines.push(`| Key | Contract |`);
        lines.push(`|---|---|`);
        for (const k of t.outputEnvelope.keys) lines.push(`| \`${k.key}\` | ${k.description} |`);
        lines.push("");
      }
    }
  }

  lines.push(`## Prompts (${m.prompts.length})`);
  lines.push("");
  for (const p of m.prompts) {
    lines.push(`- **${p.name}** — ${p.description}`);
    lines.push(`  - Chains: ${p.tools.map((t) => `\`${t}\``).join(" → ")}`);
    lines.push(`  - Entitlement: ${p.freePaidNote}`);
  }
  lines.push("");

  lines.push(`## Resources (${m.resources.length})`);
  lines.push("");
  for (const r of m.resources) lines.push(`- \`${r.uri}\` — ${r.description}`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Artifact serialization + paths (pure)
// ---------------------------------------------------------------------------

/** Stable JSON serialization used for every emitted artifact. */
export function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

export const MANIFEST_JSON_PATH = resolve(ROOT, "manifest.json");
export const MANIFEST_MD_PATH = resolve(ROOT, "MANIFEST.md");
export const MCPB_MANIFEST_PATH = resolve(ROOT, "bundle", "manifest.json");
