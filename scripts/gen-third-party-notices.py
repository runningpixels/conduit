#!/usr/bin/env python3
"""Generate THIRD-PARTY-NOTICES.md from Cargo and npm dependency metadata.

`cargo about generate` with a handlebars template repeats the full license text
once per crate, producing an ~800 KB file with the MIT license in it 300 times.
This reads its JSON output instead and emits each distinct license text once.

Usage, from the repo root:

    cargo about generate --format json -o about.json
    pnpm licenses list --prod --json > js-licenses.json
    python scripts/gen-third-party-notices.py
    rm about.json js-licenses.json

Requires cargo-about:  cargo install cargo-about --locked --features cli
"""

from __future__ import annotations

import collections
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CARGO_JSON = ROOT / "about.json"
JS_JSON = ROOT / "js-licenses.json"
OUT = ROOT / "THIRD-PARTY-NOTICES.md"

HEADER = """# Third-party notices

Conduit is licensed under AGPL-3.0-only. It builds on the open-source work
listed below.

**This file is generated — do not edit by hand.** Regenerate with the commands
in `scripts/gen-third-party-notices.py`.

Fonts, bundled SQLite, and the LGPL system libraries that Linux bundles link
against are not package-manager dependencies; see [`NOTICE`](./NOTICE) for
those, including the LGPL relinking offer.
"""


def cargo_sections(data: dict) -> list[str]:
    licenses = data["licenses"]
    overview = data["overview"]

    by_crate: dict[tuple[str, str, str], set[str]] = collections.defaultdict(set)
    for lic in licenses:
        for used in lic.get("used_by", []):
            crate = used["crate"]
            key = (crate["name"], crate["version"], crate.get("repository") or "")
            by_crate[key].add(lic["id"])

    out = ["## Rust dependencies\n", "### Summary\n", "| License | Crates |\n|---|---:|"]
    for entry in sorted(overview, key=lambda x: -x["count"]):
        out.append(f"| {entry['name']} (`{entry['id']}`) | {entry['count']} |")
    out.append(f"\nTotal: **{len(by_crate)} crates**.\n")

    out += ["### Crates\n", "| Crate | Version | License(s) |\n|---|---|---|"]
    for name, version, repo in sorted(by_crate):
        ids = " / ".join(f"`{i}`" for i in sorted(by_crate[(name, version, repo)]))
        url = repo or f"https://crates.io/crates/{name}"
        out.append(f"| [{name}]({url}) | {version} | {ids} |")

    out += ["\n### License texts\n", "Each distinct license text appears once.\n"]
    seen: set[str] = set()
    for entry in sorted(overview, key=lambda x: -x["count"]):
        if entry["id"] in seen:
            continue
        seen.add(entry["id"])
        out.append(
            f"<details>\n<summary><strong>{entry['name']}</strong> "
            f"(<code>{entry['id']}</code>)</summary>\n"
        )
        out.append("```text\n" + entry["text"].strip() + "\n```\n")
        out.append("</details>\n")
    return out


def js_sections(data: dict) -> list[str]:
    out = [
        "\n## JavaScript runtime dependencies\n",
        "Production npm dependencies bundled into the renderer.\n",
        "| Package | Version | License |\n|---|---|---|",
    ]
    count = 0
    for license_id, packages in sorted(data.items()):
        for pkg in sorted(packages, key=lambda x: x.get("name", "")):
            name = pkg.get("name", "?")
            versions = pkg.get("versions") or [pkg.get("version", "?")]
            version = ", ".join(versions) if isinstance(versions, list) else versions
            home = pkg.get("homepage") or f"https://www.npmjs.com/package/{name}"
            out.append(f"| [{name}]({home}) | {version} | `{license_id}` |")
            count += 1
    out.append(f"\nTotal: **{count} packages**.\n")
    return out


def main() -> int:
    if not CARGO_JSON.exists():
        print(f"missing {CARGO_JSON.name}: run `cargo about generate --format json -o about.json`")
        return 1

    parts = [HEADER]
    parts += cargo_sections(json.loads(CARGO_JSON.read_text(encoding="utf-8")))

    if JS_JSON.exists():
        parts += js_sections(json.loads(JS_JSON.read_text(encoding="utf-8")))
    else:
        print(f"note: {JS_JSON.name} absent — skipping the JavaScript section")

    with open(OUT, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(parts) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
