// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { PidgeonTransport } from "../transport/types.js";

export interface ResourceDefinition {
  name: string;
  uri: string;
  description: string;
  mimeType: string;
  handler: (
    transport: PidgeonTransport,
    params: Record<string, string>
  ) => Promise<{
    contents: Array<{ uri: string; mimeType: string; text: string }>;
  }>;
}

const SETUP_GUIDE = `# Pidgeon MCP Server — Setup Guide

## Quick Start

### 1. Install Pidgeon CLI

\`\`\`bash
# Requires .NET 8 SDK (https://dotnet.microsoft.com/download/dotnet/8.0)
dotnet tool install --global Pidgeon.CLI --version 0.1.0-beta.1
\`\`\`

Verify: \`pidgeon --version\`

### 2. Choose a Mode

#### CLI Mode (simple, free tools)
Set in your MCP client config:
\`\`\`json
{
  "mcpServers": {
    "pidgeon": {
      "command": "npx",
      "args": ["@pidgeonhealth/pidgeon-mcp"],
      "env": {
        "PIDGEON_MODE": "cli"
      }
    }
  }
}
\`\`\`

Tools shell out to the \`pidgeon\` CLI. All free-tier tools work. Some Pro tools
(like diff) return limited results because they require in-memory processing.

#### Bridge Mode (full features, default)
\`\`\`json
{
  "mcpServers": {
    "pidgeon": {
      "command": "npx",
      "args": ["@pidgeonhealth/pidgeon-mcp"],
      "env": {
        "PIDGEON_MODE": "bridge",
        "PIDGEON_BRIDGE_URL": "http://localhost:5100"
      }
    }
  }
}
\`\`\`

The Bridge is a REST API that wraps all Pidgeon functionality. It enables Pro
tools, in-memory diff, workflow execution, and Loft monitoring.

**Starting the Bridge:** open a Pidgeon desktop app (Post, Flock, Loft, or
Migrate) — each runs the Bridge as its local sidecar on port 5100. The MCP
server connects to whichever Bridge is already running; it never starts one
itself.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| \`PIDGEON_MODE\` | \`bridge\` | Transport mode: \`bridge\` or \`cli\` |
| \`PIDGEON_BRIDGE_URL\` | \`http://localhost:5100\` | Bridge REST API URL |
| \`PIDGEON_CLI_PATH\` | \`pidgeon\` | Path to CLI executable |
| \`PIDGEON_API_KEY\` | (none) | API key for authenticated Bridge access |

## Troubleshooting

### "Pidgeon CLI not found"
- Install: \`dotnet tool install --global Pidgeon.CLI --version 0.1.0-beta.1\`
- Or set \`PIDGEON_CLI_PATH\` to the full path of the \`pidgeon\` executable
- Verify .NET 8 SDK is installed: \`dotnet --version\`

### "Bridge not reachable"
- Start a Pidgeon desktop app (Post, Flock, Loft, or Migrate) — it runs the Bridge
- Check the URL matches \`PIDGEON_BRIDGE_URL\` (default: http://localhost:5100)
- Or switch to CLI mode: set \`PIDGEON_MODE=cli\`

### "Pro required" messages
- Free tier includes: generate, validate, explain, lookup, segment-spec, deidentify, data-packages
- Pro tier adds: diff, analyze-vendor, workflow, send, loft-status, generate-population
- Upgrade at: https://pidgeon.health/upgrade

### Tool returns unexpected errors
- Run the \`pidgeon_status\` tool to diagnose environment issues
- Check that .NET 8 SDK, Pidgeon CLI, and (if using bridge mode) the Bridge are all available

## Tool Reference

### Free Tools (always available)
- **generate_message**: Generate synthetic HL7/FHIR/NCPDP messages
- **validate_message**: Validate messages against specifications
- **explain_message**: Parse and explain healthcare message contents
- **lookup_code**: Look up LOINC, ICD-10, NDC codes
- **get_segment_spec**: Get HL7 segment field specifications
- **deidentify_message**: Remove PHI from healthcare messages
- **manage_data_packages**: Install/manage clinical terminology datasets
- **pidgeon_status**: Check environment health and get setup help

### Pro Tools (require subscription + Bridge mode)
- **diff_messages**: Field-level message comparison
- **analyze_vendor_pattern**: Detect vendor-specific patterns
- **run_workflow**: Execute multi-step clinical scenarios
- **send_message**: Deliver messages to SFTP/local destinations
- **loft_status**: Monitor interface health
- **generate_population**: Generate synthetic patient populations
`;

export function createSetupGuideResource(): ResourceDefinition {
  return {
    name: "setup-guide",
    uri: "pidgeon://setup-guide",
    description:
      "Setup and troubleshooting guide for the Pidgeon MCP server. " +
      "Covers installation, mode selection, environment variables, and common issues.",
    mimeType: "text/markdown",
    handler: async (_transport, _params) => ({
      contents: [
        {
          uri: "pidgeon://setup-guide",
          mimeType: "text/markdown",
          text: SETUP_GUIDE,
        },
      ],
    }),
  };
}
