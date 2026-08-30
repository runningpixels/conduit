+++
schemaVersion = 1

# Fixture for apps/desktop/src/brand/brandEquivalence.test.ts -- the
# acceptance test for the whole two-mode white-label design (plan §6,
# "Equivalence (the important one)"). The test reads this file's palette
# tables directly (a tiny ad hoc TOML extractor, not a hand-duplicated TS
# fixture) and diffs Mode A's PALETTE_PROPERTY_MAP + deriveHueWeak against
# Mode B's real emitted CSS for these same values. Every dark/light value
# below is deliberately distinct from its sibling so a swapped-theme bug
# cannot hide behind a coincidentally-equal value.

[identity]
appName     = "Northwind"
displayName = "Northwind AI"
tagline     = "Message Northwind..."

[palette.dark]
bg       = "#0F1115"
bgSide   = "#0B0D11"
card     = "#161A21"
cardHi   = "#1D222B"
line     = "#252B36"
lineSoft = "#1B202A"
lineHi   = "#333A47"
ink      = "#E8EAED"
ink2     = "#A8AEB8"
ink3     = "#6F7681"
hue      = "#E4572E"
hueText  = "#FF8A61"
hueSolid = "#E4572E"
onHue    = "#FFFFFF"
ok       = "#3FB950"
warn     = "#D29922"
err      = "#F85149"
link     = "#58A6FF"

[palette.light]
bg       = "#FDFCF9"
bgSide   = "#F4F2EA"
card     = "#FFFFFF"
cardHi   = "#F5F4EE"
line     = "#E4E1D7"
lineSoft = "#EDEAE1"
lineHi   = "#CFCBBF"
ink      = "#20201D"
ink2     = "#59564C"
ink3     = "#706C61"
hue      = "#B0431F"
hueText  = "#B0431F"
hueSolid = "#BD5836"
onHue    = "#FFFFFF"
ok       = "#147C3B"
warn     = "#AF5109"
err      = "#B91C1C"
link     = "#1F5FA8"
+++

# Northwind — equivalence fixture

Not a real brand; exists only so the acceptance test has a `brand.md` both
Mode A's applyBrand path and Mode B's emitted CSS can be run against.
