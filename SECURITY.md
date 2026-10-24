# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 4.0.x | Yes |
| < 4.0 | No |

## Reporting a vulnerability

Report privately through GitHub's
[security advisory form](https://github.com/daemon-summoner/InstantCognition/security/advisories/new).
Do not open a public issue for a vulnerability.

Include what an attacker can do, the steps to reproduce it, the affected version
and platform, and anything you know about the scope. Expect an acknowledgement
within a week. Fixes ship in the next release; a report that turns out to be a
non-issue gets an explanation of why.

## What is in scope

InstantCognition renders untrusted web content and runs a tool-calling agent
over it, so the interesting boundaries are:

- Escaping the `<webview>` sandbox, or reaching main-process privileges from page content
- Bypassing the agent approval gate or its domain allow/block list
- Bypassing the HTTP allowlist that constrains outbound agent requests
- Reading another space's session, cookies or storage
- Extension installation paths (`.crx`, `.zip`, unpacked directories)
- Local file access through project uploads or agent tools
- Credential exposure: API keys are stored in `config.json` under the user data directory

## Out of scope

- The behaviour of third-party AI services loaded as spaces
- Vulnerabilities in a locally installed `llama-server` or MLX runtime that the app only launches
- Attacks requiring an already-compromised local account
- Unsigned binaries triggering Gatekeeper or SmartScreen warnings (known, documented in the README)

## Handling your own data

Settings, including any API keys you enter, are stored in plaintext in
`config.json` in the app's user data directory. Treat that file as a secret and
do not share it or attach it to an issue.
