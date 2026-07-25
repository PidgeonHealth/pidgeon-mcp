#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cross-app journey contract — the generate→seed→watch two-walk gate
 * (AGENTIC_HARNESS_STANDARD.md §3, H-25..H-28; the contract is documented in
 * the cross-app journey contract design note).
 *
 * The journey spans three products with ZERO cross-product code deps (H-25):
 * coordination lives HERE, in the agent/test layer, never in one product calling
 * another. What crosses each app boundary is an artifact reference plus its
 * machine envelope (H-26): step N's `withSuccessEnvelope` block is step N+1's
 * arguments.
 *
 *   generate_message   (Post)   → envelope: messages[] + effectiveSeed
 *   generate_population (Flock)  → envelope: jobId → population_status → downloadRef
 *   loft_status        (Loft)   → envelope: interface health / findings (terminal)
 *
 * Two walks prove the contract:
 *   1. FREE walk   — the free step (generate_message) composes; the Pro steps
 *      (generate_population, loft_status) return typed TIER_REQUIRED envelopes and
 *      the loop is NEVER broken by a hard 403 (H-14). A denied Pro step short-
 *      circuits at the client gate BEFORE the transport, so no Bridge call — let
 *      alone a 403 — ever happens, and a following free step still composes.
 *   2. ENTITLED walk — every step runs and the chain composes end-to-end FROM THE
 *      ENVELOPES ALONE: the jobId parsed out of generate_population's envelope is
 *      the exact argument population_status is polled with (no prose parsing).
 *
 * The gate is modelled on the REAL server gate: it drives the same decision
 * functions server.ts calls (clientGateAllows + normalizeTier + tierGateResult)
 * against the authoritative catalog tier (entry.requiredTier), so this is the
 * production gate, not a reimplementation. Runs in the default `npm test` on a
 * mocked transport — no live Bridge (unlike golden-journey.test.ts).
 *
 * Run: npx ts-node test/cross-app-journey.test.ts
 */

