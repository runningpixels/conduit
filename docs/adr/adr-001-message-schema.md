# ADR 001: Message and Content-Block Schema

## Status
Accepted.

## Decision
Use a normalized, append-only message model with stable IDs and explicit content blocks.

## Context
Provider APIs disagree on how they represent chat turns, tool calls, reasoning content, and multimodal payloads. A single text blob would make streaming, interruptions, retries, and later persistence recovery fragile.

## Options Considered
- Single text field per message.
- Provider-specific raw payload storage.
- Normalized `Message` plus `MessagePart` records.

## Consequences
- The renderer can safely render partial assistant turns and tool-call placeholders.
- Persistence can recover interrupted or cancelled messages without inventing a provider-specific schema.
- Provider adapters stay isolated from UI and storage concerns.
