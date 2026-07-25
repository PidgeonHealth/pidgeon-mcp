// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Transport error types beyond TierError (which lives in types.js — at its LOC
// budget, so this sibling holds newer error classes).

/**
 * The free-tier daily volume cap was hit (HTTP 429 from the Bridge). Carries the
 * structured throttle fields so a tool handler can return a graceful, self-paced
 * upgrade message instead of crashing the agent loop — never a hard failure.
 */
export class ThrottleError extends Error {
  readonly reason: string;
  readonly remaining: number;
  readonly resetsAt: string;

  constructor(message: string, reason = "daily_cap_reached", remaining = 0, resetsAt = "") {
    super(message);
    this.name = "ThrottleError";
    this.reason = reason;
    this.remaining = remaining;
    this.resetsAt = resetsAt;
  }
}

/**
 * A structured Bridge failure (any non-2xx that carried the standard
 * `{ error: { code, message } }` envelope). Carries the Bridge's own message and
 * error code so a tool handler surfaces the real, actionable reason — never
 * axios prose like "Request failed with status code 400". The interceptor throws
 * this for every enveloped failure that is not a tier gate (TierError) or a
 * volume cap (ThrottleError).
 */
export class BridgeError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code = "", status?: number) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.status = status;
  }
}
