+++
# brand.md -- Conduit white-label starter template
#
# This is a real, working brand.md: every key below is what the app actually
# reads. Copy this file to <appDataLocal>/branding/brand.md (or import it
# from Settings -> Branding) and edit the values -- or hand this whole file
# to an LLM and ask it to build you a brand around a colour, a vibe, or a
# competitor's site.
#
# THE ONE GOTCHA THAT MATTERS: this is TOML frontmatter (delimited by the
# `+++` lines), and in TOML, `#` starts a comment. That means a hex colour
# MUST be quoted:
#
#   hue = "#E4572E"      -- correct, the value is the string "#E4572E"
#   hue = #E4572E        -- WRONG, everything from the `#` onward is a
#                           comment, so this line sets no value at all and
#                           the file will fail to parse with a "missing
#                           field" error.
#
# Only the frontmatter (between the two `+++` lines) is read by the app. The
# Markdown body below the closing `+++` is never parsed -- it exists for you
# and for an LLM you ask to revise this theme later. See the bottom of this
# file for what to put there.

schemaVersion = 1

# ---- CORE PROFILE: read by the in-app Settings -> Branding UI ----

[identity]
# Short name used inline in prose, e.g. a runtime error might read
# "Restart Northwind". Keep it to one or two words.
appName     = "Northwind"
# Full product name, used in headings and the sidebar wordmark. Often the
# same as appName with a suffix, e.g. "Northwind AI".
displayName = "Northwind AI"
# Optional. Shown as the message composer's placeholder text. Defaults to
# "Message <appName>..." if this key is omitted entirely.
tagline     = "Message Northwind..."

[logo]
# Bare filename only -- never a path or a URL. This file must sit right
# next to brand.md itself (same directory). Anything with a `/`, a `\`, a
# leading `~`, a `..`, or a Windows drive letter (`C:...`) is rejected: this
# filename is joined directly onto the branding directory, so it is the
# only thing standing between a hand-edited brand.md and reading a file
# from somewhere it shouldn't.
file = "logo.png"

# Eighteen colours per theme -- not the ~124 CSS custom properties the app
# actually has. The rest are structural (spacing, radii, type scale, not
# brand) or derived automatically from these (accent tint levels, hover
# states). Every value must be a hex colour: #rgb, #rrggbb, or #rrggbbaa --
# no url(...), var(...), rgb(...), or named CSS colours. That is deliberate:
# a brand file that can only express a hex colour cannot express a network
# fetch, no matter what a future CSP might otherwise allow.
#
# BOTH [palette.dark] and [palette.light] are required if you specify a
# palette at all -- a brand that restyles one theme but not the other leaves
# the other theme's built-in rules half-overridden, which produces
# unreadable text rather than an obvious failure (see tokens.css's
# "specificity trap" note). If you only want to rename the product without
# restyling it, omit [palette.dark]/[palette.light] entirely and the app
# keeps its built-in colours.
[palette.dark]
bg       = "#0F1115"  # app ground (the base background behind everything)
bgSide   = "#0B0D11"  # sidebar / rail ground
card     = "#161A21"  # raised surface -- message bubbles, panels
cardHi   = "#1D222B"  # hovered/active card
line     = "#252B36"  # default border
lineSoft = "#1D222B"  # subdued divider
lineHi   = "#2E3542"  # emphasised border
ink      = "#E8EAED"  # primary text -- contrast-checked against every surface above
ink2     = "#A8AEB8"  # secondary text
ink3     = "#8790A0"  # tertiary text (captions, timestamps)
hue      = "#E4572E"  # the accent colour itself -- tints/hovers derive from this
hueText  = "#FF8A61"  # accent tuned for text-on-background contrast
hueSolid = "#B8441F"  # accent as a solid fill (buttons)
onHue    = "#FFFFFF"  # text drawn on top of hueSolid
ok       = "#3FB950"  # success
warn     = "#D29922"  # warning
err      = "#F85149"  # error
link     = "#58A6FF"  # hyperlink

[palette.light]
bg       = "#FBFAF8"
bgSide   = "#F3F1EC"
card     = "#FFFFFF"
cardHi   = "#F3F1EC"
line     = "#E4E0D8"
lineSoft = "#EDEAE2"
lineHi   = "#CFC9BC"
ink      = "#1E1B16"
ink2     = "#4A4438"
ink3     = "#6E6656"
hue      = "#B8441F"
hueText  = "#9A3A1B"
hueSolid = "#B8441F"
onHue    = "#FFFFFF"
ok       = "#1A7F37"
warn     = "#9A6700"
err      = "#CF222E"
link     = "#0969DA"

# ---- BUILD PROFILE: Mode B only (a packaged, white-labeled build) ----
#
# Every key below this line is ignored by the in-app Settings -> Branding UI
# -- it is surfaced there as a notice ("this key only takes effect in a
# packaged build"), never as an error. They only take effect when this
# brand.md is fed into the build-time rebrand pipeline (fonts get bundled,
# `tauri icon` regenerates every platform's icon set, tauri.conf.json gets
# patched), which is a different, separate step from anything Settings can
# do at runtime. Uncomment and fill these in only if you are producing an
# installer to ship to someone else, not to demo a look in your own build.
#
# [fonts]
# ui   = "Soehne.woff2"        # blocked at runtime by font-src 'self'
# mono = "SoehneMono.woff2"    # -- bundled fonts are a build-time-only thing
#
# [bundle]
# productName = "Northwind AI"
# identifier  = "com.northwind.ai"
# publisher   = "Northwind Ltd"
# copyright   = "Copyright (c) 2026 Northwind Ltd. AGPL-3.0-only."
#
# [updater]
# endpoint = "https://updates.northwind.example/stable/manifest.json"
# pubkey   = "..."             # MUST be yours, never Conduit's
#
# [runtime]
# allowUserBranding = false    # lock the in-app Branding UI off in the shipped build
+++

# Northwind — design notes

This is the part of brand.md nobody parses. Use it however is useful to
you: a rationale for why these colours were picked, a moodboard link, or
notes to hand back to an LLM the next time you want to revise the theme --
"make it a little warmer" reads very differently to a model when it can see
this paragraph than when it can only see eighteen hex codes.

For this example: warm, editorial, low-contrast. The accent is a burnt
orange used sparingly -- the send button, the active nav row, the focus
ring. Surfaces stay near-neutral so the accent never has to compete with
message content for attention.
