# Pidgeon MCP Manifest

> Generated from `src/catalog.ts` + each tool's Zod input schema by `npm run manifest`. Do not edit by hand.

**@pidgeonhealth/pidgeon-mcp** v0.1.0-beta.1 — 22 tools (13 free, 9 Pro), 6 prompts, 6 resources.

One valid message is free; production volume, team leverage, and live-interface tools are paid. The MCP transport is the delivery mechanism, not the entitlement — gating is enforced at Bridge auth + subscription.

## On-device AI

AI-assisted tools (refine_hl7_segment) default to a bundled on-device model — no API key, no PHI leaves the machine. Run `pidgeon ai download qwen3-4b` once to set it up; BYOK is optional. The free explain_error tool needs no model at all.

- **Default**: on-device (Qwen3-4B (bundled, served via Ollama))
- **BYOK**: optional — never required
- **Setup**: `pidgeon ai download qwen3-4b`

## Transports

- **cli** — PIDGEON_MODE=cli — spawns the pidgeon CLI; zero-auth showcase surface.
- **bridge** — PIDGEON_MODE=bridge — authenticated HTTP Bridge capability surface.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PIDGEON_MODE` | `bridge` | Transport: bridge or cli. |
| `PIDGEON_BRIDGE_URL` | `http://localhost:5100` | Bridge API base URL (Bridge mode). |
| `PIDGEON_API_KEY` | *(none)* | API key for authenticated Bridge instances. |
| `PIDGEON_CLI_PATH` | `pidgeon` | Path to the pidgeon CLI executable (CLI mode). |
| `PIDGEON_TOOLS` | *(none)* | Toolset narrowing (H-2): comma-separated tool names or tiers (free/pro) to REGISTER. Empty = full roster (default). |
| `PIDGEON_EXCLUDE_TOOLS` | *(none)* | Toolset narrowing (H-2): comma-separated tool names or tiers to withhold, applied after the include list. Empty = exclude nothing. |

## Token budget (cold-start accounting)

Per-tool cold-start cost — the `{ name, description, inputSchema, annotations }` object each tool ships in `tools/list`, measured as compact JSON, tokens estimated at 4 chars/token. Enforced by `test/manifest.test.ts`: the build fails if the cold-start total exceeds 8,000 tokens (H-20) or any single tool's full definition exceeds 2,000 chars (H-21; target 1,200).

| Tool | Tier | Desc | Schema | Annot | Full (chars) | ~Tokens |
|---|---|---|---|---|---|---|
| `generate_message` | free | 435 | 1302 | 90 | 1901 | 475 |
| `explain_error` | free | 532 | 1181 | 43 | 1827 | 457 |
| `semantic_review` | free | 655 | 801 | 43 | 1572 | 393 |
| `conform` | pro | 325 | 1066 | 42 | 1498 | 375 |
| `generate_population` | pro | 516 | 689 | 91 | 1373 | 343 |
| `run_workflow` | pro | 504 | 630 | 91 | 1295 | 324 |
| `send_message` | pro | 360 | 775 | 88 | 1293 | 323 |
| `search_artifacts` | free | 398 | 685 | 43 | 1200 | 300 |
| `refine_hl7_segment` | pro | 355 | 671 | 91 | 1193 | 298 |
| `lookup_code` | free | 535 | 536 | 43 | 1183 | 296 |
| `get_segment_spec` | free | 555 | 508 | 43 | 1180 | 295 |
| `manage_data_packages` | free | 333 | 673 | 88 | 1172 | 293 |
| `validate_message` | free | 316 | 736 | 43 | 1169 | 292 |
| `diff_messages` | pro | 300 | 639 | 43 | 1053 | 263 |
| `deidentify_message` | free | 353 | 471 | 90 | 990 | 248 |
| `clinical_check` | free | 586 | 232 | 43 | 933 | 233 |
| `analyze_vendor_pattern` | pro | 270 | 430 | 43 | 823 | 206 |
| `describe_tool` | free | 484 | 187 | 43 | 785 | 196 |
| `explain_message` | free | 272 | 331 | 43 | 719 | 180 |
| `loft_status` | pro | 221 | 315 | 43 | 648 | 162 |
| `population_status` | pro | 279 | 179 | 43 | 576 | 144 |
| `pidgeon_status` | free | 230 | 62 | 43 | 407 | 102 |
| **Total** | | | | | **24,790** | **6,198** |

Cold-start total: **6,198 tokens** of the 8,000-token budget (77% used, H-20). Per-tool hard ceiling 2,000 chars, target 1,200 chars (H-21).

