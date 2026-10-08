Slide canvas: 1920 x 1080 pixels, read from across a room. Pick the layout that fits each slide's point and pass its fields; the theme styles them. Text fields are plain text plus the inline tags span, em, strong, b, i, u, br, sub, sup, small and mark, with class as the only attribute (<span class="accent">word</span> sets a word in the accent color). Limits count visible words.

Layouts (the layout argument) and their fields:
- title: headline (≤ 10 words), sub (≤ 20), optional kicker (≤ 4).
- statement: one big headline (≤ 14 words), optional sub (≤ 20).
- bullets: headline (≤ 10 words), bullets: 2-5 items of ≤ 14 words; optional kicker.
- stat-row: stats: 2-4 {value, label}; value ≤ 6 characters, the number only ("42%", "3.1×", "$12M"); label ≤ 8 words, units and context go here. Optional headline (≤ 10 words), kicker, footnote.
- two-col: headline (≤ 10 words), columns: exactly 2 {kicker (≤ 4 words), then body (≤ 30 words) or bullets (2-4 items of ≤ 10 words)}; optional kicker.
- quote: quote (≤ 30 words), cite (≤ 8 words).
- section: headline (≤ 8 words), optional kicker (≤ 4, for example "Part 2").
- image-left: headline (≤ 10 words), body (≤ 30 words) or bullets (2-3 items of ≤ 12 words), and exactly one of chart or svg, drawn in an 820 x 600 box on the left.
- chart: headline (≤ 12 words) and exactly one of chart or svg, drawn full width (1680 x up to 640); optional kicker, footnote.
- custom: html only (below).
footnote, a source or note of ≤ 20 words, fits every layout except title, section and custom. kicker, ≤ 4 words everywhere, is a small uppercase label above the headline.

chart is data; the app draws it in the theme:
- bar: {"type": "bar", "categories": ["Q1", "Q2", "Q3", "Q4"], "series": [{"name": "Revenue", "values": [1.2, 1.8, 2.1, 2.9]}], "unit_prefix": "$", "unit_suffix": "M", "highlight": [3]}. Up to 12 categories and 1-3 series; highlight lists category indexes to draw in the accent color; optional y_label.
- line: the same shape without highlight, up to 24 categories and 1-4 series.
- funnel: {"type": "funnel", "stages": [{"label": "Visited", "value": 12000}, {"label": "Signed up", "value": 2400}, {"label": "Paid", "value": 310}]}. 2-7 stages.
Each values list has one number per category. Values are plain numbers; units go in unit_prefix and unit_suffix. Labels ≤ 4 words.

svg, for a diagram no chart type can show: exactly one <svg> element with a viewBox shaped like its box (about 1680 x 640 in chart, 820 x 600 in image-left). The app sizes it: no width, height or style on it. Text scales with the drawing, so with such a viewBox use font-size 24 or more (text that would render below 20px is rejected). Colors and fonts from the theme tokens: var(--ink), var(--ink-2), var(--accent), var(--surface), var(--font-body). No scripts, event handlers or external links.

custom: html, the slide's inner HTML, only when no layout fits; custom slides get a layout check after your turn. No <section> wrapper. Put every piece of visible text in an element with a data-text attribute naming its slot (data-text="headline", data-text="point-1"). Use the theme classes: .kicker, .headline, .sub, .body, ul.bullets, .stat (<b> value, <span> label), .col (a card), .quote, .cite, .footnote, .accent. Colors and fonts only as var(--name) of the tokens --bg, --ink, --ink-2, --accent, --surface, --font-display, --font-body, --font-mono; never hard-coded. No scripts and no external URLs; images are inline SVG or data: URIs.