import { TOOL_CATALOG, ToolCatalogEntry } from "../src/catalog";
import { clientGateAllows } from "../src/server";
import { normalizeTier, tierGateResult } from "../src/tools/format";
import {
  PidgeonTransport,
  Tier,
  GenerateOptions,
  PopulationOptions,
  PopulationStartResult,
  PopulationJobStatus,
  LoftStatusOptions,
  LoftStatusResult,
} from "../src/transport/types";
import { GenerateResult } from "../src/transport/generate-types";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${err instanceof Error ? err.message : String(err)}\n`);
    });
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

/** Pull the fenced ```json envelope a tool appends after its human text. */
function parseEnvelope(text: string): Record<string, unknown> {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) throw new Error(`no fenced json envelope in:\n${text.slice(0, 300)}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

/** The authoritative catalog entry (name + tier + factory) the server gates on. */
function entryFor(name: string): ToolCatalogEntry {
  const entry = TOOL_CATALOG.find((e) => e.name === name);
  if (!entry) throw new Error(`no catalog entry for ${name}`);
  return entry;
}

/**
 * The client-side tool gate, exactly as server.ts's registerCatalogTool runs it:
 * resolve the caller's tier, re-resolve once before denying (a stale cache must
 * not cost a conversion), and on failure return a typed TIER_REQUIRED envelope —
 * a returned value, never a throw. This IS the gate (real functions), driven here
 * without the McpServer glue so the walk runs on a mocked transport.
 */
async function gatedInvoke(
  entry: ToolCatalogEntry,
  transport: PidgeonTransport,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const def = entry.factory();
  let userTier = normalizeTier(await transport.getTier());
  if (!clientGateAllows(userTier, entry.requiredTier)) {
    userTier = normalizeTier(await transport.getTier(true));
  }
  if (!clientGateAllows(userTier, entry.requiredTier)) {
    return tierGateResult({ toolName: def.name, currentTier: userTier, requiredTier: entry.requiredTier });
  }
  return def.handler(transport, args);
}

/**
 * A mock transport that records every method the journey touches, so a test can
 * prove a denied Pro step never reached the transport (no Bridge call, no 403).
 * Only the four journey methods + getTier are exercised.
 */
class JourneyTransport {
  readonly calls = { getTier: 0, generate: 0, generatePopulation: 0, getPopulationJob: 0, loftStatus: 0 };
  lastPolledJobId: string | undefined;

  constructor(private readonly tier: Tier) {}

  async getTier(): Promise<Tier> {
    this.calls.getTier++;
    return this.tier;
  }

  async generate(messageType: string, options?: GenerateOptions): Promise<GenerateResult> {
    this.calls.generate++;
    // A recognizable HL7 line + a deterministic effective seed (drawn when the
    // caller left seed unset — the reproducibility affordance the envelope carries).
    return {
      messages: [`MSH|^~\\&|PIDGEON|TEST|RCV|FAC|20260707120000||${messageType}|MSGID1|P|2.5.1`],
      effectiveSeed: options?.seed ?? 4242,
    };
  }

  async generatePopulation(_options: PopulationOptions): Promise<PopulationStartResult> {
    this.calls.generatePopulation++;
    return { jobId: "job_journey_1" };
  }

  async getPopulationJob(jobId: string): Promise<PopulationJobStatus> {
    this.calls.getPopulationJob++;
    this.lastPolledJobId = jobId;
    // Echo the jobId back so the test can prove the polled id is the one composed
    // out of generate_population's envelope, not an out-of-band constant.
    return {
      id: jobId,
      status: "completed",
      totalCount: 500,
      generatedCount: 500,
      progressPercent: 100,
      startedAt: "2026-07-07T12:00:00Z",
      completedAt: "2026-07-07T12:00:42Z",
      validationErrorCount: 0,
    };
  }

  async loftStatus(_options?: LoftStatusOptions): Promise<LoftStatusResult> {
    this.calls.loftStatus++;
    return {
      interfaces: [
        { name: "Epic ADT", status: "healthy", messageCount: 1234, errorRate: 0.01 },
        { name: "Cerner Labs", status: "warning", messageCount: 567, errorRate: 0.12 },
      ],
      summary: "2 interfaces monitored. 1 healthy, 1 warning.",
    };
  }

  asTransport(): PidgeonTransport {
    return this as unknown as PidgeonTransport;
  }
}

const GENERATE = entryFor("generate_message");
const POPULATION = entryFor("generate_population");
const POPULATION_STATUS = entryFor("population_status");
const LOFT = entryFor("loft_status");

async function main(): Promise<void> {
  console.log("Running cross-app journey (generate→seed→watch) two-walk gate...\n");

  // -------------------------------------------------------------------------
  // Sanity: the tiers the journey depends on are what the catalog gates on.
  // -------------------------------------------------------------------------
  await test("journey step tiers: generate free; population/population_status/loft Pro", () => {
    assert(GENERATE.requiredTier === "free", "generate_message must be free (the front door)");
    assert(POPULATION.requiredTier === "pro", "generate_population must be Pro");
    assert(POPULATION_STATUS.requiredTier === "pro", "population_status must be Pro");
    assert(LOFT.requiredTier === "pro", "loft_status must be Pro");
  });

  await test("retired demo environment cannot open a Pro tool", () => {
    const previous = process.env.PIDGEON_DEMO_MODE;
    process.env.PIDGEON_DEMO_MODE = "true";
    try {
      assert(clientGateAllows("free", "pro") === false, "ambient demo state must not bypass the MCP tier gate");
    } finally {
      if (previous === undefined) delete process.env.PIDGEON_DEMO_MODE;
      else process.env.PIDGEON_DEMO_MODE = previous;
    }
  });

  // -------------------------------------------------------------------------
  // WALK 1 — free tier. Free step composes; Pro steps degrade to TIER_REQUIRED
  // envelopes; the loop is never broken by a hard 403 (H-14).
  // -------------------------------------------------------------------------
  await test("FREE walk: the whole journey runs to completion without a single throw (loop unbroken)", async () => {
    const t = new JourneyTransport("free");
    const transport = t.asTransport();

    // The three journey steps, in order — none may throw.
    const step1 = await gatedInvoke(GENERATE, transport, { messageType: "ADT^A01" });
    const step2 = await gatedInvoke(POPULATION, transport, { population: 500, format: "hl7" });
    const step3 = await gatedInvoke(LOFT, transport, {});

    // Every step returned a ToolResult (a value, not a rejected promise) — the
    // definition of "no hard 403 broke the loop" at this layer.
    for (const [i, r] of [step1, step2, step3].entries()) {
      assert(Array.isArray(r.content) && r.content.length > 0, `step ${i + 1} returned no content`);
    }
  });

  await test("FREE walk: generate_message (free) composes — envelope carries messages + effectiveSeed", async () => {
    const t = new JourneyTransport("free");
    const res = await gatedInvoke(GENERATE, t.asTransport(), { messageType: "ADT^A01" });
    const env = parseEnvelope(res.content[0].text);
    assert(env["ok"] === true, "generate_message must emit an ok:true envelope on the free tier");
    const messages = env["messages"] as string[];
    assert(Array.isArray(messages) && messages.length >= 1, "envelope must carry messages[]");
    assert(messages[0].startsWith("MSH|"), "the message is carried by value, ready to feed the next tool");
    assert(typeof env["effectiveSeed"] === "number", "envelope must carry the reproducibility seed");
    assert(t.calls.generate === 1, "the free step actually reached the transport");
  });

  await test("FREE walk: generate_population (Pro) → TIER_REQUIRED envelope, NOT a hard 403, transport untouched", async () => {
    const t = new JourneyTransport("free");
    const res = await gatedInvoke(POPULATION, t.asTransport(), { population: 500, format: "hl7" });
    const env = parseEnvelope(res.content[0].text);
    assert(env["ok"] === false, "a Pro tool on the free tier must be a soft ok:false denial");
    const error = env["error"] as Record<string, unknown>;
    assert(error["code"] === "TIER_REQUIRED", `expected TIER_REQUIRED, got ${JSON.stringify(error["code"])}`);
    const tier = error["tier"] as Record<string, unknown>;
    assert(tier["current"] === "free" && tier["required"] === "pro", "the envelope names the current + required tier");
    // The gate short-circuits at the CLIENT before any transport call — so there
    // is no Bridge round-trip, and therefore no 403 could ever have been raised.
    assert(t.calls.generatePopulation === 0, "a denied Pro step must NOT reach the transport (no Bridge call, no 403)");
    // And the human line still teaches the unlock path (H-14: denials teach softly).
    assert(res.content[0].text.includes("Upgrade at:"), "the denial must carry the human upgrade path");
  });

  await test("FREE walk: loft_status (Pro) → TIER_REQUIRED envelope, transport untouched", async () => {
    const t = new JourneyTransport("free");
    const res = await gatedInvoke(LOFT, t.asTransport(), {});
    const env = parseEnvelope(res.content[0].text);
    assert(env["ok"] === false, "loft_status on the free tier is a soft denial");
    assert((env["error"] as Record<string, unknown>)["code"] === "TIER_REQUIRED", "typed TIER_REQUIRED, not a crash");
    assert(t.calls.loftStatus === 0, "a denied Pro step must NOT reach the transport");
  });

  await test("FREE walk: a free step STILL composes after the Pro denials (the loop kept going)", async () => {
    const t = new JourneyTransport("free");
    // Deny the two Pro steps first...
    await gatedInvoke(POPULATION, t.asTransport(), { population: 500, format: "hl7" });
    await gatedInvoke(LOFT, t.asTransport(), {});
    // ...then prove a subsequent free call is entirely unaffected — no latched
    // failure state, no broken loop.
    const res = await gatedInvoke(GENERATE, t.asTransport(), { messageType: "ORU^R01" });
    const env = parseEnvelope(res.content[0].text);
    assert(env["ok"] === true, "the free loop must keep working after Pro denials");
    assert((env["messages"] as string[])[0].startsWith("MSH|"), "the free step still produces a message");
  });

  // -------------------------------------------------------------------------
  // WALK 2 — entitled (Pro). Every step runs; the chain composes end-to-end
  // FROM THE ENVELOPES ALONE (step N's envelope is step N+1's argument).
  // -------------------------------------------------------------------------
  await test("ENTITLED walk: generate → seed → poll → watch composes from envelopes alone", async () => {
    const t = new JourneyTransport("pro");
    const transport = t.asTransport();

    // Step 1 — Post: generate a message. The envelope carries it by value.
    const genRes = await gatedInvoke(GENERATE, transport, { messageType: "ADT^A01" });
    const genEnv = parseEnvelope(genRes.content[0].text);
    assert(genEnv["ok"] === true, "generate must succeed for a Pro caller");
    const message = (genEnv["messages"] as string[])[0];
    assert(message.startsWith("MSH|"), "the Post artifact is carried by value in the envelope");

    // Step 2 — Flock: start a population job. The envelope carries the jobId.
    const popRes = await gatedInvoke(POPULATION, transport, { population: 500, format: "hl7" });
    const popEnv = parseEnvelope(popRes.content[0].text);
    assert(popEnv["ok"] === true, "generate_population must succeed for a Pro caller");
    const jobId = popEnv["jobId"];
    assert(typeof jobId === "string" && jobId.length > 0, "the seed step's envelope must carry a jobId handoff");

    // Step 3 — Flock poll: the jobId is fed STRAIGHT from step 2's envelope. This
    // is the load-bearing composition — no out-of-band knowledge, no prose parsing.
    const statusRes = await gatedInvoke(POPULATION_STATUS, transport, { jobId: jobId as string });
    const statusEnv = parseEnvelope(statusRes.content[0].text);
    assert(statusEnv["ok"] === true, "population_status must succeed for a Pro caller");
    assert(statusEnv["jobId"] === jobId, "the polled jobId must be exactly the one from the seed envelope");
    assert(t.lastPolledJobId === jobId, "the transport was polled with the composed jobId, not a constant");
    assert(statusEnv["ready"] === true, "the completed job reports ready");
    assert(
      typeof statusEnv["downloadRef"] === "string" && (statusEnv["downloadRef"] as string).includes(jobId as string),
      "a ready job carries the download ref — the terminal artifact of the seed step",
    );

    // Step 4 — Loft: watch. Terminal envelope carries interface health, no content.
    const loftRes = await gatedInvoke(LOFT, transport, {});
    const loftEnv = parseEnvelope(loftRes.content[0].text);
    assert(loftEnv["ok"] === true, "loft_status must succeed for a Pro caller");
    const interfaces = loftEnv["interfaces"] as Array<Record<string, unknown>>;
    assert(Array.isArray(interfaces) && interfaces.length === 2, "the watch envelope carries per-interface health rows");
    const health = loftEnv["health"] as Record<string, number>;
    assert(health["healthy"] === 1 && health["warning"] === 1, "the health roll-up is machine-readable");
    // H-33: the watch envelope carries health metrics only — never message content.
    const asText = JSON.stringify(loftEnv);
    assert(!asText.includes("MSH|"), "no message content may ride the Loft envelope (H-33)");

    // Every transport step was actually exercised.
    assert(
      t.calls.generate === 1 && t.calls.generatePopulation === 1 && t.calls.getPopulationJob === 1 && t.calls.loftStatus === 1,
      "the entitled walk drove every journey step once",
    );
  });

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main();
