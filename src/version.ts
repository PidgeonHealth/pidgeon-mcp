// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The single source of truth for this package's version.
 *
 * Read from package.json at RUNTIME via `require` rather than a static `import`:
 * tsconfig sets `rootDir: ./src`, so importing `../package.json` would place a
 * file outside the root and break the emit. `dist/version.js` resolves
 * `../package.json` to the package root, which is present in both the repo and
 * the published tarball (`files: ["dist", "README.md", "LICENSE"]` ships
 * package.json implicitly).
 *
 * Before this existed the version was hardcoded in two places (`server.ts`'s
 * `McpServer` handshake and the `system` resource) and tracked nothing. A
 * published 0.2.0 announced itself to every MCP client as 0.1.1.
 */
const pkg = require("../package.json") as { version: string };

export const PKG_VERSION: string = pkg.version;
