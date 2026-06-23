# ADR 002: Artifact Payload Schema

## Status
Accepted.

## Decision
Model artifacts as stable records with append-only versions, with MIME-aware payload handling.

## Context
Artifacts need to support markdown, plain text, code, and structured JSON in Phase 1, while leaving room for future bundles and interactive views.

## Options Considered
- Store artifact text directly in message rows.
- Store only opaque file paths.
- Store a stable artifact record plus version history and external payload references when needed.

## Consequences
- Version history stays inspectable and reversible.
- Large payloads can move to managed files without changing the core object model.
- UI rendering stays tied to content type instead of raw provider output.
