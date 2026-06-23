# ADR 004: Provider-Key Enrollment

## Status
Accepted.

## Decision
Support manual BYOK for the consumer shell and opaque, tenant-provisioned provider-key references for managed enrollments.

## Context
The desktop renderer must never receive long-lived secrets, but the product still needs a simple first-launch path and a tenant-managed provisioning path.

## Options Considered
- Store raw keys in renderer state.
- Require cloud login before every key lookup.
- Use Rust-owned keychain storage with opaque references in local persistence.

## Consequences
- Phase 1 can prove secret handling without exposing raw key material to React.
- Tenant enrollment can evolve later without changing the renderer contract.
- Settings UI remains simple because it only ever sees summaries and references.
