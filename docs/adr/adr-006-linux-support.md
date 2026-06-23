# ADR 006: Minimum Linux Support

## Status
Accepted.

## Decision
Treat Linux as supported for consumer and development usage, while keeping commercial signing and packaging expectations centered on macOS and Windows.

## Context
The product needs a practical local test surface, but the distribution burden is still concentrated on the platforms that need signing and notarization.

## Options Considered
- Make Linux a first-class commercial packaging target immediately.
- Exclude Linux entirely.
- Support Linux conservatively for local use and development while Phase 1 focuses on the desktop trust boundary.

## Consequences
- The core app must avoid platform assumptions that break on Linux.
- Packaging and release automation can stay focused on the commercial targets.
- Support expectations remain clear before auto-update and signing work begins.
