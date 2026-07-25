// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { DataPackageInfo } from "../transport/index.js";

const inputSchema = z.object({
  action: z
    .enum(["list", "install", "remove", "status"])
    .describe(
      "Action to perform: list (show all packages), install (add a package), " +
      "remove (uninstall a package), status (show installed package details)."
    ),
  packageName: z
    .string()
    .optional()
    .describe(
      "Package name (required for install/remove). " +
      "Use action=list for the live catalog, including public FHIR IGs and member-supplied terminology packs."
    ),
  acceptLicense: z
    .boolean()
    .optional()
    .describe(
      "Accept the license agreement. Required for UMLS-licensed packages (snomed, rxnorm) " +
      "and AMA-licensed packages (cpt)."
    ),
});

function formatPackageTable(packages: DataPackageInfo[]): string {
  const lines: string[] = [];

  lines.push(
    `${"Package".padEnd(12)} ${"Installed".padEnd(12)} ${"Records".padEnd(12)} ${"License".padEnd(18)} ${"Size"}`
  );
  lines.push("─".repeat(65));

  for (const pkg of packages) {
    const name = pkg.name.padEnd(12);
    const installed = (pkg.installed ? "Yes" : "No").padEnd(12);
    const records = (pkg.recordCount ?? "—").toString().padEnd(12);
    const license = (pkg.license ?? "—").substring(0, 18).padEnd(18);
    const size = pkg.size ?? "—";
    lines.push(`${name} ${installed} ${records} ${license} ${size}`);
  }

  return lines.join("\n");
}

export function createDataPackagesTool(): ToolDefinition {
  return {
    name: "manage_data_packages",
    requiredTier: "free",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    description:
      "List, install, or remove healthcare reference data packages " +
      "(LOINC, ICD-10, SNOMED, RxNorm, NDC, CVX, HCPCS, CPT). " +
      "Installed packages enable richer code lookups, more accurate validation, " +
      "and clinically coherent generation. install/remove are idempotent — re-installing an " +
      "installed package or removing an absent one is a safe no-op.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      // Validate that packageName is provided for install/remove
      if ((parsed.action === "install" || parsed.action === "remove") && !parsed.packageName) {
        return {
          content: [
            {
              type: "text",
              text: `Package name is required for '${parsed.action}' action. ` +
                "Run action=list to see the current catalog.",
            },
          ],
        };
      }

      let result;
      try {
        result = await transport.manageDataPackages({
          action: parsed.action,
          packageName: parsed.packageName,
          acceptLicense: parsed.acceptLicense,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error managing data packages: ${message}`,
            },
          ],
        };
      }

      const lines: string[] = [];

      if (Array.isArray(result)) {
        // list or status — result is DataPackageInfo[]
        const packages = result as DataPackageInfo[];
        lines.push("Healthcare Data Packages");
        lines.push("─".repeat(65));
        lines.push(formatPackageTable(packages));

        const installed = packages.filter((p) => p.installed).length;
        lines.push("");
        lines.push(`${installed} of ${packages.length} packages installed.`);
      } else {
        // install or remove — result is a string message
        lines.push(result);
      }

      return {
        content: [
          {
            type: "text",
            text: lines.join("\n").trimEnd(),
          },
        ],
      };
    },
  };
}
