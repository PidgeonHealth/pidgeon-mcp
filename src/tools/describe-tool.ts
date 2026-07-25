// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ToolDefinition } from "./types.js";
import { withSuccessEnvelope, errorResult, firstSentence } from "./format.js";
import { Tier } from "../transport/index.js";
// Read at call time only (see the circular-import note below).
import { TOOL_CATALOG } from "../catalog.js";
import { PROMPT_CATALOG } from "../prompts/catalog.js";
import { isToolActive } from "../composition.js";

const inputSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("Tool name to describe, e.g. 'generate_message'. Omit to list every tool name + tier."),
});

/**
 * The typed error codes a tool can return, derived from its tier — the machine
 * enumeration H-13 requires an agent be able to branch on. Every Pro tool can
 * deny with TIER_REQUIRED; every free tool shares the free daily volume soft-cap
 * (THROTTLED); any tool can surface TOOL_ERROR wrapping an unexpected failure.
 * All are soft/typed results, never a hard 403 that breaks the loop (H-14).
 */
function possibleErrorCodes(tier: Tier): Array<{ code: string; when: string }> {
  const codes: Array<{ code: string; when: string }> = [];
  if (tier === "free") {
    codes.push({
      code: "THROTTLED",
      when: "Free daily volume soft-cap reached — degrades to ~1 call/min, never a hard failure; carries remaining + resetsAt.",
    });
  } else {
    codes.push({
      code: "TIER_REQUIRED",
      when: `Caller's tier is below '${tier}' — a soft denial carrying the upgrade URL, never a hard 403.`,
    });
  }
  codes.push({
    code: "TOOL_ERROR",
    when: "An unexpected transport or engine failure, wrapped in a typed envelope naming the tool so the agent loop never sees a bare throw.",
  });
  return codes;
}

/** Zod → JSON Schema for one tool's input, matching the manifest's rendering. */
function toInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema as never, { target: "jsonSchema7", $refStrategy: "none" }) as Record<string, unknown>;
  delete json["$schema"];
  return json;
}

/**
 * The tools describable in this session: the active composition roster. With no
 * composition set (manifest builders, direct-factory tests) this is the full
 * catalog. Describing a tool outside the registered roster would re-open the
 * ghost-tool surface the composition boundary closed.
 */
function activeCatalog(): typeof TOOL_CATALOG {
  return TOOL_CATALOG.filter((e) => isToolActive(e.name));
}

/** The full, on-demand contract for one catalog tool — the H-22 disclosure-ladder level 3. */
function describeOne(name: string): Record<string, unknown> | null {
  const entry = activeCatalog().find((e) => e.name === name);
  if (!entry) return null;
  const def = entry.factory();
  const usedByPrompts = PROMPT_CATALOG.filter((p) => p.tools.includes(name)).map((p) => p.name);

  const contract: Record<string, unknown> = {
    name: entry.name,
    tier: entry.requiredTier,
    description: def.description,
    annotations: def.annotations,
    inputSchema: toInputSchema(def.inputSchema),
    possibleErrorCodes: possibleErrorCodes(entry.requiredTier),
  };
  // Chaining tools carry an output-envelope contract (H-16) — the stable ok:true
  // keys their result feeds downstream. Terminal tools omit it.
  if (def.outputEnvelope) contract["outputEnvelope"] = def.outputEnvelope;
  // The prompts that chain this tool are its worked examples (real, not fabricated).
  if (usedByPrompts.length > 0) contract["usedByPrompts"] = usedByPrompts;
  return contract;
}

export function createDescribeTool(): ToolDefinition {
  return {
    name: "describe_tool",
    requiredTier: "free",
    // Pure read of the static catalog — no transport, no side effect. readOnly so
    // SDK-class clients may call it in parallel and never gate it for approval.
    annotations: { readOnlyHint: true, openWorldHint: false },
    // No outputEnvelope declaration: describe_tool is a meta/introspection tool,
    // not a chaining producer. It DOES return a machine ok:true block (below) so
    // an agent gets structured JSON, but it feeds no specific downstream tool, so
    // the H-16 `feeds` contract does not apply — declaring one would be dishonest.
    description:
      "Return the full contract for any Pidgeon tool by name: its description, input schema, output-envelope keys, " +
      "the typed error codes it can return (per its tier), and the guided prompts that chain it. " +
      "The protocol-native way to fetch a tool's complete spec on demand — works in any MCP client, with no reliance on " +
      "client-side tool search. Omit `name` to list every tool. Free and uncapped; describes Pro tools without unlocking them. " +
      "Read pidgeon://version first for the roster of names.",
    inputSchema,
    handler: async (_transport, args) => {
      const parsed = inputSchema.parse(args);

      // No name → the roster of names + tiers (the H-22 catalog-card level).
      if (!parsed.name) {
        const tools = activeCatalog().map((e) => ({
          name: e.name,
          tier: e.requiredTier,
          summary: firstSentence(e.factory().description),
        }));
        const lines = [
          `Pidgeon exposes ${tools.length} tools. Call describe_tool with a \`name\` for any tool's full contract.`,
          "",
          ...tools.map((t) => `- ${t.name} (${t.tier}) — ${t.summary}`),
        ];
        return withSuccessEnvelope(lines.join("\n"), { count: tools.length, tools });
      }

      const contract = describeOne(parsed.name);
      if (!contract) {
        const names = activeCatalog().map((e) => e.name);
        return errorResult(
          `No tool named '${parsed.name}'. Call describe_tool with no name to list all tools, or pick one of: ${names.join(", ")}.`,
          "TOOL_ERROR",
          { requestedTool: parsed.name, availableTools: names },
        );
      }

      const errCodes = (contract["possibleErrorCodes"] as Array<{ code: string }>).map((c) => c.code).join(", ");
      const human = [
        `# ${contract["name"]} (${contract["tier"]})`,
        "",
        String(contract["description"]),
        "",
        `Error codes: ${errCodes}`,
        "See the JSON below for the full input schema, annotations, and output-envelope keys.",
      ].join("\n");
      return withSuccessEnvelope(human, { tool: contract });
    },
  };
}
