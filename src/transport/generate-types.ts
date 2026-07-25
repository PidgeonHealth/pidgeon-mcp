// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Generate-specific value types, split out of types.ts (which is at its LOC
// budget). Re-exported from transport/index.ts so consumers see them on the
// barrel alongside the rest of the transport contract.

/** A field value pinned for a generation (the "pins" feature). */
export interface LockedValue {
  fieldPath: string;
  value: string;
  dataType?: string;
}

/**
 * The result of a generate call: the messages plus the reproducibility and
 * volume metadata the Bridge returns in response headers — the effective seed
 * (so an unseeded run can be reproduced with seed=N) and the free-tier remaining
 * volume (so an agent self-paces before the daily cap).
 */
export interface GenerateResult {
  messages: string[];
  effectiveSeed?: number;
  volume?: { remaining: number; limit: number; resetsAt?: string };
}
