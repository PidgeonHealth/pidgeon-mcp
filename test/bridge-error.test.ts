#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Interceptor error-shaping tests: drive a real BridgeClient against an
 * in-process HTTP server returning canned Bridge envelopes, and prove every
 * non-2xx surfaces the SERVER'S structured message (not axios prose like
 * "Request failed with status code 400") — the error-legibility repair
 * (AGENT_API_ERGONOMICS_AUDIT §2.2 item 8, §7.3). Tier gates and volume caps
 * keep their own typed classes; everything else becomes a BridgeError carrying
 * the message + code.
 *
 * Run: npx ts-node test/bridge-error.test.ts
 */

import * as http from "http";
import { AddressInfo } from "net";
import { BridgeClient } from "../src/transport/bridge";
import { TierError } from "../src/transport/types";
import { ThrottleError, BridgeError } from "../src/transport/errors";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

interface Canned {
  status: number;
  body: unknown;
}

/** A one-shot server that answers every request with the same canned response. */
function serverReturning(canned: Canned): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(canned.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(canned.body));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

async function main(): Promise<void> {
  await test("an enveloped 400 surfaces the Bridge's message + code as a BridgeError, never axios prose", async () => {
    const srv = await serverReturning({
      status: 400,
      body: { success: false, data: null, error: { code: "INVALID_TYPE", message: "Message type 'XYZ^Z99' is not a recognized HL7 trigger." } },
    });
    try {
      const client = new BridgeClient({ baseUrl: srv.url, timeout: 5000 });
      let caught: unknown;
      try {
        await client.generate("XYZ^Z99");
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof BridgeError, `expected BridgeError, got ${caught?.constructor?.name}`);
      const be = caught as BridgeError;
      assert(be.message.includes("not a recognized HL7 trigger"), `must carry the Bridge message: ${be.message}`);
      assert(!be.message.includes("status code"), "must NOT leak axios prose");
      assert(be.code === "INVALID_TYPE", `must carry the error code, got ${be.code}`);
    } finally {
      srv.close();
    }
  });

  await test("a 402 subscription envelope stays a TierError (not a generic BridgeError)", async () => {
    const srv = await serverReturning({
      status: 402,
      body: { success: false, data: null, error: { code: "SUBSCRIPTION_REQUIRED", message: "This operation requires the Professional tier." } },
    });
    try {
      const client = new BridgeClient({ baseUrl: srv.url, timeout: 5000 });
      let caught: unknown;
      try {
        await client.diff("a", "b");
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof TierError, `expected TierError, got ${caught?.constructor?.name}`);
      assert((caught as TierError).message.includes("Professional tier"), "TierError must carry the Bridge message");
    } finally {
      srv.close();
    }
  });

  await test("a 429 throttle envelope stays a ThrottleError carrying remaining/resetsAt", async () => {
    const srv = await serverReturning({
      status: 429,
      body: {
        success: false,
        data: { reason: "daily_cap_reached", remaining: 0, resetsAt: "2026-07-04T00:00:00Z" },
        error: { code: "RATE_LIMITED", message: "Free daily cap reached." },
      },
    });
    try {
      const client = new BridgeClient({ baseUrl: srv.url, timeout: 5000 });
      let caught: unknown;
      try {
        await client.generate("ADT^A01");
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof ThrottleError, `expected ThrottleError, got ${caught?.constructor?.name}`);
      const te = caught as ThrottleError;
      assert(te.remaining === 0 && te.resetsAt === "2026-07-04T00:00:00Z", "throttle fields must carry through");
    } finally {
      srv.close();
    }
  });

  await test("a non-enveloped 404 names the missing-endpoint shape, not axios prose", async () => {
    const srv = await serverReturning({ status: 404, body: "Not Found" });
    try {
      const client = new BridgeClient({ baseUrl: srv.url, timeout: 5000 });
      let caught: unknown;
      try {
        await client.sendMessage("MSH|...", "/pickup");
      } catch (err) {
        caught = err;
      }
      assert(caught instanceof BridgeError, `expected BridgeError, got ${caught?.constructor?.name}`);
      const be = caught as BridgeError;
      assert(be.message.includes("404"), "must name the 404");
      assert(be.message.includes("pidgeon_status"), "must point at the diagnostics tool");
      assert(!be.message.includes("status code"), "must NOT leak axios prose");
    } finally {
      srv.close();
    }
  });

  console.log(`\nbridge-error: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
