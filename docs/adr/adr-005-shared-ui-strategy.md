# ADR 005: Shared UI Strategy

## Status
Accepted.

## Decision
Share design tokens and low-level UI primitives between desktop and admin surfaces, while keeping runtime/API behavior separate.

## Context
The roadmap wants a desktop shell now and an admin console later. Those surfaces should look related without forcing them into the same runtime.

## Options Considered
- Duplicate all UI code per app.
- Build one web app and retrofit desktop behavior later.
- Share tokens and primitives through a focused UI package.

## Consequences
- The desktop shell can start with a neutral design system.
- Later admin work can reuse the same tokens without sharing trust-boundary code.
- White-label styling stays a runtime concern, not a forked product architecture.
