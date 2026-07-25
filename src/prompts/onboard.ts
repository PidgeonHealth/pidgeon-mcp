// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { PromptDefinition } from "./debug.js";

const argsSchema = z.object({
  messages: z
    .string()
    .describe(
      "One or more sample messages from the vendor, separated by newlines. Paste 3-5 messages for best results."
    ),
  vendorName: z
    .string()
    .optional()
    .describe("If you know the vendor name, provide it here."),
});

export function createOnboardPrompt(): PromptDefinition {
  return {
    name: "onboard_vendor_interface",
    description:
      "Analyze sample messages from a new vendor interface and build a vendor profile. " +
      "Identifies the vendor, extracts field patterns, and creates a reusable configuration.",
    argsSchema,
    handler: (args) => {
      const { messages, vendorName } = args;

      const vendorClause = vendorName
        ? `The vendor is ${vendorName}.`
        : "The vendor is unknown — please identify it from the messages if possible.";

      const userContent = [
        "I have sample messages from a new vendor interface I need to onboard.",
        vendorClause,
        "",
        "Sample messages:",
        "```",
        messages,
        "```",
        "",
        "Please analyze these messages and help me build a reusable vendor profile.",
      ].join("\n");

      const assistantContent = [
        "I'll analyze these sample messages to build a vendor profile. Here's what I'll look for:",
        "",
        "**Step 1: Vendor identification**",
        "I'll examine:",
        "- MSH.3 (Sending Application) — often contains vendor name (EPIC, Cerner_Millennium, MEDITECH)",
        "- MSH.4 (Sending Facility) — facility name or code",
        "- PID.3 identifier format — Epic uses 7-digit MRNs, Cerner uses 11-digit IDs, Allscripts prefixes with 'AS-'",
        "- Z-segment presence and naming conventions",
        "- HL7 version in MSH.12",
        "",
        "**Step 2: Field pattern extraction**",
        "For each segment present, I'll document:",
        "- Which fields are consistently populated vs. empty",
        "- Value formats (date formats, coded element structures, identifier formats)",
        "- Repeating field patterns",
        "- Component separator usage in complex fields",
        "- Any fields with unexpected values that deviate from the spec",
        "",
        "**Step 3: Validation profile construction**",
        "I'll identify:",
        "- Fields this vendor always sends (should be validated as required)",
        "- Fields this vendor never sends (should not be flagged as missing)",
        "- Value set constraints (e.g., specific admit types, patient classes, result statuses)",
        "- Known spec deviations that should be allowed in compatibility mode",
        "",
        "**Step 4: Reusable configuration**",
        "I'll produce:",
        "- A named vendor profile summary you can reference with `--vendor` in generate_message",
        "- A validation profile for use with `validate_message --vendorProfile`",
        "- A list of message types this vendor sends with their typical structure",
        "- Recommended test scenarios for this interface",
        "",
        "**Step 5: Validation of the samples**",
        "I'll run `validate_message` on each sample to identify any existing issues before building " +
          "the profile, so the profile correctly distinguishes spec violations from vendor patterns.",
        "",
        "Let me start by examining the message structure...",
      ].join("\n");

      return {
        messages: [
          { role: "user", content: userContent },
          { role: "assistant", content: assistantContent },
        ],
      };
    },
  };
}