## Free tools (13)

### `generate_message`

Generate synthetic healthcare test messages in HL7 v2, FHIR R4, or NCPDP SCRIPT format. Use this when you need realistic test data for interface testing, go-live prep, or validating parsers. Deterministic by `seed` — the same seed reproduces the exact bytes and an unseeded run returns its effective seed, so retries are safe. For a multi-step, one-patient clinical scenario use run_workflow instead; this produces standalone messages.

**Annotations** (H-15): `{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "messageType": {
      "type": "string",
      "description": "Message type, e.g. 'ADT^A01', 'ORU^R01' (HL7), 'Patient' (FHIR), 'NewRx' (NCPDP). Standard is auto-inferred."
    },
    "count": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "default": 1,
      "description": "Number of messages (1-100). Counts against the free daily cap."
    },
    "vendor": {
      "type": "string",
      "description": "Apply vendor patterns, e.g. 'epic', 'cerner', 'meditech'."
    },
    "hl7Version": {
      "type": "string",
      "description": "HL7 version override, e.g. '2.5.1', '2.7'. HL7 only."
    },
    "seed": {
      "type": "integer",
      "description": "Seed for reproducible output."
    },
    "lockedValues": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "fieldPath": {
            "type": "string",
            "description": "Field path to pin, e.g. 'PID.5.1' or 'MSH.9'."
          },
          "value": {
            "type": "string",
            "description": "Exact value to place at that field."
          },
          "dataType": {
            "type": "string",
            "description": "Optional HL7 data type hint."
          }
        },
        "required": [
          "fieldPath",
          "value"
        ],
        "additionalProperties": false
      },
      "description": "Pin exact field values to a precise spec. Mutually exclusive with lockSessionName."
    },
    "lockSessionName": {
      "type": "string",
      "description": "Saved pin session name (see pidgeon://session) to constrain generation. Mutually exclusive with lockedValues."
    }
  },
  "required": [
    "messageType"
  ],
  "additionalProperties": false
}
```

**Output envelope** (H-16): appends `ok: true` + the keys below via `withSuccessEnvelope`; shaped to feed `validate_message`, `explain_message`, `refine_hl7_segment`, `send_message`.

| Key | Contract |
|---|---|
| `messages` | The generated message(s), by value — feed a single message straight into validate_message / explain_message / send_message. |
| `messageType` | The requested message type, echoed back. |
| `count` | Number of messages generated. |
| `effectiveSeed` | The seed actually used (drawn for an unseeded run); pass it back as `seed` to reproduce the exact bytes. |

### `validate_message`

Validate an HL7 v2, FHIR R4, or NCPDP SCRIPT message against the specification. Returns a structured list of errors and warnings with field paths, severity levels, and a conformance score. Use 'compatibility' mode for real-world messages that may have minor spec deviations; use 'strict' mode for compliance testing.

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "The raw message text to validate. For HL7, paste the pipe-delimited message. For FHIR, paste the JSON. For NCPDP, paste the XML."
    },
    "standard": {
      "type": "string",
      "enum": [
        "hl7",
        "fhir",
        "ncpdp"
      ],
      "description": "Standard to validate against. Auto-detected from message format if not specified."
    },
    "mode": {
      "type": "string",
      "enum": [
        "strict",
        "compatibility"
      ],
      "default": "compatibility",
      "description": "strict: enforces full spec compliance. compatibility: accepts common real-world deviations."
    },
    "vendorProfile": {
      "type": "string",
      "description": "Named vendor profile to validate against (e.g., 'epic_er', 'cerner_pharmacy')."
    }
  },
  "required": [
    "message"
  ],
  "additionalProperties": false
}
```

**Output envelope** (H-16): appends `ok: true` + the keys below via `withSuccessEnvelope`; shaped to feed `explain_error`.

| Key | Contract |
|---|---|
| `isValid` | true when the message passed with no errors. |
| `conformanceScore` | 0-1 conformance score against the spec (and vendor profile). |
| `findings` | Errors + warnings, each { segment, field, ruleId, message, severity } — feed verbatim to explain_error.findings. |

### `explain_message`

Parse an HL7 or FHIR message and explain it in plain English. Shows the message structure (segments, fields), identifies the message type and trigger event, and summarizes the clinical meaning. Useful for onboarding, debugging, or understanding unfamiliar message formats.

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "The raw message text to explain. Supports HL7 v2 pipe-delimited format and FHIR JSON."
    },
    "standard": {
      "type": "string",
      "enum": [
        "hl7",
        "fhir"
      ],
      "description": "Message standard. Auto-detected if not specified."
    }
  },
  "required": [
    "message"
  ],
  "additionalProperties": false
}
```

