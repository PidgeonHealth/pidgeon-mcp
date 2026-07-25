#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { COMMUNITY_TOOL_NAMES } from "../src/community-catalog";
import { communityToolListing } from "../src/list-tools";

const tools = communityToolListing();
const actual = tools.map((tool) => tool.name).sort();
const expected = [...COMMUNITY_TOOL_NAMES].sort();

if (
  actual.length !== expected.length ||
  actual.some((name, index) => name !== expected[index])
) {
  throw new Error(`--list-tools roster drift: expected ${expected.join(", ")}, got ${actual.join(", ")}`);
}

const paid = tools.filter((tool) => tool.requiredTier !== "free");
if (paid.length > 0) {
  throw new Error(`--list-tools exposed paid CLI-mode tools: ${paid.map((tool) => tool.name).join(", ")}`);
}

console.log(`--list-tools roster: ${tools.length} community tools`);
