# Security Policy

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues, pull requests,
or discussions.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/tobiaz/conduit/security/advisories/new)
on this repository. That channel is visible only to the maintainer and lets us
coordinate a fix and an advisory.

Please include:

- What the issue is and why it is a security problem
- Steps to reproduce, ideally minimal
- Affected version or commit, and your OS
- Any proof-of-concept you have

**Do not include real API keys or personal data in a report.** If a credential
of yours was exposed while finding the issue, rotate it immediately.

### What to expect

- Acknowledgement within **7 days**
- An assessment and a plan within **14 days**
- Credit in the advisory and release notes, unless you prefer otherwise

Conduit is a single-maintainer project with no security budget. There is no bug
bounty. Response times are best-effort, and I would rather set a modest
expectation and meet it.

## Supported versions

Conduit has not yet cut a tagged release. Until v1.0, **only the latest commit
on `main` is supported**; fixes land there and are not backported.

## What is in scope

The security model is documented in
[`docs/architecture/foundation-contracts.md`](./docs/architecture/foundation-contracts.md)
and the ADRs. Reports that are especially valuable:

- Any path by which the **renderer obtains an API key** or makes a direct
  network call. The renderer is untrusted-by-design; a break here is the most
  serious class of bug in this codebase.
- **Artifact sandbox escapes** — model-generated HTML reaching the parent DOM,
  the Tauri IPC bridge, the filesystem, or the network. See
  [`docs/adr/adr-007-artifact-rendering-security.md`](./docs/adr/adr-007-artifact-rendering-security.md).
- **Prompt-injection paths that cross a trust boundary** — for example MCP tool
  output being re-injected into a prompt, or connector output escaping
  redaction.
- **Credential handling** — secrets written to disk, logs, diagnostics exports,
  or crash dumps. Diagnostics exports are meant to be redacted; a leak there is
  in scope.
- **Encryption-at-rest failures** — silent downgrade to plaintext, key reuse,
  nonce reuse, or data readable without the keychain-wrapped master key.
- **Consent bypass** — a side-effecting MCP tool executing without approval.
- **Update integrity** — anything that lets an unsigned or downgraded payload
  install.

## Known limitations

These are documented trade-offs, not vulnerabilities. Reports about them will be
closed as known:

- **Bundles are not OS-code-signed.** Windows SmartScreen and macOS Gatekeeper
  will warn on first run. Updater payloads *are* Ed25519-signature-verified.
- **A hostile artifact can hang its own iframe** or burn CPU. The sandbox is
  render-only with no liveness channel; the mitigation is closing the artifact.
- **Your provider sees your prompts.** Conduit is a client. Data sent to
  Anthropic, OpenAI, or any configured endpoint is governed by that provider's
  policy.
- **A local MCP connector is code you chose to run.** Connectors are supervised,
  consent-gated, and redacted, but a connector you install runs with your user's
  privileges.
- **Local disk encryption protects data at rest, not from your own account.**
  The master key lives in your OS keychain; malware running as you can reach it.
