#!/usr/bin/env ts-node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the bridge transport's wire mapping (src/transport/wire.ts via
 * BridgeClient, over real HTTP against a local stub server).
 *
 * Why this matters: bridge-mode validate used to silently DROP the
 * vendorProfile parameter, so an agent that asked for profile-scoped
 * validation got standard-rule validation instead — a wrong-but-plausible
 * verdict with no error (bridge-contract.md § 3). These tests pin that every
 * MCP-canonical name reaches the Bridge wire under the contract's field name,
 * so a regression fails a body assertion instead of silently degrading
 * validation results.
 */
import http from "http";
import { AddressInfo } from "net";
import { BridgeClient } from "../src/transport/bridge";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
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

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

/**
 * Minimal Bridge stub: records every JSON POST body and answers with a
 * success envelope, so assertions run against what actually crossed HTTP.
 */
function startStubBridge(): Promise<{
  server: http.Server;
  baseUrl: string;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ url: req.url ?? "", body });
      res.setHeader("Content-Type", "application/json");
      // The artifact-discovery route rides the flat recipe/run response posture
      // (a plain result body), not the standard success envelope.
      if (req.url?.startsWith("/api/artifacts/search")) {
        res.end(
          JSON.stringify({
            query: "epic",
            total: 1,
            truncated: false,
            items: [{ id: "abc", name: "epic-adt-a01", kind: "vendor-profile", title: "t", description: "", source: "starter", installed: false, installCommand: "pidgeon data install starter-recipes" }],
          })
        );
        return;
      }
      res.end(
        JSON.stringify({
          success: true,
          data: req.url === "/api/generate"
            ? ["MSH|^~\\&|stub"]
            : { isValid: true, standard: "hl7", errors: [], warnings: [] },
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}`, requests });
    });
  });
}

console.log("Running bridge-wire tests...\n");

async function main(): Promise<void> {
  const { server, baseUrl, requests } = await startStubBridge();
  const client = new BridgeClient({ baseUrl });

  await test("validate forwards vendorProfile to the Bridge wire", async () => {
    requests.length = 0;
    await client.validate("MSH|^~\\&|App", { vendorProfile: "epic.adt_outbound" });
    assert(requests.length === 1, "exactly one HTTP request");
    assert(requests[0].url === "/api/validate", `url is /api/validate (got ${requests[0].url})`);
    assert(
      requests[0].body.vendorProfile === "epic.adt_outbound",
      `vendorProfile must reach the wire as ValidateRequest's vendorProfile field (body: ${JSON.stringify(requests[0].body)})`
    );
  });

  await test("validate maps MCP `message` to wire `messageContent`", async () => {
    requests.length = 0;
    await client.validate("MSH|^~\\&|App", { mode: "strict" });
    assert(
      requests[0].body.messageContent === "MSH|^~\\&|App",
      "message must cross as messageContent"
    );
    assert(requests[0].body.mode === "strict", "mode must pass through");
  });

  await test("validate without vendorProfile sends no vendorProfile field", async () => {
    requests.length = 0;
    await client.validate("MSH|^~\\&|App");
    assert(
      !("vendorProfile" in requests[0].body),
      `no vendorProfile field expected (body: ${JSON.stringify(requests[0].body)})`
    );
  });

  await test("searchArtifacts GETs /api/artifacts/search with the query params and reads the flat body", async () => {
    requests.length = 0;
    const result = await client.searchArtifacts({
      query: "epic",
      kind: "vendor-profile",
      installedOnly: true,
      limit: 5,
    });
    assert(requests.length === 1, "exactly one HTTP request");
    const url = new URL(requests[0].url, "http://stub");
    assert(url.pathname === "/api/artifacts/search", `path is /api/artifacts/search (got ${url.pathname})`);
    assert(url.searchParams.get("query") === "epic", "query param crosses the wire");
    assert(url.searchParams.get("kind") === "vendor-profile", "kind param crosses the wire");
    assert(url.searchParams.get("installedOnly") === "true", "installedOnly crosses as a bool literal");
    assert(url.searchParams.get("limit") === "5", "limit crosses the wire");
    assert(result.total === 1 && result.items[0].name === "epic-adt-a01", "flat body parses without an envelope unwrap");
  });

  await test("searchArtifacts omits unset params from the wire", async () => {
    requests.length = 0;
    await client.searchArtifacts({});
    const url = new URL(requests[0].url, "http://stub");
    assert([...url.searchParams.keys()].length === 0, `no params expected (got ${url.search})`);
  });

  await test("generate passes vendor through unchanged", async () => {
    requests.length = 0;
    await client.generate("ADT^A01", { vendor: "epic" });
    assert(requests[0].url === "/api/generate", "url is /api/generate");
    assert(requests[0].body.vendor === "epic", "vendor must pass through");
    assert(requests[0].body.messageType === "ADT^A01", "messageType must pass through");
  });

  // WHY: the advisory judge endpoint takes `message` (not the `messageContent`
  // that validate/refine use — it predates that rename), and the MCP must default
  // contentIsSynthetic to false so a panel that can't attest provenance keeps the
  // judge on-device. A regression here would either 400 the call or leak content.
  await test("semantic review posts `message` to /api/ai/semantic-review, synthetic=false by default", async () => {
    requests.length = 0;
    await client.semanticReview("MSH|^~\\&|App");
    assert(
      requests[0].url === "/api/ai/semantic-review",
      `url is /api/ai/semantic-review (got ${requests[0].url})`
    );
    assert(
      requests[0].body.message === "MSH|^~\\&|App",
      `message must cross as \`message\` (body: ${JSON.stringify(requests[0].body)})`
    );
    assert(
      requests[0].body.contentIsSynthetic === false,
      "contentIsSynthetic defaults to false to keep real content on-device"
    );
  });

  // WHY: the free deterministic tier must reach its own offline endpoint with just
  // the message — no AI options, no synthetic attestation. A regression that routed
  // it through the judge endpoint would wrongly consume the AI volume cap.
  await test("clinical check posts just `message` to /api/clinical-checks", async () => {
    requests.length = 0;
    await client.clinicalCheck("MSH|^~\\&|App");
    assert(
      requests[0].url === "/api/clinical-checks",
      `url is /api/clinical-checks (got ${requests[0].url})`
    );
    assert(
      requests[0].body.message === "MSH|^~\\&|App",
      `message must cross as \`message\` (body: ${JSON.stringify(requests[0].body)})`
    );
    assert(
      !("contentIsSynthetic" in requests[0].body),
      "deterministic checks carry no synthetic attestation — it is not an AI call"
    );
  });

  server.close();

  console.log(`\nbridge-wire: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
