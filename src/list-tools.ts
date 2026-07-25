// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { TOOL_CATALOG } from "./catalog.js";
import { COMMUNITY_TOOL_SET } from "./community-catalog.js";

export interface ToolSummary {
  name: string;
  requiredTier: string;
}

/**
 * Return the exact fail-closed CLI-mode roster without starting a transport.
 * This is the anonymous install-smoke surface used by the public mirror.
 */
export function communityToolListing(): ToolSummary[] {
  return TOOL_CATALOG
    .filter((entry) => COMMUNITY_TOOL_SET.has(entry.name))
    .map((entry) => ({ name: entry.name, requiredTier: entry.requiredTier }));
}