**Output envelope** (H-16): appends `ok: true` + the keys below via `withSuccessEnvelope`; shaped to feed `refine_hl7_segment`.

| Key | Contract |
|---|---|
| `standard` | Detected standard: 'hl7' or 'fhir'. |
| `messageType` | HL7 only: the message type, e.g. 'ADT^A01'. |
| `segments` | HL7 only: every segment as { index, name }, where index is the 0-based position — pass it as refine_hl7_segment.segmentIndex. |
| `resourceType` | FHIR only: the resource type, e.g. 'Patient'. |
| `id` | FHIR only: the resource id, when present. |

### `explain_error`

Triage a validation or conformance failure: for each finding, explain in plain English what is wrong, why the rule exists, and the concrete fix. Pass a raw `message` (it will be validated) or a list of `findings` you already have (e.g. from validate_message or conform). Runs on-device — no API key, no PHI leaves the machine. First rung of the triage ladder: this handles spec/conformance findings — for clinical-sense problems use clinical_check (deterministic rules) then semantic_review (the on-device judge), not explain_error.

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "Raw HL7/FHIR message to validate and triage. Provide this OR `findings`."
    },
    "standard": {
      "type": "string",
      "enum": [
        "hl7",
        "fhir"
      ],
      "description": "Message standard. Auto-detected if omitted."
    },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "segment": {
            "type": "string",
            "description": "Segment name, e.g. 'PID'."
          },
          "field": {
            "type": [
              "string",
              "number"
            ],
            "description": "Field position, e.g. 3."
          },
          "ruleId": {
            "type": "string",
            "description": "Rule id, e.g. 'MUSTSUPPORT-1' or 'RC5'."
          },
          "message": {
            "type": "string",
            "description": "The error/finding text."
          },
          "severity": {
            "type": "string",
            "enum": [
              "error",
              "warning",
              "info"
            ],
            "description": "Severity. Defaults to 'error'."
          }
        },
        "required": [
          "message"
        ],
        "additionalProperties": false
      },
      "description": "Findings you already have (e.g. from validate_message or conform), triaged without re-validating. Provide this OR `message`."
    },
    "narrate": {
      "type": "boolean",
      "description": "Reword each fix with the on-device model when one is available (default true); set false for deterministic triage only. Narration runs on-device and never changes the contract."
    }
  },
  "additionalProperties": false
}
```

### `lookup_code`

Look up a healthcare reference code to get its display name and description. ICD-10-CM diagnoses resolve against the full code set via the Bridge oracle when the Bridge is running (exact or description search); otherwise, and for LOINC (lab tests) and CVX (vaccines), results come from a small embedded sample of common codes. ICD-9, NDC, RxNorm, CPT, and SNOMED are recognized but have no lookup endpoint yet. Use this to decode a code value's meaning — for an HL7 segment's field layout use get_segment_spec instead, not lookup_code.

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "description": "The code to look up. Examples: '2823-3' (LOINC potassium), 'E11.9' (ICD-10 diabetes), '0069-0105-66' (NDC aspirin), '4' (CVX influenza)."
    },
    "codeSystem": {
      "type": "string",
      "enum": [
        "loinc",
        "icd10",
        "icd9",
        "ndc",
        "cvx",
        "rxnorm",
        "cpt",
        "snomed"
      ],
      "description": "The code system to search."
    },
    "fuzzySearch": {
      "type": "boolean",
      "description": "If true, perform a description-based search instead of exact code match."
    }
  },
  "required": [
    "code",
    "codeSystem"
  ],
  "additionalProperties": false
}
```

### `get_segment_spec`

