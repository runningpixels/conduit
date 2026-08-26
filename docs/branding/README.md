# Branding Conduit

Conduit's whole visual surface is driven by ~18 named colours plus a name and
a logo, described in one file: `brand.md`. Everything in this directory
exists to answer two different questions people ask about that file:

- **"What would this look like as ours?"** — that's **Mode A**, below.
- **"This *is* ours, and we're shipping it to other people."** — that's
  **Mode B**, and it needs [`SHIPPING.md`](./SHIPPING.md).

Read the next section before doing anything else. Picking the wrong mode is
the single most common way to waste an afternoon on this feature — usually by
starting a full packaged rebrand (toolchain, icon regeneration, your own
updater infrastructure) when a five-minute change in Settings would have
answered the question you actually had.

## Which one do you want?

| | **Mode A — demo brand** | **Mode B — ship brand** |
|---|---|---|
| Question it answers | "What would this look like as ours?" | "This *is* ours." |
| Applied | At runtime, in a stock Conduit build, from Settings → Branding | At build time, into your own installer |
| Who does it | Anyone — no toolchain required | Someone building from source, with a build pipeline |
| Reversible | Yes — one click, back to stock Conduit | No — it's a different binary, with its own updater and identity |
| Ships to third parties | No. It changes *your* copy of the app, not what you distribute | Yes — this is what a reseller/OEM hands to end users |
| Cost | Minutes | A build pipeline, your own update infrastructure, and a documented licensing position (see `SHIPPING.md`) |

Rule of thumb: if the honest answer to "am I going to give this build to
someone else" is no, you want Mode A, full stop. Mode B is strictly more
work and commits you to things Mode A does not — most importantly, running
your own updater infrastructure forever (see `SHIPPING.md` §2) and taking a
position on what the AGPL requires you to publish (`SHIPPING.md` §3). Don't
take on that cost to answer a question Mode A already answers.

### What each mode can and can't change

| | Mode A (runtime) | Mode B (build-time) |
|---|---|---|
| Product name, tagline, ~18 accent/surface colours | Yes | Yes |
| Logo shown inside the app | Yes | Yes |
| App icon, taskbar icon, installer name | No — impossible at runtime | Yes |
| Bundle identifier (`com.example.app`) | No | Yes |
| Custom fonts | No — blocked by the content security policy | Yes — bundled into the build |
| Update server and signing key | N/A — Mode A doesn't touch the updater | Yes — and it's mandatory, not optional (`SHIPPING.md` §2) |
| Native window title, taskbar text | Yes | Yes |

Neither mode can change the on-disk data directory's organisation name (still
`Conduit`, regardless of brand — see `SHIPPING.md` §1), the updater's
User-Agent string, or the identity Conduit sends to MCP connector servers.
Those are wire identity, not display identity — `SHIPPING.md` §5 explains why
they're excluded on purpose.

## One format, two consumers

Both modes read the same file, `brand.md`: TOML frontmatter (delimited by
`+++`) holding the actual settings, with a free-text Markdown body below it
for design notes — the part you'd hand back to an LLM when asking it to
revise the theme. The frontmatter is normative; the body is documentation
only. The full commented, working starting point is
[`brand.template.md`](./brand.template.md) in this directory — copy it, edit
it, or hand the whole file to an LLM and describe a vibe.

The file is tiered:

- The **core profile** (`[identity]`, `[logo]`, `[palette.dark]`,
  `[palette.light]`) is honoured by both modes.
- The **build profile** (`[fonts]`, `[bundle]`, `[updater]`, `[runtime]`) is
  read but *ignored* by Mode A — surfaced in Settings as "this key only
  takes effect in a packaged build," never as an error — and is what a Mode B
  build consumes.

That split exists because Mode A's limits (no filesystem-backed fonts, no
icon regeneration, no installer metadata) are artifacts of running inside a
stock, already-built app, not limits on what a brand can express. Writing the
same `brand.md` covers both without maintaining two files that can drift
apart.

## Using Mode A

Open **Settings → Branding** in the app. It has a name field, a tagline
field, a logo drop-zone, and swatches for the ~18 core-profile colours, plus
Import / Export / Reset. Anything you set applies live, with a revert
control — you're looking at the real app repainting itself, not a preview.
Build-profile fields (fonts, bundle, updater, runtime) appear read-only with
a note that they only take effect in a packaged build.

Under the hood this reads and writes `brand.md` (plus `logo.<ext>`) in the
app's own data directory — the same format `Import` accepts and `Export`
produces, so a file built this way is already a valid starting point for a
Mode B build later.

## Using Mode B

You're building your own installer to hand to other people. Read
[`SHIPPING.md`](./SHIPPING.md) in full before you start — it covers what
changes, why the updater section is mandatory rather than optional, what the
AGPL requires of a rebranded distribution, and the checklist that catches
the mistakes that are expensive to find after you've shipped (an installer
that quietly points at Conduit's update server is the worst one).
