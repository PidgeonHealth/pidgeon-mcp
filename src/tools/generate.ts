// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { ToolDefinition } from "./types.js";
import { withSuccessEnvelope } from "./format.js";
import type { LockedValue } from "../transport/index.js";

// satisfies pins the Zod schema to the transport's LockedValue shape: add or
// rename a field on one and the compile fails until the other matches.
const lockedValueSchema = z.object({
  fieldPath: z.string().describe("Field path to pin, e.g. 'PID.5.1' or 'MSH.9'."),
  value: z.string().describe("Exact value to place at that field."),
  dataType: z.string().optional().describe("Optional HL7 data type hint."),
}) satisfies z.ZodType<LockedValue>;

const inputSchema = z.object({
  messageType: z
    .string()
    .describe("Message type, e.g. 'ADT^A01', 'ORU^R01' (HL7), 'Patient' (FHIR), 'NewRx' (NCPDP). Standard is auto-inferred."),
  count: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(1)
    .describe("Number of messages (1-100). Counts against the free daily cap."),
  vendor: z
    .string()
    .optional()
    .describe("Apply vendor patterns, e.g. 'epic', 'cerner', 'meditech'."),
  hl7Version: z
    .string()
    .optional()
    .describe("HL7 version override, e.g. '2.5.1', '2.7'. HL7 only."),
  seed: z.number().int().optional().describe("Seed for reproducible output."),
  lockedValues: z
    .array(lockedValueSchema)
    .optional()
    .describe("Pin exact field values to a precise spec. Mutually exclusive with lockSessionName."),
  lockSessionName: z
    .string()
    .optional()
    .describe("Saved pin session name (see pidgeon://session) to constrain generation. Mutually exclusive with lockedValues."),
});

export function createGenerateTool(): ToolDefinition {
  return {
    name: "generate_message",
    requiredTier: "free",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputEnvelope: {
      keys: [
        { key: "messages", description: "The generated message(s), by value — feed a single message straight into validate_message / explain_message / send_message." },
        { key: "messageType", description: "The requested message type, echoed back." },
        { key: "count", description: "Number of messages generated." },
        { key: "effectiveSeed", description: "The seed actually used (drawn for an unseeded run); pass it back as `seed` to reproduce the exact bytes." },
      ],
      feeds: ["validate_message", "explain_message", "refine_hl7_segment", "send_message"],
    },
    description:
      "Generate synthetic healthcare test messages in HL7 v2, FHIR R4, or NCPDP SCRIPT format. " +
      "Use this when you need realistic test data for interface testing, go-live prep, or validating parsers. " +
      "Deterministic by `seed` — the same seed reproduces the exact bytes and an unseeded run returns its effective seed, so retries are safe. " +
      "For a multi-step, one-patient clinical scenario use run_workflow instead; this produces standalone messages.",
    inputSchema,
    handler: async (transport, args) => {
      const parsed = inputSchema.parse(args);

      if (parsed.lockedValues && parsed.lockSessionName) {
        return {
          content: [
            {
              type: "text",
              text: "Specify either lockedValues or lockSessionName, not both — they are mutually exclusive pin sources.",
            },
          ],
        };
      }

      let result;
      try {
        result = await transport.generate(parsed.messageType, {
          count: parsed.count,
          vendor: parsed.vendor,
          hl7Version: parsed.hl7Version,
          seed: parsed.seed,
          lockedValues: parsed.lockedValues,
          lockSessionName: parsed.lockSessionName,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text",
              text: `Error generating ${parsed.messageType} message(s): ${message}`,
            },
          ],
        };
      }

      const messages = result.messages;
      const separator = "─".repeat(60);
      const blocks: string[] = [];

      messages.forEach((msg, i) => {
        if (messages.length > 1) {
          blocks.push(`${separator}\nMessage ${i + 1} of ${messages.length}\n${separator}`);
        }
        blocks.push(msg);
      });

      const count = messages.length;
      const label = count === 1 ? "message" : "messages";
      blocks.push(`\nGenerated ${count} ${parsed.messageType} ${label}.`);

      // Reproducibility: surface the effective seed (the one drawn for an
      // unseeded run) so an agent can regenerate the exact same output.
      if (result.effectiveSeed !== undefined) {
        blocks.push(`Effective seed: ${result.effectiveSeed} (pass seed=${result.effectiveSeed} to reproduce this output).`);
      }

      // Self-pacing: when the free daily volume is running low, tell the agent so
      // it slows down before it hits the soft cap — never a surprise throttle.
      const vol = result.volume;
      if (vol && vol.limit > 0 && vol.remaining <= Math.ceil(vol.limit * 0.2)) {
        const resets = vol.resetsAt ? `; resets ${vol.resetsAt}` : "";
        blocks.push(`Free volume: ${vol.remaining} of ${vol.limit} remaining today${resets}.`);
      }

      // Machine envelope: carry the message(s) by value plus the reproducibility
      // seed so an agent chains generate -> validate/explain/send without parsing
      // the message separators out of the prose above (H-16). Keys are stable API.
      const payload: Record<string, unknown> = {
        messageType: parsed.messageType,
        count,
        messages,
      };
      if (result.effectiveSeed !== undefined) payload["effectiveSeed"] = result.effectiveSeed;

      return withSuccessEnvelope(blocks.join("\n"), payload);
    },
  };
}