Get the HL7 v2 specification for a segment, showing fields with their names, data types, lengths, and required/optional status. Use this to understand what a segment contains, find the right field index for a value, or verify that a message is correctly structured. A single field (pass field=<n>) is resolved for the exact hl7Version from the Bridge oracle when the Bridge is running; otherwise an embedded summary of common segments is returned. Describes a segment's fields — to decode a code value (LOINC/ICD-10/CVX) use lookup_code instead, not this.

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "segment": {
      "type": "string",
      "description": "Segment name (e.g., 'PID', 'OBX', 'MSH', 'RXE'). Case-insensitive."
    },
    "field": {
      "type": "integer",
      "exclusiveMinimum": 0,
      "description": "Specific field number to look up (e.g., 5 for PID-5 patient name). Returns just that field's details."
    },
    "hl7Version": {
      "type": "string",
      "default": "2.5.1",
      "description": "HL7 version: '2.3', '2.3.1', '2.4', '2.5', '2.5.1', '2.6', '2.7', '2.7.1', '2.8'."
    }
  },
  "required": [
    "segment"
  ],
  "additionalProperties": false
}
```

### `deidentify_message`

De-identify an HL7 message by removing PHI (patient names, DOB, MRN, SSN, addresses). Returns the de-identified message with a summary of fields modified. Use for creating safe test data from production messages without exposing real patient information. Deterministic by `salt` — the same salt yields the same de-identified output, so retries are safe.

**Annotations** (H-15): `{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "The raw HL7 message to de-identify. Paste the full pipe-delimited message."
    },
    "dateShift": {
      "type": "string",
      "description": "Shift dates by an offset (e.g., '30d' for 30 days, '-14d' for minus 14 days)."
    },
    "salt": {
      "type": "string",
      "description": "Salt for deterministic hashing. Use the same salt to get consistent de-identification across messages."
    }
  },
  "required": [
    "message"
  ],
  "additionalProperties": false
}
```

### `manage_data_packages`

List, install, or remove healthcare reference data packages (LOINC, ICD-10, SNOMED, RxNorm, NDC, CVX, HCPCS, CPT). Installed packages enable richer code lookups, more accurate validation, and clinically coherent generation. install/remove are idempotent — re-installing an installed package or removing an absent one is a safe no-op.

**Annotations** (H-15): `{"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true}`

```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "list",
        "install",
        "remove",
        "status"
      ],
      "description": "Action to perform: list (show all packages), install (add a package), remove (uninstall a package), status (show installed package details)."
    },
    "packageName": {
      "type": "string",
      "description": "Package name (required for install/remove). Use action=list for the live catalog, including public FHIR IGs and member-supplied terminology packs."
    },
    "acceptLicense": {
      "type": "boolean",
      "description": "Accept the license agreement. Required for UMLS-licensed packages (snomed, rxnorm) and AMA-licensed packages (cpt)."
    }
  },
  "required": [
    "action"
  ],
  "additionalProperties": false
}
```

### `search_artifacts`

Search the installable artifacts exposed by this Pidgeon composition — public data packages, plus starter and installed recipes when those private sources are present — by free text and facets; each result carries its exact install command. Not lookup_code (decodes a clinical code), get_segment_spec (a segment's field layout), or manage_data_packages (installs/removes; this tool only discovers).

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Free-text terms; omit to list everything."
    },
    "kind": {
      "type": "string",
      "enum": [
        "vendor-profile",
        "generation-config",
        "data-package"
      ]
    },
    "vendor": {
      "type": "string",
      "description": "e.g. 'epic'"
    },
    "standard": {
      "type": "string",
      "description": "e.g. 'hl7'"
    },
    "message_type": {
      "type": "string",
      "description": "e.g. 'ADT^A01'"
    },
    "installed_only": {
      "type": "boolean",
      "description": "Only already-installed artifacts."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "description": "Default 10, cap 50."
    },
    "detail": {
      "type": "string",
      "enum": [
        "summary",
        "detailed"
      ],
      "description": "detailed adds install commands."
    }
  },
  "additionalProperties": false
}
```

**Output envelope** (H-16): appends `ok: true` + the keys below via `withSuccessEnvelope`; shaped to feed `manage_data_packages`.

| Key | Contract |
|---|---|
| `total` | Matches before the limit was applied. |
| `truncated` | True when items were cut by the limit. |
| `items` | Matching artifacts (installed first, then title): { id, name, kind, title, description, vendor?, standard?, messageType?, source, installed, installCommand, forkedFrom? }. |

### `pidgeon_status`

Check Pidgeon environment health: CLI installation, Bridge connectivity, .NET SDK, current mode, and tier. Returns actionable setup instructions for any missing components. Call this when other tools fail or at conversation start.

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```

### `semantic_review`

