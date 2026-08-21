# Licensing

Copyright (C) 2026 Emilio Olivares

Conduit is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License, **version 3 only**, as published
by the Free Software Foundation. This project is licensed under
`AGPL-3.0-only`. The "or (at your option) any later version" language that
appears in the *How to Apply These Terms* appendix of [`LICENSE`](./LICENSE) is
part of the FSF's recommended notice template and is **not** part of this grant.

Conduit is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
You should have received a copy of the GNU Affero General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>.

## What this means in practice

- **Using Conduit** — no obligations. Run it, bring your own API keys, keep your
  data local.
- **Modifying and distributing it** — you must release your changes under the
  same license and provide the corresponding source.
- **Running a modified version as a network service** — AGPL section 13 requires
  you to offer that version's source to its users. Conduit is a local desktop
  application today, so section 13 does not currently bite; it becomes operative
  if someone hosts a modified build.

Binary bundles are distributed from GitHub Releases in this same repository, so
the corresponding source is available from the same place, satisfying section
6(d).

## Additional permission under GNU AGPL version 3 section 7

If you modify this Program, or any covered work, by linking or combining it with
OpenSSL (or a modified version of that library), containing parts covered by the
terms of the OpenSSL License, the licensors of this Program grant you additional
permission to convey the resulting work. Corresponding Source for a non-source
form of such a combination shall include the source code for the parts of
OpenSSL used as well as that of the covered work.

This permission exists because `ring` — reached transitively through
`reqwest` → `rustls` — carries BoringSSL-derived portions that some license
scanners report as `OpenSSL`. The permission removes any doubt, and
pre-authorizes a future switch to system OpenSSL on Linux.

## Third-party components

Dependency licenses are catalogued in [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md)
and summarised in [`NOTICE`](./NOTICE). All Rust and JavaScript dependencies are
permissive (MIT / Apache-2.0 / BSD / ISC), which is one-way compatible with
AGPL-3.0. Bundled SQLite is public domain. Linux bundles link against LGPL
system libraries — see `NOTICE` for the relinking offer that LGPL requires.

## Copyright ownership and commercial licensing

Emilio Olivares is the sole copyright holder of Conduit. Contributions are
accepted only under the Contributor License Agreement described in
[`CONTRIBUTING.md`](./CONTRIBUTING.md), which grants the copyright holder the
right to license contributions under terms other than the AGPL.

This preserves the ability to offer Conduit under a separate commercial license.
If the AGPL does not suit your use case, open an issue to discuss alternative
terms.
