# Pidgeon MCP server

An [MCP](https://modelcontextprotocol.io) server that exposes Pidgeon's healthcare-data tools
to any MCP-compatible AI client — generate, validate, explain, and analyze HL7 v2, FHIR R4,
and NCPDP messages from your agent.

## What it does

The server surfaces the community Pidgeon tools over MCP:

- **Generate** synthetic HL7 v2 and FHIR R4 messages and resources.
- **Validate** messages against published standard definitions.
- **Explain** and **look up** standard reference data (segments, fields, tables).

Validation is derived from the standards' published, machine-readable definitions. Message
content stays on the local machine; the free tool loop runs without an account.

## Install

```bash
npm install -g @pidgeonhealth/pidgeon-mcp@0.1.0-beta.1
PIDGEON_MODE=cli pidgeon-mcp --list-tools
```

CLI mode requires the public `pidgeon` .NET tool and exposes only the checked-in community
tool catalog. Authenticated Bridge mode exposes only capabilities advertised by the Bridge.
Client-side tier labels never materialize a paid or private capability.

## Build from source

Requires Node.js 22 LTS.

```bash
npm install
npm run build
npm test
```

## License

Pidgeon's community engine and baseline data package are licensed under the Mozilla Public
License 2.0 (see `LICENSE`). Third-party and standards acknowledgments are in `NOTICE`. HL7®
and FHIR® are registered trademarks of Health Level Seven International; their use here is
descriptive and does not constitute endorsement by HL7.

## Contributing & security

Contributions are welcome under the Developer Certificate of Origin — see
[`CONTRIBUTING.md`](CONTRIBUTING.md). To report a vulnerability, see [`SECURITY.md`](SECURITY.md).