Advisory clinical-sense review of an HL7 v2 message by the on-device LLM judge. Flags clinically implausible content in a structurally-valid message — a 10x dose, a sex-conflicting procedure, a note that contradicts the coded result — that spec validation cannot see. Advisory only: findings never change whether a message is valid and never block a pipeline. Runs on-device by default; an unconfigured judge degrades to a note rather than an error. Last rung of the triage ladder: run clinical_check first for the free deterministic rules, and use explain_error for spec/structure findings — reach for this LLM judge only for plausibility the rules miss.

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "The raw HL7 v2 message to review for clinical-sense problems. Paste the pipe-delimited message."
    },
    "contentIsSynthetic": {
      "type": "boolean",
      "default": false,
      "description": "Attest the message carries no PHI. Only this lets a non-local (cloud) model see the content; false (the default) keeps real content on-device."
    },
    "families": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional subset of check families to run (e.g. 'DosePlausibility', 'MedDxPlausibility', 'NarrativeConsistency'). Omit to run them all."
    },
    "maxLatencyMs": {
      "type": "number",
      "description": "Optional wall-clock budget in milliseconds; families not reached within the budget are reported as skipped."
    }
  },
  "required": [
    "message"
  ],
  "additionalProperties": false
}
```

### `clinical_check`

Deterministic clinical-sense checks on an HL7 v2 message — free, offline, dataset-fed rules that flag clinically implausible content in a structurally-valid message (a 10x dose, a sex-conflicting procedure, a specimen/test mismatch) that spec validation cannot see. Advisory only: findings never change whether a message is valid. The middle rung of the triage ladder — deterministic clinical rules, above explain_error (spec/structure findings) and below semantic_review (the on-device LLM judge); use those for spec errors and LLM-judged plausibility respectively, not clinical_check.

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "The raw HL7 v2 message to run the deterministic clinical checks over. Paste the pipe-delimited message."
    }
  },
  "required": [
    "message"
  ],
  "additionalProperties": false
}
```

### `describe_tool`

Return the full contract for any Pidgeon tool by name: its description, input schema, output-envelope keys, the typed error codes it can return (per its tier), and the guided prompts that chain it. The protocol-native way to fetch a tool's complete spec on demand — works in any MCP client, with no reliance on client-side tool search. Omit `name` to list every tool. Free and uncapped; describes Pro tools without unlocking them. Read pidgeon://version first for the roster of names.

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "name": {
      "type": "string",
      "description": "Tool name to describe, e.g. 'generate_message'. Omit to list every tool name + tier."
    }
  },
  "additionalProperties": false
}
```

## Pro tools (9)

### `diff_messages`

Compare two HL7 or FHIR messages field by field. Shows which fields changed, classifies changes by severity (critical/major/minor/cosmetic), and identifies expected vs unexpected differences. Use for comparing DEV vs UAT, pre-upgrade vs post-upgrade, or validating message transformation correctness.

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "leftMessage": {
      "type": "string",
      "description": "The baseline message (left side). Paste the full HL7 or FHIR message."
    },
    "rightMessage": {
      "type": "string",
      "description": "The candidate message (right side). Paste the full HL7 or FHIR message."
    },
    "standard": {
      "type": "string",
      "enum": [
        "hl7",
        "fhir"
      ],
      "description": "Message standard. Auto-detected if not specified."
    },
    "ignoredFields": {
      "type": "string",
      "description": "Comma-separated field paths to ignore (e.g., 'MSH.7,PID.3'). Use to suppress expected differences like timestamps or control IDs."
    }
  },
  "required": [
    "leftMessage",
    "rightMessage"
  ],
  "additionalProperties": false
}
```

**Output envelope** (H-16): appends `ok: true` + the keys below via `withSuccessEnvelope`; shaped to feed `explain_error`.

| Key | Contract |
|---|---|
| `identical` | true when the two messages have no differences. |
| `differenceCount` | Number of field-level differences found. |
| `differences` | Each difference { path, leftValue, rightValue, severity, description } — the fields that changed, classified critical/major/minor/cosmetic. |

### `analyze_vendor_pattern`

