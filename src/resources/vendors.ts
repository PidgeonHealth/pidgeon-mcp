// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { PidgeonTransport } from "../transport/index.js";
import { ResourceDefinition } from "./hl7-segments.js";
import { retrieval } from "./provenance.js";

// ---------------------------------------------------------------------------
// Embedded vendor catalog
// ---------------------------------------------------------------------------

interface VendorEntry {
  name: string;
  displayName: string;
  description: string;
  messageTypes: string[];
}

const VENDOR_CATALOG: VendorEntry[] = [
  {
    name: "epic",
    displayName: "Epic Systems",
    description:
      "Most widely deployed EHR in the US. Known for 7-digit MRNs (PID.3), MSH.3=EPIC, ADT-heavy workflows.",
    messageTypes: ["ADT", "ORU", "ORM", "RDE", "MDM"],
  },
  {
    name: "cerner",
    displayName: "Cerner (Oracle Health)",
    description:
      "Major EHR with 11-digit patient IDs. MSH.3=Cerner_Millennium. Strong in large health systems.",
    messageTypes: ["ADT", "ORU", "ORM", "RDE"],
  },
  {
    name: "meditech",
    displayName: "Meditech",
    description:
      "Common in community hospitals. Uses MEDITECH in MSH.3. Older format conventions.",
    messageTypes: ["ADT", "ORU", "ORM"],
  },
  {
    name: "allscripts",
    displayName: "Allscripts / Veradigm",
    description:
      "Ambulatory-focused EHR. Patient IDs often prefixed AS-. Strong pharmacy workflows.",
    messageTypes: ["RDE", "ORM", "ADT"],
  },
  {
    name: "athena",
    displayName: "athenahealth",
    description:
      "Cloud-native ambulatory EHR. FHIR-first with strong HL7 v2 support.",
    messageTypes: ["ADT", "ORM", "ORU"],
  },
  {
    name: "nextgen",
    displayName: "NextGen Healthcare",
    description: "Mid-market ambulatory and behavioral health EHR.",
    messageTypes: ["ADT", "ORU", "ORM"],
  },
  {
    name: "mirth",
    displayName: "Mirth Connect",
    description:
      "Open-source integration engine. Often the pass-through between systems, not an EHR.",
    messageTypes: ["ADT", "ORU", "ORM", "RDE"],
  },
];

// ---------------------------------------------------------------------------
// Resource factory
// ---------------------------------------------------------------------------

export function createVendorsResource(): ResourceDefinition {
  return {
    uri: "pidgeon://vendors",
    name: "Vendor Profiles Index",
    description:
      "Vendor interface profiles — a workspace fact. When the Bridge is running, this reads the " +
      "loaded interface profiles (with 'which substrate answered' provenance and a staleness note); " +
      "otherwise it falls back to this server's embedded common-vendor catalog. " +
      "Use a vendor name with generate_message (vendor flag) to produce vendor-specific test messages.",
    mimeType: "application/json",
    handler: async (transport: PidgeonTransport, _uriParams: Record<string, string>) => {
      // Prefer the Bridge's loaded vendor profiles (the real workspace facts);
      // fall back to the embedded common-vendors catalog when the Bridge is down.
      // Each branch stamps a uniform retrieval descriptor naming WHICH SUBSTRATE
      // answered (H-32) and the point-in-time staleness contract (H-31).
      try {
        const profiles = await transport.listVendorProfiles();
        if (profiles.length > 0) {
          const body = {
            ...retrieval("bridge", {
              stalenessAddendum:
                "Vendor profiles load from embedded YAML in the Bridge build — they are static " +
                "per Bridge version and change only when the Bridge is upgraded.",
            }),
            description:
              "Loaded vendor interface profiles (metadata only — no message bodies). " +
              "Read pidgeon://vendors again after a Bridge upgrade for a fresh view.",
            count: profiles.length,
            profiles,
          };
          return {
            contents: [
              { uri: "pidgeon://vendors", mimeType: "application/json", text: JSON.stringify(body, null, 2) },
            ],
          };
        }
      } catch {
        // Bridge down / CLI mode / endpoint absent — fall through to embedded.
      }

      const body = {
        ...retrieval("embedded"),
        description:
          "This MCP server's built-in common-vendor catalog (offline fallback). " +
          "Start Pidgeon Bridge to read the actual loaded interface profiles for this workspace.",
        count: VENDOR_CATALOG.length,
        vendors: VENDOR_CATALOG,
      };
      return {
        contents: [
          { uri: "pidgeon://vendors", mimeType: "application/json", text: JSON.stringify(body, null, 2) },
        ],
      };
    },
  };
}
