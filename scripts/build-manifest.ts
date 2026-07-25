#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CLI entry for `npm run manifest`. Writes manifest.json, MANIFEST.md, and
 * bundle/manifest.json from the pure builders in scripts/manifest.ts. All file
 * I/O lives here so scripts/manifest.ts stays side-effect-free for the drift guard.
 */
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import {
  buildManifest,
  buildMcpbManifest,
  renderMarkdown,
  serializeJson,
  MANIFEST_JSON_PATH,
  MANIFEST_MD_PATH,
  MCPB_MANIFEST_PATH,
} from "./manifest";

const manifest = buildManifest();
writeFileSync(MANIFEST_JSON_PATH, serializeJson(manifest));
writeFileSync(MANIFEST_MD_PATH, renderMarkdown(manifest) + "\n");
mkdirSync(dirname(MCPB_MANIFEST_PATH), { recursive: true });
writeFileSync(MCPB_MANIFEST_PATH, serializeJson(buildMcpbManifest(manifest)));
// eslint-disable-next-line no-console
console.log(`Wrote manifest.json, MANIFEST.md, bundle/manifest.json (${manifest.tools.length} tools).`);
