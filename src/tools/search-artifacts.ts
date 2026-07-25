// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { withSuccessEnvelope, errorResult } from "./format.js";
import { ArtifactSearchItem } from "../transport/index.js";

/**
 * Local artifact discovery (ARTIFACT_ECOSYSTEM_PROGRAM.md §5.3, the LOCAL
 * subset): one free, read-only search over the artifact sources composed on the
 * machine. The community composition exposes the data-package registry; private
 * compositions can additionally expose starter and installed recipes. A projection of the same Core
 * IArtifactCatalogService the `pidgeon artifacts` CLI verbs and the Bridge
 * `GET /api/artifacts/search` route call (H-1); the hosted artifact hub plugs
 * in behind the same transport seam later.
 */

const inputSchema = z.object({
  query: z.string().optional().describe("Free-text terms; omit to list everything."),
  kind: z.enum(["vendor-profile", "generation-config", "data-package"]).optional(),
  vendor: z.string().optional().describe("e.g. 'epic'"),
  standard: z.string().optional().describe("e.g. 'hl7'"),
  message_type: z.string().optional().describe("e.g. 'ADT^A01'"),
  installed_only: z.boolean().optional().describe("Only already-installed artifacts."),
  limit: z.number().int().min(1).max(50).optional().describe("Default 10, cap 50."),
  detail: z.enum(["summary", "detailed"]).optional().describe("detailed adds install commands."),
});

function summaryLine(item: ArtifactSearchItem): string {
  const facet = item.vendor ?? item.messageType ?? item.standard ?? "";
  return (
    `  ${item.name.padEnd(30)} ${item.kind.padEnd(18)} ` +
    `${facet.padEnd(12)} ${item.installed ? "installed" : "available"}`
  );
}

function detailedBlock(item: ArtifactSearchItem): string {
  const lines = [
    `${item.name} — ${item.title} [${item.kind}, ${item.installed ? "installed" : "available"}, source: ${item.source}]`,
  ];
  if (item.description) lines.push(`  ${item.description}`);
  lines.push(`  Next step: ${item.installCommand}`);
  return lines.join("\n");
}

export function createSearchArtifactsTool(): ToolDefinition {
  return {
    name: "search_artifacts",
    requiredTier: "free",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description:
      "Search the installable artifacts exposed by this Pidgeon composition — public data packages, " +
      "plus starter and installed recipes when those private sources are present — by free text and facets; each result carries its " +
      "exact install command. Not lookup_code (decodes a clinical code), get_segment_spec (a segment's " +
      "field layout), or manage_data_packages (installs/removes; this tool only discovers).",
    inputSchema,
    outputEnvelope: {
      keys: [
        { key: "total", description: "Matches before the limit was applied." },
        { key: "truncated", description: "True when items were cut by the limit." },
        {
          key: "items",
          description:
            "Matching artifacts (installed first, then title): { id, name, kind, title, description, " +
            "vendor?, standard?, messageType?, source, installed, installCommand, forkedFrom? }.",
        },
      ],
      feeds: ["manage_data_packages"],
    },
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      let result;
      try {
        result = await transport.searchArtifacts({
          query: parsed.query,
          kind: parsed.kind,
          vendor: parsed.vendor,
          standard: parsed.standard,
          messageType: parsed.message_type,
          installedOnly: parsed.installed_only,
          limit: parsed.limit ?? 10,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Artifact search failed: ${message}`);
      }

      const heading = parsed.query
        ? `Local artifacts matching "${parsed.query}"`
        : "Local artifact catalog";

      const lines: string[] = [];
      if (result.items.length === 0) {
        lines.push(`${heading}: no matches.`);
        lines.push("Broaden the query or drop a facet; `manage_data_packages list` shows the raw package registry.");
      } else if (parsed.detail === "detailed") {
        lines.push(`${heading} (${result.items.length} of ${result.total}):`, "");
        lines.push(result.items.map(detailedBlock).join("\n\n"));
      } else {
        lines.push(`${heading} (${result.items.length} of ${result.total}):`, "");
        lines.push(`  ${"Name".padEnd(30)} ${"Kind".padEnd(18)} ${"Facet".padEnd(12)} State`);
        for (const item of result.items) lines.push(summaryLine(item));
      }

      if (result.truncated) {
        lines.push(
          "",
          `Truncated: showing ${result.items.length} of ${result.total} — refine the query or raise 'limit' (cap 50).`
        );
      }

      return withSuccessEnvelope(lines.join("\n"), {
        total: result.total,
        truncated: result.truncated,
        items: result.items,
      });
    },
  };
}
