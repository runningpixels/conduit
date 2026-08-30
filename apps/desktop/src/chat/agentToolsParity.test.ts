/**
 * TS/Rust builtin tool parity guards.
 *
 * `agentTools.ts`'s `builtinToolDefinitions()` is a hand-maintained TS mirror
 * of Rust tool metadata — nothing generates one from the other, so nothing
 * stops the two from drifting apart one edit at a time.
 *
 * ## The guard that matters: TS is a subset of Rust's dispatch
 *
 * The list the model actually receives is built on the TS side
 * (`ChatView.tsx`'s `selectBuiltinDocumentTools`/`selectBuiltinBrandTools`,
 * both sourced from `builtinToolDefinitions()`), and the real execution
 * authority is the `match tool_name { ... }` dispatch inside
 * `execute_builtin_tool` (`src-tauri/src/agent_tools.rs`) — every arm there
 * is a tool Rust can actually run; the wildcard arm
 * (`_ => Err("Unknown builtin tool: ...")`) is what happens to everything
 * else.
 *
 * `builtin_tool_definitions()` (the Rust function with the same name and
 * shape as the TS one) is NOT that authority: as of this writing it has no
 * production caller — it is referenced only from `#[cfg(test)]` code in the
 * same file. So the direction that actually protects a user from a failed
 * tool call is: every tool TS can advertise to the model must have a
 * dispatch arm in `execute_builtin_tool`. The reverse (Rust dispatches
 * something TS never advertises) is dead code, not a user-facing failure —
 * worth noticing, not worth failing a build over.
 *
 * This also needs no "pending Rust" allowlist: a Rust agent lands a new
 * tool's definition and its dispatch arm together (as it did for
 * `write_brand_theme`), so this direction can be asserted with zero slack.
 *
 * ## The secondary guard: definition metadata, as documentation only
 *
 * `builtin_tool_definitions()` is still useful as a second, independent
 * description of each tool's permission level and display group (it is what
 * `#[cfg(test)]` exercises on the Rust side). Checking TS against it catches
 * a copy-paste slip in a permission level or display group — a UX/trust
 * inconsistency, not a broken tool call — so it stays here as a consistency
 * nicety, clearly separate from the dispatch check above.
 *
 * Both are scanned as text against the Rust source, for the same reason
 * G6/G8/G9 do it (see `brandLiterals.test.ts`'s module comment): there is no
 * shared schema between the two languages here, so the only way to see drift
 * is to look at both sources directly.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { builtinToolDefinitions } from './agentTools';

const here = dirname(fileURLToPath(import.meta.url));
const rustFile = join(here, '..', '..', 'src-tauri', 'src', 'agent_tools.rs');

const RUST_TO_TS_PERMISSION: Record<string, string> = {
  ReadOnly: 'readOnly',
  SideEffectful: 'sideEffectful',
  Sensitive: 'sensitive',
};

function parseConstMap(src: string): Map<string, string> {
  const constMap = new Map<string, string>();
  for (const m of src.matchAll(/pub const (\w+): &str = "([^"]+)";/g)) {
    constMap.set(m[1], m[2]);
  }
  return constMap;
}

/**
 * Every tool name with a dispatch arm in `execute_builtin_tool`'s
 * `match tool_name { ... }` — the actual execution authority (see module
 * comment). Extracted as "every `IDENT =>` between the match's opening and
 * its `_ => Err("Unknown builtin tool ...")` wildcard arm, resolved through
 * `constMap`" rather than a full Rust parse: nested arms inside a tool's own
 * body (`Ok(text) =>`, `Err(e) =>`, `CLIPBOARD_READ_TOOL => match
 * clipboard_read().await { ... }`) use identifiers that are never registered
 * in `constMap`, so they resolve to `undefined` and are dropped — only the
 * top-level `SOME_TOOL_CONST =>` arms survive.
 */
function parseDispatchedTools(src: string, constMap: Map<string, string>): Set<string> {
  const matchStart = src.indexOf('let result = match tool_name {');
  if (matchStart === -1) return new Set();
  const wildcardMarker = 'Err(format!("Unknown builtin tool';
  const wildcardIndex = src.indexOf(wildcardMarker, matchStart);
  const region = wildcardIndex === -1 ? src.slice(matchStart) : src.slice(matchStart, wildcardIndex);

  const dispatched = new Set<string>();
  for (const m of region.matchAll(/\b(\w+)\s*=>/g)) {
    const name = constMap.get(m[1]);
    if (name) dispatched.add(name);
  }
  return dispatched;
}

