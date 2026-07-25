// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod";
import { PromptDefinition } from "./debug.js";

/**
 * W2 — Reproduce + fix a failing production message.
 * The highest-frequency real job, and where the on-device-AI asymmetry shines:
 * diagnose for free, fix-and-deliver with no PHI to cloud. Chains
 * explain_message → validate_message → explain_error → refine_hl7_segment →
 * re-validate → diff → send. Subsumes and upgrades the debug_hl7_error prompt:
 * that one narrates; this one narrates AND fixes AND re-validates AND can re-send.
 */
const argsSchema = z.object({
  message: z
    .string()
    .describe("The message the destination system rejected."),
  errorContext: z
    .string()
    .optional()
    .describe("What the destination reported, if known (e.g. 'Cerner rejected this in the ORU feed')."),
  profile: z
    .string()
    .optional()
    .describe("Vendor profile to fix and re-validate against, e.g. 'cerner'."),
});

export function createReproduceAndFixPrompt(): PromptDefinition {
  return {
    name: "reproduce_and_fix",
    description:
      "Reproduce, diagnose, and fix a rejected message: explain it, find the violations, triage each " +
      "with a suggested fix, apply the fix in place, re-validate until clean, and produce a re-sendable version.",
    argsSchema,
    handler: (args) => {
      const { message, errorContext, profile } = args;

      const userContent = [
        "This message was rejected by the destination system. Tell me why, fix it, and give me a clean version I can re-send.",
        "",
        "Message:",
        "```",
        message,
        "```",
        ...(errorContext ? ["", "What the destination reported:", errorContext] : []),
        ...(profile ? ["", `Vendor profile: ${profile}.`] : []),
      ].join("\n");

      const assistantContent = [
        "I'll reproduce and fix this. The on-device path means the diagnosis costs nothing and no PHI leaves your machine.",
        "",
        "**Step 1: Understand the message** — `explain_message` to see the type, segments, and clinical intent.",
        "",
        "**Step 2: Find the violations** — `validate_message`" +
          (profile ? ` in strict mode against the ${profile} profile` : " in strict mode") +
          " to get the structured errors.",
        "",
        "**Step 3: Triage each finding** — `explain_error` on the validation findings: for each one, what's wrong, " +
          "why the rule exists, and the concrete fix. (This is the free diagnosis.)",
        "",
        "**Step 4: Apply the fix** — `refine_hl7_segment` to edit the offending segment in place and self-heal it " +
          "against the standard" + (profile ? ` and the ${profile} profile` : "") + ". (Pro — this is the fix-and-deliver step.)",
        "",
        "**Step 5: Confirm clean** — `validate_message` again; I loop steps 4–5 until it passes.",
        "",
        "**Step 6: Show the change** — `diff_messages` of before vs after so you can see exactly what moved.",
        "",
        "**Step 7: Re-send (optional)** — `send_message` to the destination once you approve the fix.",
        "",
        "If you're on the free tier, you'll still get the full diagnosis (steps 1–3); the fix-and-deliver steps need Pro, " +
          "and I'll surface that cleanly rather than stalling. Starting by explaining the message...",
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
