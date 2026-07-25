# Security Policy

The Pidgeon Health team takes security seriously. This document explains how to report a
suspected vulnerability and what to expect when you do.

## Reporting a vulnerability

**Do not open a public issue for security reports.** Public issues let attackers learn about
the vulnerability before it is fixed.

Two private channels:

1. **Preferred — GitHub Security Advisory.** Open a private advisory from this repository's
   **Security → Advisories** tab. This creates an encrypted, audited channel and lets us
   collaborate on a fix without early disclosure.
2. **Email.** `security@pidgeon.health`. Encrypt with our PGP key (fingerprint published at
   <https://pidgeon.health/.well-known/pgp-key.asc>) if you can; unencrypted reports are also
   accepted.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept, exact request, or a sample message that triggers it).
- The component affected (CLI, engine, MCP server, or a desktop app), the version or commit,
  and the OS/runtime if relevant.
- Whether the vulnerability is already public elsewhere (CVE, blog post, social, etc.).

## Scope

In scope:

- The code in this repository.
- Data handling: how the software transmits, stores, or logs information that originates from
  a user.

Out of scope:

- Third-party dependencies. Report to the upstream project; we incorporate their fix once
  available.
- Issues that require physical access to a user's device.
- Spam, social engineering, or phishing reports.
- Self-XSS, CSRF on logout, missing security headers without a demonstrable impact, and other
  low-impact issues that do not translate into a real attack.

## Response

We aim to acknowledge a report within **2 business days**, provide an initial assessment
(severity, scope, projected fix timeline) within **5 business days**, and ship a fix for
high-severity issues within **30 days** of confirmation (lower-severity within **90 days**).
Pidgeon is a small team; we will keep you informed if anything slips.

## Coordinated disclosure

We follow coordinated disclosure: please give us a reasonable window to ship a fix before
publishing details. We are happy to credit reporters in the resulting advisory unless you
prefer to stay anonymous. We do not currently run a paid bug bounty program.

## Healthcare-data note

Pidgeon's community tools generate **synthetic data** — they do not process real PHI, and the
community engine runs locally with no cloud message-content egress. If your report involves a
way for local data to escape a user's machine, treat it as **critical** and we will too.