Analyze sample HL7 messages to detect vendor-specific patterns (field population frequency, ID formats, Z-segments, encoding conventions). Produces a vendor profile that can be used for targeted validation and generation. Feed 3-5 sample messages for accurate detection.

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "messages": {
      "type": "string",
      "description": "Multiple HL7 sample messages separated by blank lines. Feed 3-5 messages from the same vendor for accurate pattern detection."
    },
    "vendorName": {
      "type": "string",
      "description": "Optional vendor name hint (e.g., 'epic', 'cerner', 'meditech'). If omitted, the vendor is auto-detected from message patterns."
    }
  },
  "required": [
    "messages"
  ],
  "additionalProperties": false
}
```

### `run_workflow`

Execute a multi-step clinical scenario (e.g., admission-with-labs: Admit -> Lab Order -> Lab Result) as one coherent patient cohort. Returns the sequence of HL7 messages, all sharing one patient's demographics and identifiers across steps. Use for testing complete clinical pathways, not just individual message types. For a single standalone message use generate_message instead, not run_workflow. Each run generates a fresh patient cohort. Optionally apply a vendor's compliance rules to every message.

**Annotations** (H-15): `{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "scenario": {
      "type": "string",
      "description": "Built-in scenario name (e.g., 'admission-with-labs', 'sepsis-cohort'). If the name is not recognized, the error lists the available scenarios. Defines the sequence of clinical steps to generate as one coherent patient cohort."
    },
    "vendor": {
      "type": "string",
      "description": "Apply vendor-specific patterns to all generated messages (e.g., 'epic', 'cerner')."
    },
    "count": {
      "type": "integer",
      "minimum": 1,
      "maximum": 50,
      "default": 1,
      "description": "Number of times to repeat the scenario with different patient data."
    }
  },
  "required": [
    "scenario"
  ],
  "additionalProperties": false
}
```

**Output envelope** (H-16): appends `ok: true` + the keys below via `withSuccessEnvelope`; shaped to feed `validate_message`, `send_message`.

| Key | Contract |
|---|---|
| `stepCount` | Number of clinical steps generated. |
| `steps` | The ordered steps, each { name, messageType, message } — feed a step's message into validate_message / send_message. |

### `send_message`

Send an HL7 message to an SFTP destination or local file path. Use for delivering test messages to Mirth pickup folders, SFTP endpoints, or local directories during go-live testing. Returns confirmation of delivery or error details. Pass an `idempotencyKey` to make retries safe — a repeat with the same key replays the recorded delivery instead of re-sending.

**Annotations** (H-15): `{"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true}`

```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "The HL7 message to send. Paste the full pipe-delimited message."
    },
    "destination": {
      "type": "string",
      "description": "Delivery destination. Supports SFTP URIs (e.g., 'sftp://user@host/path') and local file paths (e.g., '/path/to/mirth/pickup')."
    },
    "filename": {
      "type": "string",
      "description": "Optional filename for the delivered message. If omitted, a timestamped filename is generated automatically."
    },
    "idempotencyKey": {
      "type": "string",
      "description": "Optional idempotency key. Safe to retry a send with the same key after an ambiguous failure: the same delivery will not be repeated — the recorded outcome is returned instead (Bridge mode)."
    }
  },
  "required": [
    "message",
    "destination"
  ],
  "additionalProperties": false
}
```

### `loft_status`

Check the health status of monitored healthcare interfaces via Pidgeon Loft. Shows per-interface message counts, error rates, and alerts. Use to check interface health from your AI editor without switching to a dashboard.

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "since": {
      "type": "string",
      "description": "Time window for status data (e.g., '24h', '1h', '7d'). Defaults to the last 24 hours if not specified."
    },
    "path": {
      "type": "string",
      "description": "Monitored directory path to filter status for a specific interface."
    }
  },
  "additionalProperties": false
}
```

**Output envelope** (H-16): appends `ok: true` + the keys below via `withSuccessEnvelope`; the journey's terminal artifact — read by the coordinating agent (H-26), not fed to another tool.

| Key | Contract |
|---|---|
| `interfaceCount` | Number of monitored interfaces reported. |
| `interfaces` | Per-interface health rows: name, status, messageCount, errorRate — no message content (H-33). |
| `health` | Roll-up counts by status, e.g. {"healthy": 1, "warning": 1}. |
| `summary` | Human summary line for the watch window. |

### `generate_population`

Start generating a synthetic patient population with Pidgeon Flock. Produces epidemiologically grounded patient records with realistic demographics, diagnoses, medications, and lab values for a given geography. In Bridge mode this starts an async job and returns a job id — starting is the only mutation, so a lost start is safe to re-issue; poll it with population_status (polling is idempotent) until it completes. Schema-aware (FK-safe DDL) generation runs via the CLI: pidgeon flock generate --schema <ddl-file>.

**Annotations** (H-15): `{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "population": {
      "type": "integer",
      "minimum": 1,
      "maximum": 10000,
      "description": "Number of patients to generate (1-10,000)."
    },
    "location": {
      "type": "string",
      "description": "Geographic location for epidemiological grounding (e.g., 'MS' for Mississippi, 'IL' for Illinois). Affects disease prevalence, demographics, and lab value distributions."
    },
    "format": {
      "type": "string",
      "enum": [
        "sql",
        "csv",
        "hl7",
        "fhir"
      ],
      "default": "csv",
      "description": "Output format: sql (INSERT statements), csv, hl7 (message stream), or fhir (Bundle)."
    },
    "seed": {
      "type": "integer",
      "description": "Random seed for reproducible population output."
    }
  },
  "required": [
    "population"
  ],
  "additionalProperties": false
}
```

**Output envelope** (H-16): appends `ok: true` + the keys below via `withSuccessEnvelope`; shaped to feed `population_status`.

| Key | Contract |
|---|---|
| `jobId` | Async Flock job id (Bridge mode) — feed straight into population_status to poll progress and reach the download ref. |
| `population` | Patients requested, echoed back. |
| `format` | Output format requested (sql | csv | hl7 | fhir). |
| `patientCount` | Patients generated inline (CLI/synchronous mode, where there is no job to poll). |
| `output` | Where the completed population was written (synchronous mode). |

### `population_status`

Check the progress of a Flock population job started by generate_population. Returns job status, generated count, and percent complete. Safe to poll: reading status never changes the job. Bridge mode only (the CLI generates populations synchronously, so there is no job to poll).

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "jobId": {
      "type": "string",
      "description": "The population job id returned by generate_population."
    }
  },
  "required": [
    "jobId"
  ],
  "additionalProperties": false
}
```