interface RustDefinition {
  name: string;
  permission?: string;
  group?: string;
}

/**
 * Every `ToolDefinition { ... }` literal from `builtin_tool_definitions()` —
 * metadata only, NOT the execution authority (see module comment). Same
 * split-and-cut text heuristic as before: split on the opening brace, cut at
 * the trailing `host_config: None,` every existing entry ends with.
 */
function parseRustDefinitions(src: string, constMap: Map<string, string>): RustDefinition[] {
  const blocks = src.split('ToolDefinition {').slice(1).map((chunk) => {
    const end = chunk.indexOf('host_config: None,');
    return end === -1 ? chunk : chunk.slice(0, end);
  });

  const defs: RustDefinition[] = [];
  for (const block of blocks) {
    const nameMatch = block.match(/\bname:\s*(?:(\w+)\.to_string\(\)|"([^"]+)"\.to_string\(\))/);
    if (!nameMatch) continue;
    const name = nameMatch[2] ?? constMap.get(nameMatch[1]);
    if (!name) continue;

    const permMatch = block.match(/permission_level:\s*Some\(PermissionLevel::(\w+)\)/);
    const groupMatch = block.match(/display_group:\s*Some\("([^"]+)"\.to_string\(\)\)/);

    defs.push({
      name,
      permission: permMatch?.[1],
      group: groupMatch?.[1],
    });
  }
  return defs;
}

describe('TS builtin tools stay executable: every TS tool has a Rust dispatch arm', () => {
  const rustSrc = readFileSync(rustFile, 'utf8');
  const constMap = parseConstMap(rustSrc);
  const dispatched = parseDispatchedTools(rustSrc, constMap);
  const tsNames = builtinToolDefinitions().map((t) => t.name);

  it('found at least one dispatched tool (the parser did not silently break)', () => {
    expect(dispatched.size).toBeGreaterThan(0);
  });

  it('every tool TS can advertise to the model has a matching arm in execute_builtin_tool', () => {
    // This is the direction that protects a user: TS tells the model a tool
    // exists, the model calls it, and Rust's `match tool_name` has nowhere to
    // route it -- the call fails with "Unknown builtin tool". The reverse
    // (Rust dispatches something TS never advertises) is unreachable dead
    // code, not a user-facing failure, so it is deliberately not asserted
    // here.
    const undispatched = tsNames.filter((name) => !dispatched.has(name));
    expect(
      undispatched,
      `TS advertises tool(s) with no dispatch arm in execute_builtin_tool -- the model could call ` +
        `these and get "Unknown builtin tool": ${undispatched.join(', ')}`,
    ).toEqual([]);
  });
});

describe('TS builtin tool definitions match Rust definition metadata (consistency nicety, not an execution guard)', () => {
  const rustSrc = readFileSync(rustFile, 'utf8');
  const constMap = parseConstMap(rustSrc);
  const rustDefs = parseRustDefinitions(rustSrc, constMap);
  const tsTools = new Map(builtinToolDefinitions().map((t) => [t.name, t]));

  it('found at least one Rust tool definition (the parser did not silently break)', () => {
    expect(rustDefs.length).toBeGreaterThan(0);
  });

  it('every Rust-defined tool has a same-named TS definition with the same permission level and display group', () => {
    // `builtin_tool_definitions()` has no production caller (see module
    // comment) -- a mismatch here is a copy-paste slip in a permission level
    // or display group, not a broken tool call. Kept as a separate, weaker
    // assertion so it is never confused with the dispatch guard above.
    const mismatched: string[] = [];
    for (const rustDef of rustDefs) {
      const tsTool = tsTools.get(rustDef.name);
      if (!tsTool) {
        mismatched.push(`${rustDef.name}: Rust defines it, TS has no definition at all`);
        continue;
      }
      if (rustDef.permission) {
        const expected = RUST_TO_TS_PERMISSION[rustDef.permission] ?? rustDef.permission;
        if (tsTool.permissionLevel !== expected) {
          mismatched.push(
            `${rustDef.name}: permissionLevel is '${tsTool.permissionLevel}', Rust says '${expected}'`,
          );
        }
      }
      if (rustDef.group && tsTool.displayGroup !== rustDef.group) {
        mismatched.push(`${rustDef.name}: displayGroup is '${tsTool.displayGroup}', Rust says '${rustDef.group}'`);
      }
    }

    expect(mismatched, `TS/Rust definition mismatch(es):\n  ${mismatched.join('\n  ')}`).toEqual([]);
  });
});