**Output envelope** (H-16): appends `ok: true` + the keys below via `withSuccessEnvelope`; shaped to feed `population_status`.

| Key | Contract |
|---|---|
| `jobId` | The job id polled, echoed back — feed it into the next population_status poll while status is not completed. |
| `status` | Job status (running | completed | failed). |
| `progressPercent` | Whole-percent progress (0-100). |
| `generatedCount` | Patients generated so far. |
| `totalCount` | Patients requested for the job. |
| `ready` | True once the population is complete and downloadable. |
| `downloadRef` | Bridge path to export the finished population (present when ready): GET /api/flock/generate/{id}/download. |
| `error` | Failure reason when status is failed (absent otherwise). |

### `refine_hl7_segment`

Apply a natural-language instruction to one HL7 segment in place, then validate and self-heal the result against the standard (and a vendor profile if given). Returns the refined message plus whether self-healing reached full compliance. Runs a bounded server-side self-heal loop (surfaced as retryCount) and does not persist changes — safe to call again.

**Annotations** (H-15): `{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":false}`

```json
{
  "type": "object",
  "properties": {
    "originalMessage": {
      "type": "string",
      "description": "The full original HL7 message."
    },
    "segmentIndex": {
      "type": "integer",
      "description": "The 0-based index of the target segment within the message."
    },
    "segmentContent": {
      "type": "string",
      "description": "The exact text of the segment to refine (e.g. 'OBX|1|NM|...')."
    },
    "prompt": {
      "type": "string",
      "description": "The refinement instruction (e.g., 'Change lab value to 22.4')."
    },
    "profile": {
      "type": "string",
      "description": "Apply a vendor profile (e.g. 'epic') for strict conformance during self-healing."
    }
  },
  "required": [
    "originalMessage",
    "segmentIndex",
    "segmentContent",
    "prompt"
  ],
  "additionalProperties": false
}
```

### `conform`

Probe a live FHIR endpoint for IG conformance (US Core, Da Vinci PAS/CRD/DTR) and return a pass/fail scorecard graded against the published spec — the CMS-0057-F readiness check. Probe one resource (`resource` + `profile`) or walk the whole endpoint (`walk: true`). Use `ci: true` to treat must-support gaps as hard failures.

**Annotations** (H-15): `{"readOnlyHint":true,"openWorldHint":true}`

```json
{
  "type": "object",
  "properties": {
    "endpoint": {
      "type": "string",
      "description": "FHIR base URL, e.g. https://api.payer.example/fhir."
    },
    "resource": {
      "type": "string",
      "description": "Single-probe target 'ResourceType/id' (e.g. Patient/example). Required unless `walk` is true."
    },
    "profile": {
      "type": "string",
      "description": "IG profile short name (e.g. us-core-patient) or canonical URL. Required unless `walk` is true."
    },
    "walk": {
      "type": "boolean",
      "description": "Walk every resource×profile in the endpoint's CapabilityStatement instead of one probe."
    },
    "ig": {
      "type": "string",
      "description": "Walk only: restrict to this IG base URL, e.g. http://hl7.org/fhir/us/core/."
    },
    "onlyResources": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Walk only: limit to these resource types, e.g. ['Patient','Coverage']."
    },
    "auth": {
      "type": "string",
      "description": "Bearer token for an authenticated endpoint. Omit for staging."
    },
    "ci": {
      "type": "boolean",
      "description": "CI mode: must-support gaps count as failures (CMS-0057-F audit policy)."
    }
  },
  "required": [
    "endpoint"
  ],
  "additionalProperties": false
}
```

**Output envelope** (H-16): appends `ok: true` + the keys below via `withSuccessEnvelope`; shaped to feed `explain_error`.

| Key | Contract |
|---|---|
| `passed` | true when the endpoint passed the profile (CI gate exit 0). |
| `mode` | 'single' for one resource×profile probe, 'walk' for a full-endpoint walk. |
| `endpoint` | The FHIR base URL that was probed. |
| `findings` | Conformance issues, each { ruleId, location, message, severity } — feed verbatim to explain_error.findings. |

## Prompts (6)

- **debug_hl7_error** — Walk through debugging an HL7 validation failure step by step. Validates the message, explains each error in plain English, identifies the root cause, and suggests a corrected version.
  - Chains: `validate_message` → `explain_error` → `generate_message`
  - Entitlement: Fully free — validate, explain each error, and generate a corrected example need no subscription.
- **go_live_prep** — Help prepare for an interface go-live with a specific vendor. Generates test messages matching the vendor's patterns, validates them, and produces a testing checklist.
  - Chains: `generate_message` → `validate_message`
  - Entitlement: Generate + validate are free; production-volume go-live suites are bounded by the free-tier volume cap, and vendor-profile persistence (analyze_vendor_pattern) is Pro.
- **onboard_vendor_interface** — Analyze sample messages from a new vendor interface and build a vendor profile. Identifies the vendor, extracts field patterns, and creates a reusable configuration.
  - Chains: `generate_message` → `validate_message`
  - Entitlement: Generating and validating sample traffic is free; saving and reusing the inferred vendor profile (analyze_vendor_pattern) is Pro.
- **stand_up_interface** — Stand up a conformant test interface end-to-end: generate vendor-shaped messages, validate them, prove the FHIR side passes CMS-0057-F conformance, and deliver them to the pickup folder.
  - Chains: `generate_message` → `validate_message` → `conform` → `refine_hl7_segment` → `send_message`
  - Entitlement: Generate + validate are free; the conform gate (CMS-0057-F), in-place refine, and delivery (send) are Pro.
- **reproduce_and_fix** — Reproduce, diagnose, and fix a rejected message: explain it, find the violations, triage each with a suggested fix, apply the fix in place, re-validate until clean, and produce a re-sendable version.
  - Chains: `explain_message` → `validate_message` → `explain_error` → `refine_hl7_segment` → `diff_messages` → `send_message`
  - Entitlement: The full diagnosis — explain, validate, and triage each finding — is free; the fix-and-deliver steps (refine, diff, re-send) are Pro. A free agent loop still gets the complete diagnosis, never a hard stop.
- **seed_validate_monitor** — Seed a UAT environment with a realistic, FK-safe synthetic cohort, prove every generated message validates, and start watching the interface they flow through — Flock → Post → Loft in one job.
  - Chains: `generate_population` → `run_workflow` → `validate_message` → `loft_status`
  - Entitlement: Batch validation is free; population seeding (Flock) and live-interface monitoring (Loft) are Pro.

## Resources (6)

- `pidgeon://hl7/segments` — Complete list of all HL7 v2 segment types with descriptions. Includes all 110 segments from v2.3 through v2.8.
- `pidgeon://hl7/segments/{segmentCode}` — Full field-by-field specification for a specific HL7 segment.
- `pidgeon://vendors` — Vendor interface profiles — a workspace fact. When the Bridge is running, this reads the loaded interface profiles (with 'which substrate answered' provenance and a staleness note); otherwise it falls back to this server's embedded common-vendor catalog. Use a vendor name with generate_message (vendor flag) to produce vendor-specific test messages.
- `pidgeon://version` — Machine-readable self-description: server version, transport mode, resolved tier, the full tool roster with per-tool tier, free-tier volume state, and the prompt/resource catalog. An agent reads this once to learn what Pidgeon can do, at what tier, in what state.
- `pidgeon://setup-guide` — Setup and troubleshooting guide for the Pidgeon MCP server. Covers installation, mode selection, environment variables, and common issues.
- `pidgeon://session` — The durable, server-held context an agent shares with the human at the workbench: the active organization/facility scope, the user's saved field-pin sessions, and the on-device AI model status. Bridge-mode only — live in-pane state (current message, version, vendor) is client-held and not read here. One surface, two drivers: read this to orient before acting.

