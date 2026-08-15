# Third-party notices

Conduit is licensed under AGPL-3.0-only. It builds on the open-source work
listed below.

**This file is generated — do not edit by hand.** Regenerate with the commands
in `scripts/gen-third-party-notices.py`.

Fonts, bundled SQLite, and the LGPL system libraries that Linux bundles link
against are not package-manager dependencies; see [`NOTICE`](./NOTICE) for
those, including the LGPL relinking offer.

## Rust dependencies

### Summary

| License | Crates |
|---|---:|
| Apache License 2.0 (`Apache-2.0`) | 344 |
| MIT License (`MIT`) | 143 |
| Unicode License v3 (`Unicode-3.0`) | 19 |
| BSD 3-Clause "New" or "Revised" License (`BSD-3-Clause`) | 5 |
| Mozilla Public License 2.0 (`MPL-2.0`) | 5 |
| GNU Affero General Public License v3.0 only (`AGPL-3.0-only`) | 3 |
| ISC License (`ISC`) | 3 |
| Boost Software License 1.0 (`BSL-1.0`) | 2 |
| zlib License (`Zlib`) | 2 |
| Community Data License Agreement Permissive 2.0 (`CDLA-Permissive-2.0`) | 1 |

Total: **522 crates**.

### Crates

| Crate | Version | License(s) |
|---|---|---|
| [adler2](https://github.com/oyvindln/adler2) | 2.0.1 | `Apache-2.0` |
| [aead](https://github.com/RustCrypto/traits) | 0.5.2 | `Apache-2.0` |
| [aes](https://github.com/RustCrypto/block-ciphers) | 0.8.4 | `Apache-2.0` |
| [aes-gcm](https://github.com/RustCrypto/AEADs) | 0.10.3 | `Apache-2.0` |
| [aho-corasick](https://github.com/BurntSushi/aho-corasick) | 1.1.4 | `MIT` |
| [alloc-no-stdlib](https://github.com/dropbox/rust-alloc-no-stdlib) | 2.0.4 | `BSD-3-Clause` |
| [alloc-stdlib](https://github.com/dropbox/rust-alloc-no-stdlib) | 0.2.4 | `BSD-3-Clause` |
| [allocator-api2](https://github.com/zakarumych/allocator-api2) | 0.2.21 | `Apache-2.0` |
| [anyhow](https://github.com/dtolnay/anyhow) | 1.0.102 | `Apache-2.0` |
| [arboard](https://github.com/1Password/arboard) | 3.6.1 | `Apache-2.0` |
| [async-broadcast](https://github.com/smol-rs/async-broadcast) | 0.7.2 | `Apache-2.0` |
| [async-channel](https://github.com/smol-rs/async-channel) | 2.5.0 | `Apache-2.0` |
| [async-executor](https://github.com/smol-rs/async-executor) | 1.14.0 | `Apache-2.0` |
| [async-fs](https://github.com/smol-rs/async-fs) | 2.2.0 | `Apache-2.0` |
| [async-io](https://github.com/smol-rs/async-io) | 2.6.0 | `Apache-2.0` |
| [async-lock](https://github.com/smol-rs/async-lock) | 3.4.2 | `Apache-2.0` |
| [async-process](https://github.com/smol-rs/async-process) | 2.5.0 | `Apache-2.0` |
| [async-recursion](https://github.com/dcchut/async-recursion) | 1.1.1 | `Apache-2.0` |
| [async-signal](https://github.com/smol-rs/async-signal) | 0.2.14 | `Apache-2.0` |
| [async-stream](https://github.com/tokio-rs/async-stream) | 0.3.6 | `MIT` |
| [async-stream-impl](https://github.com/tokio-rs/async-stream) | 0.3.6 | `MIT` |
| [async-task](https://github.com/smol-rs/async-task) | 4.7.1 | `Apache-2.0` |
| [async-trait](https://github.com/dtolnay/async-trait) | 0.1.89 | `Apache-2.0` |
| [atk](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | `MIT` |
| [atk-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | `MIT` |
| [atoi](https://github.com/pacman82/atoi-rs) | 2.0.0 | `MIT` |
| [atomic-waker](https://github.com/smol-rs/atomic-waker) | 1.1.2 | `Apache-2.0` |
| [autocfg](https://github.com/cuviper/autocfg) | 1.5.1 | `Apache-2.0` |
| [base64](https://github.com/marshallpierce/rust-base64) | 0.21.7 | `Apache-2.0` |
| [base64](https://github.com/marshallpierce/rust-base64) | 0.22.1 | `Apache-2.0` |
| [bit-set](https://github.com/contain-rs/bit-set) | 0.8.0 | `Apache-2.0` |
| [bit-vec](https://github.com/contain-rs/bit-vec) | 0.8.0 | `Apache-2.0` |
| [bitflags](https://github.com/bitflags/bitflags) | 1.3.2 | `Apache-2.0` |
| [bitflags](https://github.com/bitflags/bitflags) | 2.13.0 | `Apache-2.0` |
| [block-buffer](https://github.com/RustCrypto/utils) | 0.10.4 | `Apache-2.0` |
| [block-padding](https://github.com/RustCrypto/utils) | 0.3.3 | `Apache-2.0` |
| [block2](https://github.com/madsmtm/objc2) | 0.6.2 | `MIT` |
| [blocking](https://github.com/smol-rs/blocking) | 1.6.2 | `Apache-2.0` |
| [brotli](https://github.com/dropbox/rust-brotli) | 8.0.4 | `BSD-3-Clause` / `MIT` |
| [brotli-decompressor](https://github.com/dropbox/rust-brotli-decompressor) | 5.0.3 | `MIT` |
| [bytemuck](https://github.com/Lokathor/bytemuck) | 1.25.0 | `Apache-2.0` |
| [byteorder](https://github.com/BurntSushi/byteorder) | 1.5.0 | `MIT` |
| [byteorder-lite](https://github.com/image-rs/byteorder-lite) | 0.1.0 | `MIT` |
| [bytes](https://github.com/tokio-rs/bytes) | 1.12.0 | `MIT` |
| [cairo-rs](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | `MIT` |
| [cairo-sys-rs](https://github.com/gtk-rs/gtk-rs-core) | 0.18.2 | `MIT` |
| [camino](https://github.com/camino-rs/camino) | 1.2.3 | `Apache-2.0` |
| [cargo-platform](https://github.com/rust-lang/cargo) | 0.1.9 | `Apache-2.0` |
| [cargo_metadata](https://github.com/oli-obk/cargo_metadata) | 0.19.2 | `MIT` |
| [cargo_toml](https://gitlab.com/lib.rs/cargo_toml) | 0.22.3 | `Apache-2.0` |
| [cbc](https://github.com/RustCrypto/block-modes) | 0.1.2 | `Apache-2.0` |
| [cc](https://github.com/rust-lang/cc-rs) | 1.2.65 | `Apache-2.0` |
| [cfb](https://github.com/mdsteele/rust-cfb) | 0.7.3 | `MIT` |
| [cfg-expr](https://github.com/EmbarkStudios/cfg-expr) | 0.15.8 | `Apache-2.0` |
| [cfg-if](https://github.com/rust-lang/cfg-if) | 1.0.4 | `Apache-2.0` |
| [cfg_aliases](https://github.com/katharostech/cfg_aliases) | 0.2.1 | `MIT` |
| [chrono](https://github.com/chronotope/chrono) | 0.4.45 | `Apache-2.0` |
| [cipher](https://github.com/RustCrypto/traits) | 0.4.4 | `Apache-2.0` |
| [clipboard-win](https://github.com/DoumanAsh/clipboard-win) | 5.4.1 | `BSL-1.0` |
| [concurrent-queue](https://github.com/smol-rs/concurrent-queue) | 2.5.0 | `Apache-2.0` |
| [conduit-desktop](https://github.com/tobiaz/conduit) | 0.1.0 | `AGPL-3.0-only` |
| [cookie](https://github.com/SergioBenitez/cookie-rs) | 0.18.1 | `Apache-2.0` |
| [core-foundation](https://github.com/servo/core-foundation-rs) | 0.10.1 | `Apache-2.0` |
| [core-foundation-sys](https://github.com/servo/core-foundation-rs) | 0.8.7 | `Apache-2.0` |
| [core-graphics](https://github.com/servo/core-foundation-rs) | 0.25.0 | `Apache-2.0` |
| [core-graphics-types](https://github.com/servo/core-foundation-rs) | 0.2.0 | `Apache-2.0` |
| [cpufeatures](https://github.com/RustCrypto/utils) | 0.2.17 | `Apache-2.0` |
| [crc](https://github.com/mrhooray/crc-rs.git) | 3.4.0 | `Apache-2.0` |
| [crc-catalog](https://github.com/akhilles/crc-catalog.git) | 2.5.0 | `Apache-2.0` |
| [crc32fast](https://github.com/srijs/rust-crc32fast) | 1.5.0 | `Apache-2.0` |
| [crossbeam-channel](https://github.com/crossbeam-rs/crossbeam) | 0.5.15 | `Apache-2.0` |
| [crossbeam-queue](https://github.com/crossbeam-rs/crossbeam) | 0.3.12 | `Apache-2.0` |
| [crossbeam-utils](https://github.com/crossbeam-rs/crossbeam) | 0.8.21 | `Apache-2.0` |
| [crypto-common](https://github.com/RustCrypto/traits) | 0.1.7 | `Apache-2.0` |
| [cssparser](https://github.com/servo/rust-cssparser) | 0.36.0 | `MPL-2.0` |
| [cssparser-macros](https://github.com/servo/rust-cssparser) | 0.6.1 | `MPL-2.0` |
| [ctor](https://github.com/mmastrac/rust-ctor) | 0.8.0 | `Apache-2.0` |
| [ctor-proc-macro](https://github.com/mmastrac/rust-ctor) | 0.0.7 | `Apache-2.0` |
| [ctr](https://github.com/RustCrypto/block-modes) | 0.9.2 | `Apache-2.0` |
| [darling](https://github.com/TedDriggs/darling) | 0.23.0 | `MIT` |
| [darling_core](https://github.com/TedDriggs/darling) | 0.23.0 | `MIT` |
| [darling_macro](https://github.com/TedDriggs/darling) | 0.23.0 | `MIT` |
| [dbus](https://github.com/diwic/dbus-rs) | 0.9.11 | `Apache-2.0` |
| [deranged](https://github.com/jhpratt/deranged) | 0.5.8 | `Apache-2.0` |
| [derive_more](https://github.com/JelteF/derive_more) | 2.1.1 | `MIT` |
| [derive_more-impl](https://github.com/JelteF/derive_more) | 2.1.1 | `MIT` |
| [digest](https://github.com/RustCrypto/traits) | 0.10.7 | `Apache-2.0` |
| [directories](https://github.com/soc/directories-rs) | 6.0.0 | `Apache-2.0` |
| [dirs](https://github.com/soc/dirs-rs) | 6.0.0 | `Apache-2.0` |
| [dirs-sys](https://github.com/dirs-dev/dirs-sys-rs) | 0.5.0 | `Apache-2.0` |
| [dispatch2](https://github.com/madsmtm/objc2) | 0.3.1 | `Apache-2.0` |
| [displaydoc](https://github.com/yaahc/displaydoc) | 0.2.6 | `Apache-2.0` |
| [dlopen2](https://github.com/OpenByteDev/dlopen2) | 0.8.2 | `MIT` |
| [dlopen2_derive](https://github.com/OpenByteDev/dlopen2) | 0.4.3 | `MIT` |
| [dom_query](https://github.com/niklak/dom_query) | 0.27.0 | `MIT` |
| [dotenvy](https://github.com/allan2/dotenvy) | 0.15.7 | `MIT` |
| [dpi](https://github.com/rust-windowing/winit) | 0.1.2 | `Apache-2.0` / `MIT` |
| [dtoa](https://github.com/dtolnay/dtoa) | 1.0.11 | `Apache-2.0` |
| [dtoa-short](https://github.com/upsuper/dtoa-short) | 0.3.5 | `MPL-2.0` |
| [dunce](https://gitlab.com/kornelski/dunce) | 1.0.5 | `Apache-2.0` |
| [dyn-clone](https://github.com/dtolnay/dyn-clone) | 1.0.20 | `Apache-2.0` |
| [either](https://github.com/rayon-rs/either) | 1.16.0 | `Apache-2.0` |
| [embed-resource](https://github.com/nabijaczleweli/rust-embed-resource) | 3.0.9 | `MIT` |
| [embed_plist](https://github.com/nvzqz/embed-plist-rs) | 1.2.2 | `Apache-2.0` |
| [encoding_rs](https://github.com/hsivonen/encoding_rs) | 0.8.35 | `Apache-2.0` / `BSD-3-Clause` |
| [endi](https://github.com/zeenix/endi) | 1.1.1 | `MIT` |
| [enumflags2](https://github.com/meithecatte/enumflags2) | 0.7.12 | `Apache-2.0` |
| [enumflags2_derive](https://github.com/meithecatte/enumflags2) | 0.7.12 | `Apache-2.0` |
| [equivalent](https://github.com/indexmap-rs/equivalent) | 1.0.2 | `Apache-2.0` |
| [erased-serde](https://github.com/dtolnay/erased-serde) | 0.4.10 | `Apache-2.0` |
| [errno](https://github.com/lambda-fairy/rust-errno) | 0.3.14 | `Apache-2.0` |
| [error-code](https://github.com/DoumanAsh/error-code) | 3.3.2 | `BSL-1.0` |
| [event-listener](https://github.com/smol-rs/event-listener) | 5.4.1 | `Apache-2.0` |
| [event-listener-strategy](https://github.com/smol-rs/event-listener-strategy) | 0.5.4 | `Apache-2.0` |
| [fastrand](https://github.com/smol-rs/fastrand) | 2.4.1 | `Apache-2.0` |
| [fax](https://github.com/pdf-rs/fax) | 0.2.7 | `MIT` |
| [fdeflate](https://github.com/image-rs/fdeflate) | 0.3.7 | `Apache-2.0` |
| [field-offset](https://github.com/Diggsey/rust-field-offset) | 0.3.6 | `Apache-2.0` |
| [filetime](https://github.com/alexcrichton/filetime) | 0.2.29 | `Apache-2.0` |
| [find-msvc-tools](https://github.com/rust-lang/cc-rs) | 0.1.9 | `Apache-2.0` |
| [flate2](https://github.com/rust-lang/flate2-rs) | 1.1.9 | `Apache-2.0` |
| [flume](https://github.com/zesterer/flume) | 0.11.1 | `Apache-2.0` |
| [fnv](https://github.com/servo/rust-fnv) | 1.0.7 | `Apache-2.0` |
| [foldhash](https://github.com/orlp/foldhash) | 0.1.5 | `Zlib` |
| [foldhash](https://github.com/orlp/foldhash) | 0.2.0 | `Zlib` |
| [foreign-types](https://github.com/sfackler/foreign-types) | 0.5.0 | `Apache-2.0` |
| [foreign-types-macros](https://github.com/sfackler/foreign-types) | 0.2.3 | `Apache-2.0` |
| [foreign-types-shared](https://github.com/sfackler/foreign-types) | 0.3.1 | `Apache-2.0` |
| [form_urlencoded](https://github.com/servo/rust-url) | 1.2.2 | `Apache-2.0` |
| [futures](https://github.com/rust-lang/futures-rs) | 0.3.32 | `Apache-2.0` |
| [futures-channel](https://github.com/rust-lang/futures-rs) | 0.3.32 | `Apache-2.0` |
| [futures-core](https://github.com/rust-lang/futures-rs) | 0.3.32 | `Apache-2.0` |
| [futures-executor](https://github.com/rust-lang/futures-rs) | 0.3.32 | `Apache-2.0` |
| [futures-intrusive](https://github.com/Matthias247/futures-intrusive) | 0.5.0 | `Apache-2.0` |
| [futures-io](https://github.com/rust-lang/futures-rs) | 0.3.32 | `Apache-2.0` |
| [futures-lite](https://github.com/smol-rs/futures-lite) | 2.6.1 | `Apache-2.0` |
| [futures-macro](https://github.com/rust-lang/futures-rs) | 0.3.32 | `Apache-2.0` |
| [futures-sink](https://github.com/rust-lang/futures-rs) | 0.3.32 | `Apache-2.0` |
| [futures-task](https://github.com/rust-lang/futures-rs) | 0.3.32 | `Apache-2.0` |
| [futures-util](https://github.com/rust-lang/futures-rs) | 0.3.32 | `Apache-2.0` |
| [gdk](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | `MIT` |
| [gdk-pixbuf](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | `MIT` |
| [gdk-pixbuf-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.0 | `MIT` |
| [gdk-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | `MIT` |
| [gdkwayland-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | `MIT` |
| [gdkx11](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | `MIT` |
| [gdkx11-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | `MIT` |
| [generic-array](https://github.com/fizyk20/generic-array.git) | 0.14.7 | `MIT` |
| [gethostname](https://codeberg.org/swsnr/gethostname.rs.git) | 1.1.0 | `Apache-2.0` |
| [getrandom](https://github.com/rust-random/getrandom) | 0.2.17 | `Apache-2.0` |
| [getrandom](https://github.com/rust-random/getrandom) | 0.3.4 | `Apache-2.0` |
| [getrandom](https://github.com/rust-random/getrandom) | 0.4.3 | `Apache-2.0` |
| [ghash](https://github.com/RustCrypto/universal-hashes) | 0.5.1 | `Apache-2.0` |
| [gio](https://github.com/gtk-rs/gtk-rs-core) | 0.18.4 | `MIT` |
| [gio-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.1 | `MIT` |
| [glib](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | `MIT` |
| [glib-macros](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | `MIT` |
| [glib-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.1 | `MIT` |
| [glob](https://github.com/rust-lang/glob) | 0.3.3 | `Apache-2.0` |
| [gobject-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.0 | `MIT` |
| [gtk](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | `MIT` |
| [gtk-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | `MIT` |
| [gtk3-macros](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | `MIT` |
| [half](https://github.com/VoidStarKat/half-rs) | 2.7.1 | `Apache-2.0` |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.12.3 | `Apache-2.0` |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.15.5 | `Apache-2.0` |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.17.1 | `Apache-2.0` |
| [hashlink](https://github.com/kyren/hashlink) | 0.10.0 | `Apache-2.0` |
| [heck](https://github.com/withoutboats/heck) | 0.4.1 | `Apache-2.0` |
| [heck](https://github.com/withoutboats/heck) | 0.5.0 | `Apache-2.0` |
| [hex](https://github.com/KokaKiwi/rust-hex) | 0.4.3 | `Apache-2.0` |
| [hkdf](https://github.com/RustCrypto/KDFs/) | 0.12.4 | `Apache-2.0` |
| [hmac](https://github.com/RustCrypto/MACs) | 0.12.1 | `Apache-2.0` |
| [html5ever](https://github.com/servo/html5ever) | 0.38.0 | `Apache-2.0` |
| [http](https://github.com/hyperium/http) | 1.4.2 | `Apache-2.0` |
| [http-body](https://github.com/hyperium/http-body) | 1.0.1 | `MIT` |
| [http-body-util](https://github.com/hyperium/http-body) | 0.1.3 | `MIT` |
| [httparse](https://github.com/seanmonstar/httparse) | 1.10.1 | `Apache-2.0` |
| [hyper](https://github.com/hyperium/hyper) | 1.10.1 | `MIT` |
| [hyper-rustls](https://github.com/rustls/hyper-rustls) | 0.27.9 | `Apache-2.0` |
| [hyper-util](https://github.com/hyperium/hyper-util) | 0.1.20 | `MIT` |
| [iana-time-zone](https://github.com/strawlab/iana-time-zone) | 0.1.65 | `Apache-2.0` |
| [ico](https://github.com/mdsteele/rust-ico) | 0.5.0 | `MIT` |
| [icu_collections](https://github.com/unicode-org/icu4x) | 2.2.0 | `Unicode-3.0` |
| [icu_locale_core](https://github.com/unicode-org/icu4x) | 2.2.0 | `Unicode-3.0` |
| [icu_normalizer](https://github.com/unicode-org/icu4x) | 2.2.0 | `Unicode-3.0` |
| [icu_normalizer_data](https://github.com/unicode-org/icu4x) | 2.2.0 | `Unicode-3.0` |
| [icu_properties](https://github.com/unicode-org/icu4x) | 2.2.0 | `Unicode-3.0` |
| [icu_properties_data](https://github.com/unicode-org/icu4x) | 2.2.0 | `Unicode-3.0` |
| [icu_provider](https://github.com/unicode-org/icu4x) | 2.2.0 | `Unicode-3.0` |
| [ident_case](https://github.com/TedDriggs/ident_case) | 1.0.1 | `Apache-2.0` |
| [idna](https://github.com/servo/rust-url/) | 1.1.0 | `Apache-2.0` |
| [idna_adapter](https://github.com/hsivonen/idna_adapter) | 1.2.2 | `Apache-2.0` |
| [image](https://github.com/image-rs/image) | 0.25.10 | `Apache-2.0` |
| [indexmap](https://github.com/bluss/indexmap) | 1.9.3 | `Apache-2.0` |
| [indexmap](https://github.com/indexmap-rs/indexmap) | 2.14.0 | `Apache-2.0` |
| [infer](https://github.com/bojand/infer) | 0.19.0 | `MIT` |
| [inout](https://github.com/RustCrypto/utils) | 0.1.4 | `Apache-2.0` |
| [ipnet](https://github.com/krisprice/ipnet) | 2.12.0 | `Apache-2.0` |
| [is-docker](https://github.com/TheLarkInn/is-docker) | 0.2.0 | `MIT` |
| [is-wsl](https://github.com/TheLarkInn/is-wsl) | 0.4.0 | `MIT` |
| [itoa](https://github.com/dtolnay/itoa) | 1.0.18 | `Apache-2.0` |
| [javascriptcore-rs](https://github.com/tauri-apps/javascriptcore-rs) | 1.1.2 | `MIT` |
| [javascriptcore-rs-sys](https://github.com/tauri-apps/javascriptcore-rs) | 1.1.1 | `MIT` |
| [json-patch](https://github.com/idubrov/json-patch) | 3.0.1 | `Apache-2.0` |
| [jsonptr](https://github.com/chanced/jsonptr) | 0.6.3 | `Apache-2.0` |
| [keyboard-types](https://github.com/pyfisch/keyboard-types) | 0.7.0 | `Apache-2.0` |
| [keyring](https://github.com/hwchen/keyring-rs.git) | 3.6.3 | `Apache-2.0` |
| [lazy_static](https://github.com/rust-lang-nursery/lazy-static.rs) | 1.5.0 | `Apache-2.0` |
| [libc](https://github.com/rust-lang/libc) | 0.2.186 | `Apache-2.0` |
| [libdbus-sys](https://github.com/diwic/dbus-rs) | 0.2.7 | `Apache-2.0` |
| [libsqlite3-sys](https://github.com/rusqlite/rusqlite) | 0.30.1 | `MIT` |
| [linux-keyutils](https://github.com/landhb/linux-keyutils) | 0.2.5 | `Apache-2.0` |
| [linux-raw-sys](https://github.com/sunfishcode/linux-raw-sys) | 0.12.1 | `Apache-2.0` |
| [litemap](https://github.com/unicode-org/icu4x) | 0.8.2 | `Unicode-3.0` |
| [lock_api](https://github.com/Amanieu/parking_lot) | 0.4.14 | `Apache-2.0` |
| [log](https://github.com/rust-lang/log) | 0.4.33 | `Apache-2.0` |
| [markup5ever](https://github.com/servo/html5ever) | 0.38.0 | `Apache-2.0` |
| [matchers](https://github.com/hawkw/matchers) | 0.2.0 | `MIT` |
| [mcp-runtime](https://github.com/tobiaz/conduit) | 0.1.0 | `AGPL-3.0-only` |
| [memchr](https://github.com/BurntSushi/memchr) | 2.8.2 | `MIT` |
| [memoffset](https://github.com/Gilnaa/memoffset) | 0.9.1 | `MIT` |
| [mime](https://github.com/hyperium/mime) | 0.3.17 | `Apache-2.0` |
| [minisign-verify](https://github.com/jedisct1/rust-minisign-verify) | 0.2.5 | `MIT` |
| [miniz_oxide](https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide) | 0.8.9 | `Apache-2.0` |
| [mio](https://github.com/tokio-rs/mio) | 1.2.1 | `MIT` |
| [moxcms](https://github.com/awxkee/moxcms.git) | 0.8.1 | `Apache-2.0` |
| [muda](https://github.com/tauri-apps/muda) | 0.19.3 | `Apache-2.0` |
| [new_debug_unreachable](https://github.com/mbrubeck/rust-debug-unreachable) | 1.0.6 | `MIT` |
| [nix](https://github.com/nix-rust/nix) | 0.29.0 | `MIT` |
| [nu-ansi-term](https://github.com/nushell/nu-ansi-term) | 0.50.3 | `MIT` |
| [num](https://github.com/rust-num/num) | 0.4.3 | `Apache-2.0` |
| [num-bigint](https://github.com/rust-num/num-bigint) | 0.4.6 | `Apache-2.0` |
| [num-complex](https://github.com/rust-num/num-complex) | 0.4.6 | `Apache-2.0` |
| [num-conv](https://github.com/jhpratt/num-conv) | 0.2.2 | `Apache-2.0` |
| [num-integer](https://github.com/rust-num/num-integer) | 0.1.46 | `Apache-2.0` |
| [num-iter](https://github.com/rust-num/num-iter) | 0.1.45 | `Apache-2.0` |
| [num-rational](https://github.com/rust-num/num-rational) | 0.4.2 | `Apache-2.0` |
| [num-traits](https://github.com/rust-num/num-traits) | 0.2.19 | `Apache-2.0` |
| [objc2](https://github.com/madsmtm/objc2) | 0.6.4 | `MIT` |
| [objc2-app-kit](https://github.com/madsmtm/objc2) | 0.3.2 | `Apache-2.0` |
| [objc2-core-foundation](https://github.com/madsmtm/objc2) | 0.3.2 | `Apache-2.0` |
| [objc2-core-graphics](https://github.com/madsmtm/objc2) | 0.3.2 | `Apache-2.0` |
| [objc2-encode](https://github.com/madsmtm/objc2) | 4.1.0 | `MIT` |
| [objc2-exception-helper](https://github.com/madsmtm/objc2) | 0.1.1 | `Apache-2.0` |
| [objc2-foundation](https://github.com/madsmtm/objc2) | 0.3.2 | `MIT` |
| [objc2-osa-kit](https://github.com/madsmtm/objc2) | 0.3.2 | `Apache-2.0` |
| [objc2-quartz-core](https://github.com/madsmtm/objc2) | 0.3.2 | `Apache-2.0` |
| [objc2-web-kit](https://github.com/madsmtm/objc2) | 0.3.2 | `Apache-2.0` |
| [once_cell](https://github.com/matklad/once_cell) | 1.21.4 | `Apache-2.0` |
| [opaque-debug](https://github.com/RustCrypto/utils) | 0.3.1 | `Apache-2.0` |
| [open](https://github.com/Byron/open-rs) | 5.3.5 | `MIT` |
| [openssl-probe](https://github.com/rustls/openssl-probe) | 0.2.1 | `Apache-2.0` |
| [option-ext](https://github.com/soc/option-ext.git) | 0.2.0 | `MPL-2.0` |
| [ordered-stream](https://github.com/danieldg/ordered-stream) | 0.2.0 | `Apache-2.0` |
| [os_pipe](https://github.com/oconnor663/os_pipe.rs) | 1.2.3 | `MIT` |
| [osakit](https://github.com/mdevils/rust-osakit) | 0.3.1 | `Apache-2.0` |
| [pango](https://github.com/gtk-rs/gtk-rs-core) | 0.18.3 | `MIT` |
| [pango-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.0 | `MIT` |
| [parking](https://github.com/smol-rs/parking) | 2.2.1 | `Apache-2.0` |
| [parking_lot](https://github.com/Amanieu/parking_lot) | 0.12.5 | `Apache-2.0` |
| [parking_lot_core](https://github.com/Amanieu/parking_lot) | 0.9.12 | `Apache-2.0` |
| [pathdiff](https://github.com/Manishearth/pathdiff) | 0.2.3 | `Apache-2.0` |
| [percent-encoding](https://github.com/servo/rust-url/) | 2.3.2 | `Apache-2.0` |
| [phf](https://github.com/rust-phf/rust-phf) | 0.13.1 | `MIT` |
| [phf_codegen](https://github.com/rust-phf/rust-phf) | 0.13.1 | `MIT` |
| [phf_generator](https://github.com/rust-phf/rust-phf) | 0.13.1 | `MIT` |
| [phf_macros](https://github.com/rust-phf/rust-phf) | 0.13.1 | `MIT` |
| [phf_shared](https://github.com/rust-phf/rust-phf) | 0.13.1 | `MIT` |
| [pin-project-lite](https://github.com/taiki-e/pin-project-lite) | 0.2.17 | `Apache-2.0` |
| [piper](https://github.com/smol-rs/piper) | 0.2.5 | `Apache-2.0` |
| [pkg-config](https://github.com/rust-lang/pkg-config-rs) | 0.3.33 | `Apache-2.0` |
| [plist](https://github.com/ebarnard/rust-plist/) | 1.9.0 | `MIT` |
| [png](https://github.com/image-rs/image-png) | 0.17.16 | `Apache-2.0` |
| [png](https://github.com/image-rs/image-png) | 0.18.1 | `Apache-2.0` |
| [polling](https://github.com/smol-rs/polling) | 3.11.0 | `Apache-2.0` |
| [polyval](https://github.com/RustCrypto/universal-hashes) | 0.6.2 | `Apache-2.0` |
| [potential_utf](https://github.com/unicode-org/icu4x) | 0.1.5 | `Unicode-3.0` |
| [powerfmt](https://github.com/jhpratt/powerfmt) | 0.2.0 | `Apache-2.0` |
| [ppv-lite86](https://github.com/cryptocorrosion/cryptocorrosion) | 0.2.21 | `Apache-2.0` |
| [precomputed-hash](https://github.com/emilio/precomputed-hash) | 0.1.1 | `MIT` |
| [proc-macro-crate](https://github.com/bkchr/proc-macro-crate) | 1.3.1 | `Apache-2.0` |
| [proc-macro-crate](https://github.com/bkchr/proc-macro-crate) | 2.0.2 | `Apache-2.0` |
| [proc-macro-crate](https://github.com/bkchr/proc-macro-crate) | 3.5.0 | `Apache-2.0` |
| [proc-macro-error](https://gitlab.com/CreepySkeleton/proc-macro-error) | 1.0.4 | `Apache-2.0` |
| [proc-macro-error-attr](https://gitlab.com/CreepySkeleton/proc-macro-error) | 1.0.4 | `Apache-2.0` |
| [proc-macro2](https://github.com/dtolnay/proc-macro2) | 1.0.106 | `Apache-2.0` |
| [provider-core](https://github.com/tobiaz/conduit) | 0.1.0 | `AGPL-3.0-only` |
| [pxfm](https://github.com/awxkee/pxfm) | 0.1.30 | `Apache-2.0` |
| [quick-error](http://github.com/tailhook/quick-error) | 2.0.1 | `Apache-2.0` |
| [quick-xml](https://github.com/tafia/quick-xml) | 0.39.4 | `MIT` |
| [quote](https://github.com/dtolnay/quote) | 1.0.45 | `Apache-2.0` |
| [rand](https://github.com/rust-random/rand) | 0.8.6 | `Apache-2.0` |
| [rand_chacha](https://github.com/rust-random/rand) | 0.3.1 | `Apache-2.0` |
| [rand_core](https://github.com/rust-random/rand) | 0.6.4 | `Apache-2.0` |
| [raw-window-handle](https://github.com/rust-windowing/raw-window-handle) | 0.6.2 | `Apache-2.0` |
| [regex](https://github.com/rust-lang/regex) | 1.12.4 | `Apache-2.0` |
| [regex-automata](https://github.com/rust-lang/regex) | 0.4.14 | `Apache-2.0` |
| [regex-syntax](https://github.com/rust-lang/regex) | 0.8.11 | `Apache-2.0` |
| [reqwest](https://github.com/seanmonstar/reqwest) | 0.12.28 | `Apache-2.0` |
| [reqwest](https://github.com/seanmonstar/reqwest) | 0.13.4 | `Apache-2.0` |
| [rfd](https://github.com/PolyMeilex/rfd) | 0.16.0 | `MIT` |
| [ring](https://github.com/briansmith/ring) | 0.17.14 | `Apache-2.0` / `ISC` |
| [rustc-hash](https://github.com/rust-lang/rustc-hash) | 2.1.2 | `Apache-2.0` |
| [rustc_version](https://github.com/djc/rustc-version-rs) | 0.4.1 | `Apache-2.0` |
| [rustix](https://github.com/bytecodealliance/rustix) | 1.1.4 | `Apache-2.0` |
| [rustls](https://github.com/rustls/rustls) | 0.23.40 | `Apache-2.0` |
| [rustls-native-certs](https://github.com/rustls/rustls-native-certs) | 0.8.4 | `Apache-2.0` |
| [rustls-pki-types](https://github.com/rustls/pki-types) | 1.14.1 | `Apache-2.0` |
| [rustls-platform-verifier](https://github.com/rustls/rustls-platform-verifier) | 0.7.0 | `Apache-2.0` |
| [rustls-webpki](https://github.com/rustls/webpki) | 0.103.13 | `ISC` |
| [ryu](https://github.com/dtolnay/ryu) | 1.0.23 | `Apache-2.0` |
| [same-file](https://github.com/BurntSushi/same-file) | 1.0.6 | `MIT` |
| [schannel](https://github.com/steffengy/schannel-rs) | 0.1.29 | `MIT` |
| [schemars](https://github.com/GREsau/schemars) | 0.8.22 | `MIT` |
| [schemars_derive](https://github.com/GREsau/schemars) | 0.8.22 | `MIT` |
| [scopeguard](https://github.com/bluss/scopeguard) | 1.2.0 | `Apache-2.0` |
| [secret-service](https://github.com/hwchen/secret-service-rs.git) | 4.0.0 | `Apache-2.0` |
| [security-framework](https://github.com/kornelski/rust-security-framework) | 3.7.0 | `Apache-2.0` |
| [security-framework-sys](https://github.com/kornelski/rust-security-framework) | 2.17.0 | `Apache-2.0` |
| [selectors](https://github.com/servo/stylo) | 0.36.1 | `MPL-2.0` |
| [semver](https://github.com/dtolnay/semver) | 1.0.28 | `Apache-2.0` |
| [serde](https://github.com/serde-rs/serde) | 1.0.228 | `Apache-2.0` |
| [serde-untagged](https://github.com/dtolnay/serde-untagged) | 0.1.9 | `Apache-2.0` |
| [serde_core](https://github.com/serde-rs/serde) | 1.0.228 | `Apache-2.0` |
| [serde_derive](https://github.com/serde-rs/serde) | 1.0.228 | `Apache-2.0` |
| [serde_derive_internals](https://github.com/serde-rs/serde) | 0.29.1 | `Apache-2.0` |
| [serde_json](https://github.com/serde-rs/json) | 1.0.150 | `Apache-2.0` |
| [serde_repr](https://github.com/dtolnay/serde-repr) | 0.1.20 | `Apache-2.0` |
| [serde_spanned](https://github.com/toml-rs/toml) | 0.6.9 | `Apache-2.0` |
| [serde_spanned](https://github.com/toml-rs/toml) | 1.1.1 | `Apache-2.0` |
| [serde_urlencoded](https://github.com/nox/serde_urlencoded) | 0.7.1 | `Apache-2.0` |
| [serde_with](https://github.com/jonasbb/serde_with/) | 3.21.0 | `Apache-2.0` |
| [serde_with_macros](https://github.com/jonasbb/serde_with/) | 3.21.0 | `Apache-2.0` |
| [serialize-to-javascript](https://github.com/chippers/serialize-to-javascript) | 0.1.2 | `Apache-2.0` |
| [serialize-to-javascript-impl](https://github.com/chippers/serialize-to-javascript) | 0.1.2 | `Apache-2.0` |
| [servo_arc](https://github.com/servo/stylo) | 0.4.3 | `Apache-2.0` |
| [sha1](https://github.com/RustCrypto/hashes) | 0.10.6 | `Apache-2.0` |
| [sha2](https://github.com/RustCrypto/hashes) | 0.10.9 | `Apache-2.0` |
| [sharded-slab](https://github.com/hawkw/sharded-slab) | 0.1.7 | `MIT` |
| [shared_child](https://github.com/oconnor663/shared_child.rs) | 1.1.1 | `MIT` |
| [shlex](https://github.com/comex/rust-shlex) | 2.0.1 | `Apache-2.0` |
| [sigchld](https://github.com/oconnor663/sigchld.rs) | 0.2.4 | `MIT` |
| [signal-hook](https://github.com/vorner/signal-hook) | 0.3.18 | `Apache-2.0` |
| [signal-hook-registry](https://github.com/vorner/signal-hook) | 1.4.8 | `Apache-2.0` |
| [simd-adler32](https://github.com/mcountryman/simd-adler32) | 0.3.9 | `MIT` |
| [siphasher](https://github.com/jedisct1/rust-siphash) | 1.0.3 | `Apache-2.0` |
| [slab](https://github.com/tokio-rs/slab) | 0.4.12 | `MIT` |
| [smallvec](https://github.com/servo/rust-smallvec) | 1.15.2 | `Apache-2.0` |
| [socket2](https://github.com/rust-lang/socket2) | 0.6.4 | `Apache-2.0` |
| [softbuffer](https://github.com/rust-windowing/softbuffer) | 0.4.8 | `Apache-2.0` |
| [soup3](https://gitlab.gnome.org/World/Rust/soup3-rs) | 0.5.0 | `MIT` |
| [soup3-sys](https://gitlab.gnome.org/World/Rust/soup3-rs) | 0.5.0 | `MIT` |
| [spin](https://github.com/mvdnes/spin-rs.git) | 0.9.8 | `MIT` |
| [sqlx](https://github.com/launchbadge/sqlx) | 0.8.6 | `Apache-2.0` |
| [sqlx-core](https://github.com/launchbadge/sqlx) | 0.8.6 | `Apache-2.0` |
| [sqlx-macros](https://github.com/launchbadge/sqlx) | 0.8.6 | `Apache-2.0` |
| [sqlx-macros-core](https://github.com/launchbadge/sqlx) | 0.8.6 | `Apache-2.0` |
| [sqlx-sqlite](https://github.com/launchbadge/sqlx) | 0.8.6 | `Apache-2.0` |
| [stable_deref_trait](https://github.com/storyyeller/stable_deref_trait) | 1.2.1 | `Apache-2.0` |
| [static_assertions](https://github.com/nvzqz/static-assertions-rs) | 1.1.0 | `Apache-2.0` |
| [string_cache](https://github.com/servo/string-cache) | 0.9.0 | `Apache-2.0` |
| [string_cache_codegen](https://github.com/servo/string-cache) | 0.6.1 | `Apache-2.0` |
| [strsim](https://github.com/rapidfuzz/strsim-rs) | 0.11.1 | `MIT` |
| [subtle](https://github.com/dalek-cryptography/subtle) | 2.6.1 | `BSD-3-Clause` |
| [swift-rs](https://github.com/Brendonovich/swift-rs) | 1.0.7 | `Apache-2.0` |
| [syn](https://github.com/dtolnay/syn) | 1.0.109 | `Apache-2.0` |
| [syn](https://github.com/dtolnay/syn) | 2.0.118 | `Apache-2.0` |
| [sync_wrapper](https://github.com/Actyx/sync_wrapper) | 1.0.2 | `Apache-2.0` |
| [synstructure](https://github.com/mystor/synstructure) | 0.13.2 | `MIT` |
| [system-deps](https://github.com/gdesmott/system-deps) | 6.2.2 | `Apache-2.0` |
| [tao](https://github.com/tauri-apps/tao) | 0.35.3 | `Apache-2.0` |
| [tar](https://github.com/composefs/tar-rs) | 0.4.46 | `Apache-2.0` |
| [target-lexicon](https://github.com/bytecodealliance/target-lexicon) | 0.12.16 | `Apache-2.0` |
| [tauri](https://github.com/tauri-apps/tauri) | 2.11.3 | `Apache-2.0` |
| [tauri-build](https://github.com/tauri-apps/tauri) | 2.6.3 | `Apache-2.0` |
| [tauri-codegen](https://github.com/tauri-apps/tauri) | 2.6.3 | `Apache-2.0` |
| [tauri-macros](https://github.com/tauri-apps/tauri) | 2.6.3 | `Apache-2.0` |
| [tauri-plugin](https://github.com/tauri-apps/tauri) | 2.6.3 | `Apache-2.0` |
| [tauri-plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | 2.7.1 | `Apache-2.0` |
| [tauri-plugin-fs](https://github.com/tauri-apps/plugins-workspace) | 2.5.1 | `Apache-2.0` |
| [tauri-plugin-shell](https://github.com/tauri-apps/plugins-workspace) | 2.3.5 | `Apache-2.0` |
| [tauri-plugin-updater](https://github.com/tauri-apps/plugins-workspace) | 2.10.1 | `Apache-2.0` |
| [tauri-runtime](https://github.com/tauri-apps/tauri) | 2.11.3 | `Apache-2.0` |
| [tauri-runtime-wry](https://github.com/tauri-apps/tauri) | 2.11.3 | `Apache-2.0` |
| [tauri-utils](https://github.com/tauri-apps/tauri) | 2.9.3 | `Apache-2.0` |
| [tauri-winres](https://github.com/tauri-apps/winres) | 0.3.6 | `MIT` |
| [tempfile](https://github.com/Stebalien/tempfile) | 3.27.0 | `Apache-2.0` |
| [tendril](https://github.com/servo/html5ever) | 0.5.0 | `Apache-2.0` |
| [termcolor](https://github.com/BurntSushi/termcolor) | 1.4.1 | `MIT` |
| [thiserror](https://github.com/dtolnay/thiserror) | 1.0.69 | `Apache-2.0` |
| [thiserror](https://github.com/dtolnay/thiserror) | 2.0.18 | `Apache-2.0` |
| [thiserror-impl](https://github.com/dtolnay/thiserror) | 1.0.69 | `Apache-2.0` |
| [thiserror-impl](https://github.com/dtolnay/thiserror) | 2.0.18 | `Apache-2.0` |
| [thread_local](https://github.com/Amanieu/thread_local-rs) | 1.1.9 | `Apache-2.0` |
| [tiff](https://github.com/image-rs/image-tiff) | 0.11.3 | `MIT` |
| [time](https://github.com/time-rs/time) | 0.3.49 | `Apache-2.0` |
| [time-core](https://github.com/time-rs/time) | 0.1.9 | `Apache-2.0` |
| [time-macros](https://github.com/time-rs/time) | 0.2.29 | `Apache-2.0` |
| [tinystr](https://github.com/unicode-org/icu4x) | 0.8.3 | `Unicode-3.0` |
| [tokio](https://github.com/tokio-rs/tokio) | 1.52.3 | `MIT` |
| [tokio-macros](https://github.com/tokio-rs/tokio) | 2.7.0 | `MIT` |
| [tokio-rustls](https://github.com/rustls/tokio-rustls) | 0.26.4 | `Apache-2.0` |
| [tokio-stream](https://github.com/tokio-rs/tokio) | 0.1.18 | `MIT` |
| [tokio-util](https://github.com/tokio-rs/tokio) | 0.7.18 | `MIT` |
| [toml](https://github.com/toml-rs/toml) | 0.8.2 | `Apache-2.0` |
| [toml](https://github.com/toml-rs/toml) | 0.9.12+spec-1.1.0 | `Apache-2.0` |
| [toml](https://github.com/toml-rs/toml) | 1.1.2+spec-1.1.0 | `Apache-2.0` |
| [toml_datetime](https://github.com/toml-rs/toml) | 0.6.3 | `Apache-2.0` |
| [toml_datetime](https://github.com/toml-rs/toml) | 0.7.5+spec-1.1.0 | `Apache-2.0` |
| [toml_datetime](https://github.com/toml-rs/toml) | 1.1.1+spec-1.1.0 | `Apache-2.0` |
| [toml_edit](https://github.com/toml-rs/toml) | 0.19.15 | `Apache-2.0` |
| [toml_edit](https://github.com/toml-rs/toml) | 0.20.2 | `Apache-2.0` |
| [toml_edit](https://github.com/toml-rs/toml) | 0.25.12+spec-1.1.0 | `Apache-2.0` |
| [toml_parser](https://github.com/toml-rs/toml) | 1.1.2+spec-1.1.0 | `Apache-2.0` |
| [toml_writer](https://github.com/toml-rs/toml) | 1.1.1+spec-1.1.0 | `Apache-2.0` |
| [tower](https://github.com/tower-rs/tower) | 0.5.3 | `MIT` |
| [tower-http](https://github.com/tower-rs/tower-http) | 0.6.11 | `MIT` |
| [tower-layer](https://github.com/tower-rs/tower) | 0.3.3 | `MIT` |
| [tower-service](https://github.com/tower-rs/tower) | 0.3.3 | `MIT` |
| [tracing](https://github.com/tokio-rs/tracing) | 0.1.44 | `MIT` |
| [tracing-attributes](https://github.com/tokio-rs/tracing) | 0.1.31 | `MIT` |
| [tracing-core](https://github.com/tokio-rs/tracing) | 0.1.36 | `MIT` |
| [tracing-log](https://github.com/tokio-rs/tracing) | 0.2.0 | `MIT` |
| [tracing-subscriber](https://github.com/tokio-rs/tracing) | 0.3.23 | `MIT` |
| [try-lock](https://github.com/seanmonstar/try-lock) | 0.2.5 | `MIT` |
| [ts-rs](https://github.com/Aleph-Alpha/ts-rs) | 10.1.0 | `MIT` |
| [ts-rs-macros](https://github.com/Aleph-Alpha/ts-rs) | 10.1.0 | `MIT` |
| [typeid](https://github.com/dtolnay/typeid) | 1.0.3 | `Apache-2.0` |
| [typenum](https://github.com/paholg/typenum) | 1.20.1 | `Apache-2.0` |
| [uds_windows](https://github.com/haraldh/rust_uds_windows) | 1.2.1 | `MIT` |
| [unic-char-property](https://github.com/open-i18n/rust-unic/) | 0.9.0 | `Apache-2.0` |
| [unic-char-range](https://github.com/open-i18n/rust-unic/) | 0.9.0 | `Apache-2.0` |
| [unic-common](https://github.com/open-i18n/rust-unic/) | 0.9.0 | `Apache-2.0` |
| [unic-ucd-ident](https://github.com/open-i18n/rust-unic/) | 0.9.0 | `Apache-2.0` |
| [unic-ucd-version](https://github.com/open-i18n/rust-unic/) | 0.9.0 | `Apache-2.0` |
| [unicode-ident](https://github.com/dtolnay/unicode-ident) | 1.0.24 | `Apache-2.0` / `Unicode-3.0` |
| [unicode-segmentation](https://github.com/unicode-rs/unicode-segmentation) | 1.13.3 | `Apache-2.0` |
| [universal-hash](https://github.com/RustCrypto/traits) | 0.5.1 | `Apache-2.0` |
| [untrusted](https://github.com/briansmith/untrusted) | 0.9.0 | `ISC` |
| [url](https://github.com/servo/rust-url) | 2.5.8 | `Apache-2.0` |
| [urlpattern](https://github.com/denoland/rust-urlpattern) | 0.3.0 | `MIT` |
| [utf-8](https://github.com/SimonSapin/rust-utf8) | 0.7.6 | `Apache-2.0` |
| [utf8_iter](https://github.com/hsivonen/utf8_iter) | 1.0.4 | `Apache-2.0` |
| [uuid](https://github.com/uuid-rs/uuid) | 1.23.3 | `Apache-2.0` |
| [vcpkg](https://github.com/mcgoo/vcpkg-rs) | 0.2.15 | `Apache-2.0` |
| [version-compare](https://gitlab.com/timvisee/version-compare) | 0.2.1 | `MIT` |
| [version_check](https://github.com/SergioBenitez/version_check) | 0.9.5 | `Apache-2.0` |
| [vswhom](https://github.com/nabijaczleweli/vswhom.rs) | 0.1.0 | `MIT` |
| [vswhom-sys](https://github.com/nabijaczleweli/vswhom-sys.rs) | 0.1.3 | `MIT` |
| [walkdir](https://github.com/BurntSushi/walkdir) | 2.5.0 | `MIT` |
| [want](https://github.com/seanmonstar/want) | 0.3.1 | `MIT` |
| [web_atoms](https://github.com/servo/html5ever) | 0.2.5 | `Apache-2.0` |
| [webkit2gtk](https://github.com/tauri-apps/webkit2gtk-rs) | 2.0.2 | `MIT` |
| [webkit2gtk-sys](https://github.com/tauri-apps/webkit2gtk-rs) | 2.0.2 | `MIT` |
| [webpki-roots](https://github.com/rustls/webpki-roots) | 1.0.8 | `CDLA-Permissive-2.0` |
| [webview2-com](https://github.com/wravery/webview2-rs) | 0.38.2 | `MIT` |
| [webview2-com-macros](https://github.com/wravery/webview2-rs) | 0.8.1 | `MIT` |
| [webview2-com-sys](https://github.com/wravery/webview2-rs) | 0.38.2 | `MIT` |
| [weezl](https://github.com/image-rs/weezl) | 0.1.12 | `Apache-2.0` |
| [winapi](https://github.com/retep998/winapi-rs) | 0.3.9 | `Apache-2.0` |
| [winapi-util](https://github.com/BurntSushi/winapi-util) | 0.1.11 | `MIT` |
| [window-vibrancy](https://github.com/tauri-apps/tauri-plugin-vibrancy) | 0.6.0 | `Apache-2.0` |
| [windows](https://github.com/microsoft/windows-rs) | 0.61.3 | `Apache-2.0` |
| [windows-collections](https://github.com/microsoft/windows-rs) | 0.2.0 | `Apache-2.0` |
| [windows-core](https://github.com/microsoft/windows-rs) | 0.61.2 | `Apache-2.0` |
| [windows-core](https://github.com/microsoft/windows-rs) | 0.62.2 | `Apache-2.0` |
| [windows-future](https://github.com/microsoft/windows-rs) | 0.2.1 | `Apache-2.0` |
| [windows-implement](https://github.com/microsoft/windows-rs) | 0.60.2 | `Apache-2.0` |
| [windows-interface](https://github.com/microsoft/windows-rs) | 0.59.3 | `Apache-2.0` |
| [windows-link](https://github.com/microsoft/windows-rs) | 0.1.3 | `Apache-2.0` |
| [windows-link](https://github.com/microsoft/windows-rs) | 0.2.1 | `Apache-2.0` |
| [windows-numerics](https://github.com/microsoft/windows-rs) | 0.2.0 | `Apache-2.0` |
| [windows-result](https://github.com/microsoft/windows-rs) | 0.3.4 | `Apache-2.0` |
| [windows-result](https://github.com/microsoft/windows-rs) | 0.4.1 | `Apache-2.0` |
| [windows-strings](https://github.com/microsoft/windows-rs) | 0.4.2 | `Apache-2.0` |
| [windows-strings](https://github.com/microsoft/windows-rs) | 0.5.1 | `Apache-2.0` |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.52.0 | `Apache-2.0` |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.59.0 | `Apache-2.0` |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.60.2 | `Apache-2.0` |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.61.2 | `Apache-2.0` |
| [windows-targets](https://github.com/microsoft/windows-rs) | 0.52.6 | `Apache-2.0` |
| [windows-targets](https://github.com/microsoft/windows-rs) | 0.53.5 | `Apache-2.0` |
| [windows-threading](https://github.com/microsoft/windows-rs) | 0.1.0 | `Apache-2.0` |
| [windows-version](https://github.com/microsoft/windows-rs) | 0.1.7 | `Apache-2.0` |
| [windows_x86_64_gnu](https://github.com/microsoft/windows-rs) | 0.52.6 | `Apache-2.0` |
| [windows_x86_64_gnu](https://github.com/microsoft/windows-rs) | 0.53.1 | `Apache-2.0` |
| [windows_x86_64_msvc](https://github.com/microsoft/windows-rs) | 0.52.6 | `Apache-2.0` |
| [windows_x86_64_msvc](https://github.com/microsoft/windows-rs) | 0.53.1 | `Apache-2.0` |
| [winnow](https://github.com/winnow-rs/winnow) | 0.5.40 | `MIT` |
| [winnow](https://github.com/winnow-rs/winnow) | 0.7.15 | `MIT` |
| [winnow](https://github.com/winnow-rs/winnow) | 1.0.3 | `MIT` |
| [winreg](https://github.com/gentoo90/winreg-rs) | 0.55.0 | `MIT` |
| [writeable](https://github.com/unicode-org/icu4x) | 0.6.3 | `Unicode-3.0` |
| [wry](https://github.com/tauri-apps/wry) | 0.55.1 | `Apache-2.0` |
| [x11](https://github.com/AltF02/x11-rs.git) | 2.21.0 | `MIT` |
| [x11-dl](https://github.com/AltF02/x11-rs.git) | 2.21.0 | `MIT` |
| [x11rb](https://github.com/psychon/x11rb) | 0.13.2 | `Apache-2.0` |
| [x11rb-protocol](https://github.com/psychon/x11rb) | 0.13.2 | `Apache-2.0` |
| [xattr](https://github.com/Stebalien/xattr) | 1.6.1 | `Apache-2.0` |
| [xdg-home](https://github.com/zeenix/xdg-home) | 1.3.0 | `MIT` |
| [yoke](https://github.com/unicode-org/icu4x) | 0.8.3 | `Unicode-3.0` |
| [yoke-derive](https://github.com/unicode-org/icu4x) | 0.8.2 | `Unicode-3.0` |
| [zbus](https://github.com/dbus2/zbus/) | 4.4.0 | `MIT` |
| [zbus_macros](https://github.com/dbus2/zbus/) | 4.4.0 | `MIT` |
| [zbus_names](https://github.com/dbus2/zbus/) | 3.0.0 | `MIT` |
| [zerocopy](https://github.com/google/zerocopy) | 0.8.52 | `Apache-2.0` |
| [zerocopy-derive](https://github.com/google/zerocopy) | 0.8.52 | `Apache-2.0` |
| [zerofrom](https://github.com/unicode-org/icu4x) | 0.1.8 | `Unicode-3.0` |
| [zerofrom-derive](https://github.com/unicode-org/icu4x) | 0.1.7 | `Unicode-3.0` |
| [zeroize](https://github.com/RustCrypto/utils) | 1.9.0 | `Apache-2.0` |
| [zeroize_derive](https://github.com/RustCrypto/utils) | 1.5.0 | `Apache-2.0` |
| [zerotrie](https://github.com/unicode-org/icu4x) | 0.2.4 | `Unicode-3.0` |
| [zerovec](https://github.com/unicode-org/icu4x) | 0.11.6 | `Unicode-3.0` |
| [zerovec-derive](https://github.com/unicode-org/icu4x) | 0.11.3 | `Unicode-3.0` |
| [zip](https://github.com/zip-rs/zip2.git) | 4.6.1 | `MIT` |
| [zmij](https://github.com/dtolnay/zmij) | 1.0.21 | `MIT` |
| [zune-core](https://github.com/etemesi254/zune-image) | 0.5.1 | `Apache-2.0` |
| [zune-jpeg](https://github.com/etemesi254/zune-image/tree/dev/crates/zune-jpeg) | 0.5.15 | `Apache-2.0` |
| [zvariant](https://github.com/dbus2/zbus/) | 4.2.0 | `MIT` |
| [zvariant_derive](https://github.com/dbus2/zbus/) | 4.2.0 | `MIT` |
| [zvariant_utils](https://github.com/dbus2/zbus/) | 2.1.0 | `MIT` |

### License texts

Each distinct license text appears once.

<details>
<summary><strong>Apache License 2.0</strong> (<code>Apache-2.0</code>)</summary>

```text
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2023 Jacob Pratt et al.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

</details>

<details>
<summary><strong>MIT License</strong> (<code>MIT</code>)</summary>

```text
MIT License

    Copyright (c) Microsoft Corporation. All rights reserved.

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE
```

</details>

<details>
<summary><strong>Unicode License v3</strong> (<code>Unicode-3.0</code>)</summary>

```text
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2023 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

</details>

<details>
<summary><strong>BSD 3-Clause "New" or "Revised" License</strong> (<code>BSD-3-Clause</code>)</summary>

```text
Copyright (c) 2016 Dropbox, Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

</details>

<details>
<summary><strong>Mozilla Public License 2.0</strong> (<code>MPL-2.0</code>)</summary>

```text
Mozilla Public License Version 2.0
==================================

1. Definitions
--------------

1.1. "Contributor"
    means each individual or legal entity that creates, contributes to
    the creation of, or owns Covered Software.

1.2. "Contributor Version"
    means the combination of the Contributions of others (if any) used
    by a Contributor and that particular Contributor's Contribution.

1.3. "Contribution"
    means Covered Software of a particular Contributor.

1.4. "Covered Software"
    means Source Code Form to which the initial Contributor has attached
    the notice in Exhibit A, the Executable Form of such Source Code
    Form, and Modifications of such Source Code Form, in each case
    including portions thereof.

1.5. "Incompatible With Secondary Licenses"
    means

    (a) that the initial Contributor has attached the notice described
        in Exhibit B to the Covered Software; or

    (b) that the Covered Software was made available under the terms of
        version 1.1 or earlier of the License, but not also under the
        terms of a Secondary License.

1.6. "Executable Form"
    means any form of the work other than Source Code Form.

1.7. "Larger Work"
    means a work that combines Covered Software with other material, in
    a separate file or files, that is not Covered Software.

1.8. "License"
    means this document.

1.9. "Licensable"
    means having the right to grant, to the maximum extent possible,
    whether at the time of the initial grant or subsequently, any and
    all of the rights conveyed by this License.

1.10. "Modifications"
    means any of the following:

    (a) any file in Source Code Form that results from an addition to,
        deletion from, or modification of the contents of Covered
        Software; or

    (b) any new file in Source Code Form that contains any Covered
        Software.

1.11. "Patent Claims" of a Contributor
    means any patent claim(s), including without limitation, method,
    process, and apparatus claims, in any patent Licensable by such
    Contributor that would be infringed, but for the grant of the
    License, by the making, using, selling, offering for sale, having
    made, import, or transfer of either its Contributions or its
    Contributor Version.

1.12. "Secondary License"
    means either the GNU General Public License, Version 2.0, the GNU
    Lesser General Public License, Version 2.1, the GNU Affero General
    Public License, Version 3.0, or any later versions of those
    licenses.

1.13. "Source Code Form"
    means the form of the work preferred for making modifications.

1.14. "You" (or "Your")
    means an individual or a legal entity exercising rights under this
    License. For legal entities, "You" includes any entity that
    controls, is controlled by, or is under common control with You. For
    purposes of this definition, "control" means (a) the power, direct
    or indirect, to cause the direction or management of such entity,
    whether by contract or otherwise, or (b) ownership of more than
    fifty percent (50%) of the outstanding shares or beneficial
    ownership of such entity.

2. License Grants and Conditions
--------------------------------

2.1. Grants

Each Contributor hereby grants You a world-wide, royalty-free,
non-exclusive license:

(a) under intellectual property rights (other than patent or trademark)
    Licensable by such Contributor to use, reproduce, make available,
    modify, display, perform, distribute, and otherwise exploit its
    Contributions, either on an unmodified basis, with Modifications, or
    as part of a Larger Work; and

(b) under Patent Claims of such Contributor to make, use, sell, offer
    for sale, have made, import, and otherwise transfer either its
    Contributions or its Contributor Version.

2.2. Effective Date

The licenses granted in Section 2.1 with respect to any Contribution
become effective for each Contribution on the date the Contributor first
distributes such Contribution.

2.3. Limitations on Grant Scope

The licenses granted in this Section 2 are the only rights granted under
this License. No additional rights or licenses will be implied from the
distribution or licensing of Covered Software under this License.
Notwithstanding Section 2.1(b) above, no patent license is granted by a
Contributor:

(a) for any code that a Contributor has removed from Covered Software;
    or

(b) for infringements caused by: (i) Your and any other third party's
    modifications of Covered Software, or (ii) the combination of its
    Contributions with other software (except as part of its Contributor
    Version); or

(c) under Patent Claims infringed by Covered Software in the absence of
    its Contributions.

This License does not grant any rights in the trademarks, service marks,
or logos of any Contributor (except as may be necessary to comply with
the notice requirements in Section 3.4).

2.4. Subsequent Licenses

No Contributor makes additional grants as a result of Your choice to
distribute the Covered Software under a subsequent version of this
License (see Section 10.2) or under the terms of a Secondary License (if
permitted under the terms of Section 3.3).

2.5. Representation

Each Contributor represents that the Contributor believes its
Contributions are its original creation(s) or it has sufficient rights
to grant the rights to its Contributions conveyed by this License.

2.6. Fair Use

This License is not intended to limit any rights You have under
applicable copyright doctrines of fair use, fair dealing, or other
equivalents.

2.7. Conditions

Sections 3.1, 3.2, 3.3, and 3.4 are conditions of the licenses granted
in Section 2.1.

3. Responsibilities
-------------------

3.1. Distribution of Source Form

All distribution of Covered Software in Source Code Form, including any
Modifications that You create or to which You contribute, must be under
the terms of this License. You must inform recipients that the Source
Code Form of the Covered Software is governed by the terms of this
License, and how they can obtain a copy of this License. You may not
attempt to alter or restrict the recipients' rights in the Source Code
Form.

3.2. Distribution of Executable Form

If You distribute Covered Software in Executable Form then:

(a) such Covered Software must also be made available in Source Code
    Form, as described in Section 3.1, and You must inform recipients of
    the Executable Form how they can obtain a copy of such Source Code
    Form by reasonable means in a timely manner, at a charge no more
    than the cost of distribution to the recipient; and

(b) You may distribute such Executable Form under the terms of this
    License, or sublicense it under different terms, provided that the
    license for the Executable Form does not attempt to limit or alter
    the recipients' rights in the Source Code Form under this License.

3.3. Distribution of a Larger Work

You may create and distribute a Larger Work under terms of Your choice,
provided that You also comply with the requirements of this License for
the Covered Software. If the Larger Work is a combination of Covered
Software with a work governed by one or more Secondary Licenses, and the
Covered Software is not Incompatible With Secondary Licenses, this
License permits You to additionally distribute such Covered Software
under the terms of such Secondary License(s), so that the recipient of
the Larger Work may, at their option, further distribute the Covered
Software under the terms of either this License or such Secondary
License(s).

3.4. Notices

You may not remove or alter the substance of any license notices
(including copyright notices, patent notices, disclaimers of warranty,
or limitations of liability) contained within the Source Code Form of
the Covered Software, except that You may alter any license notices to
the extent required to remedy known factual inaccuracies.

3.5. Application of Additional Terms

You may choose to offer, and to charge a fee for, warranty, support,
indemnity or liability obligations to one or more recipients of Covered
Software. However, You may do so only on Your own behalf, and not on
behalf of any Contributor. You must make it absolutely clear that any
such warranty, support, indemnity, or liability obligation is offered by
You alone, and You hereby agree to indemnify every Contributor for any
liability incurred by such Contributor as a result of warranty, support,
indemnity or liability terms You offer. You may include additional
disclaimers of warranty and limitations of liability specific to any
jurisdiction.

4. Inability to Comply Due to Statute or Regulation
---------------------------------------------------

If it is impossible for You to comply with any of the terms of this
License with respect to some or all of the Covered Software due to
statute, judicial order, or regulation then You must: (a) comply with
the terms of this License to the maximum extent possible; and (b)
describe the limitations and the code they affect. Such description must
be placed in a text file included with all distributions of the Covered
Software under this License. Except to the extent prohibited by statute
or regulation, such description must be sufficiently detailed for a
recipient of ordinary skill to be able to understand it.

5. Termination
--------------

5.1. The rights granted under this License will terminate automatically
if You fail to comply with any of its terms. However, if You become
compliant, then the rights granted under this License from a particular
Contributor are reinstated (a) provisionally, unless and until such
Contributor explicitly and finally terminates Your grants, and (b) on an
ongoing basis, if such Contributor fails to notify You of the
non-compliance by some reasonable means prior to 60 days after You have
come back into compliance. Moreover, Your grants from a particular
Contributor are reinstated on an ongoing basis if such Contributor
notifies You of the non-compliance by some reasonable means, this is the
first time You have received notice of non-compliance with this License
from such Contributor, and You become compliant prior to 30 days after
Your receipt of the notice.

5.2. If You initiate litigation against any entity by asserting a patent
infringement claim (excluding declaratory judgment actions,
counter-claims, and cross-claims) alleging that a Contributor Version
directly or indirectly infringes any patent, then the rights granted to
You by any and all Contributors for the Covered Software under Section
2.1 of this License shall terminate.

5.3. In the event of termination under Sections 5.1 or 5.2 above, all
end user license agreements (excluding distributors and resellers) which
have been validly granted by You or Your distributors under this License
prior to termination shall survive termination.

************************************************************************
*                                                                      *
*  6. Disclaimer of Warranty                                           *
*  -------------------------                                           *
*                                                                      *
*  Covered Software is provided under this License on an "as is"       *
*  basis, without warranty of any kind, either expressed, implied, or  *
*  statutory, including, without limitation, warranties that the       *
*  Covered Software is free of defects, merchantable, fit for a        *
*  particular purpose or non-infringing. The entire risk as to the     *
*  quality and performance of the Covered Software is with You.        *
*  Should any Covered Software prove defective in any respect, You     *
*  (not any Contributor) assume the cost of any necessary servicing,   *
*  repair, or correction. This disclaimer of warranty constitutes an   *
*  essential part of this License. No use of any Covered Software is   *
*  authorized under this License except under this disclaimer.         *
*                                                                      *
************************************************************************

************************************************************************
*                                                                      *
*  7. Limitation of Liability                                          *
*  --------------------------                                          *
*                                                                      *
*  Under no circumstances and under no legal theory, whether tort      *
*  (including negligence), contract, or otherwise, shall any           *
*  Contributor, or anyone who distributes Covered Software as          *
*  permitted above, be liable to You for any direct, indirect,         *
*  special, incidental, or consequential damages of any character      *
*  including, without limitation, damages for lost profits, loss of    *
*  goodwill, work stoppage, computer failure or malfunction, or any    *
*  and all other commercial damages or losses, even if such party      *
*  shall have been informed of the possibility of such damages. This   *
*  limitation of liability shall not apply to liability for death or   *
*  personal injury resulting from such party's negligence to the       *
*  extent applicable law prohibits such limitation. Some               *
*  jurisdictions do not allow the exclusion or limitation of           *
*  incidental or consequential damages, so this exclusion and          *
*  limitation may not apply to You.                                    *
*                                                                      *
************************************************************************

8. Litigation
-------------

Any litigation relating to this License may be brought only in the
courts of a jurisdiction where the defendant maintains its principal
place of business and such litigation shall be governed by laws of that
jurisdiction, without reference to its conflict-of-law provisions.
Nothing in this Section shall prevent a party's ability to bring
cross-claims or counter-claims.

9. Miscellaneous
----------------

This License represents the complete agreement concerning the subject
matter hereof. If any provision of this License is held to be
unenforceable, such provision shall be reformed only to the extent
necessary to make it enforceable. Any law or regulation which provides
that the language of a contract shall be construed against the drafter
shall not be used to construe this License against a Contributor.

10. Versions of the License
---------------------------

10.1. New Versions

Mozilla Foundation is the license steward. Except as provided in Section
10.3, no one other than the license steward has the right to modify or
publish new versions of this License. Each version will be given a
distinguishing version number.

10.2. Effect of New Versions

You may distribute the Covered Software under the terms of the version
of the License under which You originally received the Covered Software,
or under the terms of any subsequent version published by the license
steward.

10.3. Modified Versions

If you create software not governed by this License, and you want to
create a new license for such software, you may create and use a
modified version of this License if you rename the license and remove
any references to the name of the license steward (except to note that
such modified license differs from this License).

10.4. Distributing Source Code Form that is Incompatible With Secondary
Licenses

If You choose to distribute Source Code Form that is Incompatible With
Secondary Licenses under the terms of this version of the License, the
notice described in Exhibit B of this License must be attached.

Exhibit A - Source Code Form License Notice
-------------------------------------------

  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at http://mozilla.org/MPL/2.0/.

If it is not possible or desirable to put the notice in a particular
file, then You may include the notice in a location (such as a LICENSE
file in a relevant directory) where a recipient would be likely to look
for such a notice.

You may add additional accurate notices of copyright ownership.

Exhibit B - "Incompatible With Secondary Licenses" Notice
---------------------------------------------------------

  This Source Code Form is "Incompatible With Secondary Licenses", as
  defined by the Mozilla Public License, v. 2.0.
```

</details>

<details>
<summary><strong>GNU Affero General Public License v3.0 only</strong> (<code>AGPL-3.0-only</code>)</summary>

```text
GNU AFFERO GENERAL PUBLIC LICENSE
Version 3, 19 November 2007

Copyright (C) 2007 Free Software Foundation, Inc. <http://fsf.org/>

Everyone is permitted to copy and distribute verbatim copies of this license document, but changing it is not allowed.

                            Preamble

The GNU Affero General Public License is a free, copyleft license for software and other kinds of works, specifically designed to ensure cooperation with the community in the case of network server software.

The licenses for most software and other practical works are designed to take away your freedom to share and change the works.  By contrast, our General Public Licenses are intended to guarantee your freedom to share and change all versions of a program--to make sure it remains free software for all its users.

When we speak of free software, we are referring to freedom, not price.  Our General Public Licenses are designed to make sure that you have the freedom to distribute copies of free software (and charge for them if you wish), that you receive source code or can get it if you want it, that you can change the software or use pieces of it in new free programs, and that you know you can do these things.

Developers that use our General Public Licenses protect your rights with two steps: (1) assert copyright on the software, and (2) offer you this License which gives you legal permission to copy, distribute and/or modify the software.

A secondary benefit of defending all users' freedom is that improvements made in alternate versions of the program, if they receive widespread use, become available for other developers to incorporate.  Many developers of free software are heartened and encouraged by the resulting cooperation.  However, in the case of software used on network servers, this result may fail to come about. The GNU General Public License permits making a modified version and letting the public access it on a server without ever releasing its source code to the public.

The GNU Affero General Public License is designed specifically to ensure that, in such cases, the modified source code becomes available to the community.  It requires the operator of a network server to provide the source code of the modified version running there to the users of that server.  Therefore, public use of a modified version, on a publicly accessible server, gives the public access to the source code of the modified version.

An older license, called the Affero General Public License and published by Affero, was designed to accomplish similar goals.  This is a different license, not a version of the Affero GPL, but Affero has released a new version of the Affero GPL which permits relicensing under this license.

The precise terms and conditions for copying, distribution and modification follow.

                       TERMS AND CONDITIONS

0. Definitions.

"This License" refers to version 3 of the GNU Affero General Public License.

"Copyright" also means copyright-like laws that apply to other kinds of works, such as semiconductor masks.

"The Program" refers to any copyrightable work licensed under this License.  Each licensee is addressed as "you".  "Licensees" and "recipients" may be individuals or organizations.

To "modify" a work means to copy from or adapt all or part of the work in a fashion requiring copyright permission, other than the making of an exact copy.  The resulting work is called a "modified version" of the earlier work or a work "based on" the earlier work.

A "covered work" means either the unmodified Program or a work based on the Program.

To "propagate" a work means to do anything with it that, without permission, would make you directly or secondarily liable for infringement under applicable copyright law, except executing it on a computer or modifying a private copy.  Propagation includes copying, distribution (with or without modification), making available to the public, and in some countries other activities as well.

To "convey" a work means any kind of propagation that enables other parties to make or receive copies.  Mere interaction with a user through a computer network, with no transfer of a copy, is not conveying.

An interactive user interface displays "Appropriate Legal Notices" to the extent that it includes a convenient and prominently visible feature that (1) displays an appropriate copyright notice, and (2) tells the user that there is no warranty for the work (except to the extent that warranties are provided), that licensees may convey the work under this License, and how to view a copy of this License.  If the interface presents a list of user commands or options, such as a menu, a prominent item in the list meets this criterion.

1. Source Code.
The "source code" for a work means the preferred form of the work for making modifications to it.  "Object code" means any non-source form of a work.

A "Standard Interface" means an interface that either is an official standard defined by a recognized standards body, or, in the case of interfaces specified for a particular programming language, one that is widely used among developers working in that language.

The "System Libraries" of an executable work include anything, other than the work as a whole, that (a) is included in the normal form of packaging a Major Component, but which is not part of that Major Component, and (b) serves only to enable use of the work with that Major Component, or to implement a Standard Interface for which an implementation is available to the public in source code form.  A "Major Component", in this context, means a major essential component (kernel, window system, and so on) of the specific operating system (if any) on which the executable work runs, or a compiler used to produce the work, or an object code interpreter used to run it.

The "Corresponding Source" for a work in object code form means all the source code needed to generate, install, and (for an executable work) run the object code and to modify the work, including scripts to control those activities.  However, it does not include the work's System Libraries, or general-purpose tools or generally available free programs which are used unmodified in performing those activities but which are not part of the work.  For example, Corresponding Source includes interface definition files associated with source files for the work, and the source code for shared libraries and dynamically linked subprograms that the work is specifically designed to require, such as by intimate data communication or control flow between those
subprograms and other parts of the work.

The Corresponding Source need not include anything that users can regenerate automatically from other parts of the Corresponding Source.

The Corresponding Source for a work in source code form is that same work.

2. Basic Permissions.
All rights granted under this License are granted for the term of copyright on the Program, and are irrevocable provided the stated conditions are met.  This License explicitly affirms your unlimited permission to run the unmodified Program.  The output from running a covered work is covered by this License only if the output, given its content, constitutes a covered work.  This License acknowledges your rights of fair use or other equivalent, as provided by copyright law.

You may make, run and propagate covered works that you do not convey, without conditions so long as your license otherwise remains in force.  You may convey covered works to others for the sole purpose of having them make modifications exclusively for you, or provide you with facilities for running those works, provided that you comply with the terms of this License in conveying all material for which you do not control copyright.  Those thus making or running the covered works for you must do so exclusively on your behalf, under your direction and control, on terms that prohibit them from making any copies of your copyrighted material outside their relationship with you.

Conveying under any other circumstances is permitted solely under the conditions stated below.  Sublicensing is not allowed; section 10 makes it unnecessary.

3. Protecting Users' Legal Rights From Anti-Circumvention Law.
No covered work shall be deemed part of an effective technological measure under any applicable law fulfilling obligations under article 11 of the WIPO copyright treaty adopted on 20 December 1996, or similar laws prohibiting or restricting circumvention of such measures.

When you convey a covered work, you waive any legal power to forbid circumvention of technological measures to the extent such circumvention is effected by exercising rights under this License with respect to the covered work, and you disclaim any intention to limit operation or modification of the work as a means of enforcing, against the work's users, your or third parties' legal rights to forbid circumvention of technological measures.

4. Conveying Verbatim Copies.
You may convey verbatim copies of the Program's source code as you receive it, in any medium, provided that you conspicuously and appropriately publish on each copy an appropriate copyright notice; keep intact all notices stating that this License and any non-permissive terms added in accord with section 7 apply to the code; keep intact all notices of the absence of any warranty; and give all recipients a copy of this License along with the Program.

You may charge any price or no price for each copy that you convey, and you may offer support or warranty protection for a fee.

5. Conveying Modified Source Versions.
You may convey a work based on the Program, or the modifications to produce it from the Program, in the form of source code under the terms of section 4, provided that you also meet all of these conditions:

    a) The work must carry prominent notices stating that you modified it, and giving a relevant date.

    b) The work must carry prominent notices stating that it is released under this License and any conditions added under section 7.  This requirement modifies the requirement in section 4 to "keep intact all notices".

    c) You must license the entire work, as a whole, under this License to anyone who comes into possession of a copy.  This License will therefore apply, along with any applicable section 7 additional terms, to the whole of the work, and all its parts, regardless of how they are packaged.  This License gives no permission to license the work in any other way, but it does not invalidate such permission if you have separately received it.

    d) If the work has interactive user interfaces, each must display Appropriate Legal Notices; however, if the Program has interactive interfaces that do not display Appropriate Legal Notices, your work need not make them do so.

A compilation of a covered work with other separate and independent works, which are not by their nature extensions of the covered work, and which are not combined with it such as to form a larger program, in or on a volume of a storage or distribution medium, is called an "aggregate" if the compilation and its resulting copyright are not used to limit the access or legal rights of the compilation's users beyond what the individual works permit.  Inclusion of a covered work in an aggregate does not cause this License to apply to the other parts of the aggregate.

6. Conveying Non-Source Forms.
You may convey a covered work in object code form under the terms of sections 4 and 5, provided that you also convey the machine-readable Corresponding Source under the terms of this License, in one of these ways:

    a) Convey the object code in, or embodied in, a physical product (including a physical distribution medium), accompanied by the Corresponding Source fixed on a durable physical medium customarily used for software interchange.

    b) Convey the object code in, or embodied in, a physical product (including a physical distribution medium), accompanied by a written offer, valid for at least three years and valid for as long as you offer spare parts or customer support for that product model, to give anyone who possesses the object code either (1) a copy of the Corresponding Source for all the software in the product that is covered by this License, on a durable physical medium customarily used for software interchange, for a price no more than your reasonable cost of physically performing this conveying of source, or (2) access to copy the Corresponding Source from a network server at no charge.

    c) Convey individual copies of the object code with a copy of the written offer to provide the Corresponding Source.  This alternative is allowed only occasionally and noncommercially, and only if you received the object code with such an offer, in accord with subsection 6b.

    d) Convey the object code by offering access from a designated place (gratis or for a charge), and offer equivalent access to the Corresponding Source in the same way through the same place at no further charge.  You need not require recipients to copy the Corresponding Source along with the object code.  If the place to copy the object code is a network server, the Corresponding Source may be on a different server (operated by you or a third party) that supports equivalent copying facilities, provided you maintain clear directions next to the object code saying where to find the Corresponding Source.  Regardless of what server hosts the Corresponding Source, you remain obligated to ensure that it is available for as long as needed to satisfy these requirements.

    e) Convey the object code using peer-to-peer transmission, provided you inform other peers where the object code and Corresponding Source of the work are being offered to the general public at no charge under subsection 6d.

A separable portion of the object code, whose source code is excluded from the Corresponding Source as a System Library, need not be included in conveying the object code work.

A "User Product" is either (1) a "consumer product", which means any tangible personal property which is normally used for personal, family, or household purposes, or (2) anything designed or sold for incorporation into a dwelling.  In determining whether a product is a consumer product, doubtful cases shall be resolved in favor of coverage.  For a particular product received by a particular user, "normally used" refers to a typical or common use of that class of product, regardless of the status of the particular user or of the way in which the particular user actually uses, or expects or is expected to use, the product.  A product is a consumer product regardless of whether the product has substantial commercial, industrial or non-consumer uses, unless such uses represent the only significant mode of use of the product.

"Installation Information" for a User Product means any methods, procedures, authorization keys, or other information required to install and execute modified versions of a covered work in that User Product from a modified version of its Corresponding Source.  The information must suffice to ensure that the continued functioning of the modified object code is in no case prevented or interfered with solely because modification has been made.

If you convey an object code work under this section in, or with, or specifically for use in, a User Product, and the conveying occurs as part of a transaction in which the right of possession and use of the User Product is transferred to the recipient in perpetuity or for a fixed term (regardless of how the transaction is characterized), the Corresponding Source conveyed under this section must be accompanied by the Installation Information.  But this requirement does not apply if neither you nor any third party retains the ability to install modified object code on the User Product (for example, the work has been installed in ROM).

The requirement to provide Installation Information does not include a requirement to continue to provide support service, warranty, or updates for a work that has been modified or installed by the recipient, or for the User Product in which it has been modified or installed.  Access to a network may be denied when the modification itself materially and adversely affects the operation of the network or violates the rules and protocols for communication across the network.

Corresponding Source conveyed, and Installation Information provided, in accord with this section must be in a format that is publicly documented (and with an implementation available to the public in source code form), and must require no special password or key for unpacking, reading or copying.

7. Additional Terms.
"Additional permissions" are terms that supplement the terms of this License by making exceptions from one or more of its conditions. Additional permissions that are applicable to the entire Program shall be treated as though they were included in this License, to the extent that they are valid under applicable law.  If additional permissions apply only to part of the Program, that part may be used separately under those permissions, but the entire Program remains governed by this License without regard to the additional permissions.

When you convey a copy of a covered work, you may at your option remove any additional permissions from that copy, or from any part of it.  (Additional permissions may be written to require their own removal in certain cases when you modify the work.)  You may place additional permissions on material, added by you to a covered work, for which you have or can give appropriate copyright permission.

Notwithstanding any other provision of this License, for material you add to a covered work, you may (if authorized by the copyright holders of that material) supplement the terms of this License with terms:

    a) Disclaiming warranty or limiting liability differently from the terms of sections 15 and 16 of this License; or

    b) Requiring preservation of specified reasonable legal notices or author attributions in that material or in the Appropriate Legal Notices displayed by works containing it; or

    c) Prohibiting misrepresentation of the origin of that material, or requiring that modified versions of such material be marked in reasonable ways as different from the original version; or

    d) Limiting the use for publicity purposes of names of licensors or authors of the material; or

    e) Declining to grant rights under trademark law for use of some trade names, trademarks, or service marks; or

    f) Requiring indemnification of licensors and authors of that material by anyone who conveys the material (or modified versions of it) with contractual assumptions of liability to the recipient, for any liability that these contractual assumptions directly impose on those licensors and authors.

All other non-permissive additional terms are considered "further restrictions" within the meaning of section 10.  If the Program as you received it, or any part of it, contains a notice stating that it is governed by this License along with a term that is a further restriction, you may remove that term.  If a license document contains a further restriction but permits relicensing or conveying under this License, you may add to a covered work material governed by the terms of that license document, provided that the further restriction does not survive such relicensing or conveying.

If you add terms to a covered work in accord with this section, you must place, in the relevant source files, a statement of the additional terms that apply to those files, or a notice indicating where to find the applicable terms.

Additional terms, permissive or non-permissive, may be stated in the form of a separately written license, or stated as exceptions; the above requirements apply either way.

8. Termination.

You may not propagate or modify a covered work except as expressly provided under this License.  Any attempt otherwise to propagate or modify it is void, and will automatically terminate your rights under this License (including any patent licenses granted under the third paragraph of section 11).

However, if you cease all violation of this License, then your license from a particular copyright holder is reinstated (a) provisionally, unless and until the copyright holder explicitly and finally terminates your license, and (b) permanently, if the copyright holder fails to notify you of the violation by some reasonable means prior to 60 days after the cessation.

Moreover, your license from a particular copyright holder is reinstated permanently if the copyright holder notifies you of the violation by some reasonable means, this is the first time you have received notice of violation of this License (for any work) from that copyright holder, and you cure the violation prior to 30 days after your receipt of the notice.

Termination of your rights under this section does not terminate the licenses of parties who have received copies or rights from you under this License.  If your rights have been terminated and not permanently reinstated, you do not qualify to receive new licenses for the same material under section 10.

9. Acceptance Not Required for Having Copies.

You are not required to accept this License in order to receive or run a copy of the Program.  Ancillary propagation of a covered work occurring solely as a consequence of using peer-to-peer transmission to receive a copy likewise does not require acceptance.  However, nothing other than this License grants you permission to propagate or modify any covered work.  These actions infringe copyright if you do not accept this License.  Therefore, by modifying or propagating a covered work, you indicate your acceptance of this License to do so.

10. Automatic Licensing of Downstream Recipients.

Each time you convey a covered work, the recipient automatically receives a license from the original licensors, to run, modify and propagate that work, subject to this License.  You are not responsible for enforcing compliance by third parties with this License.

An "entity transaction" is a transaction transferring control of an organization, or substantially all assets of one, or subdividing an organization, or merging organizations.  If propagation of a covered work results from an entity transaction, each party to that transaction who receives a copy of the work also receives whatever licenses to the work the party's predecessor in interest had or could give under the previous paragraph, plus a right to possession of the Corresponding Source of the work from the predecessor in interest, if the predecessor has it or can get it with reasonable efforts.

You may not impose any further restrictions on the exercise of the rights granted or affirmed under this License.  For example, you may not impose a license fee, royalty, or other charge for exercise of rights granted under this License, and you may not initiate litigation (including a cross-claim or counterclaim in a lawsuit) alleging that any patent claim is infringed by making, using, selling, offering for sale, or importing the Program or any portion of it.

11. Patents.

A "contributor" is a copyright holder who authorizes use under this License of the Program or a work on which the Program is based.  The work thus licensed is called the contributor's "contributor version".

A contributor's "essential patent claims" are all patent claims owned or controlled by the contributor, whether already acquired or hereafter acquired, that would be infringed by some manner, permitted by this License, of making, using, or selling its contributor version, but do not include claims that would be infringed only as a consequence of further modification of the contributor version.  For purposes of this definition, "control" includes the right to grant patent sublicenses in a manner consistent with the requirements of this License.

Each contributor grants you a non-exclusive, worldwide, royalty-free patent license under the contributor's essential patent claims, to make, use, sell, offer for sale, import and otherwise run, modify and propagate the contents of its contributor version.

In the following three paragraphs, a "patent license" is any express agreement or commitment, however denominated, not to enforce a patent (such as an express permission to practice a patent or covenant not to sue for patent infringement).  To "grant" such a patent license to a party means to make such an agreement or commitment not to enforce a patent against the party.

If you convey a covered work, knowingly relying on a patent license, and the Corresponding Source of the work is not available for anyone to copy, free of charge and under the terms of this License, through a publicly available network server or other readily accessible means, then you must either (1) cause the Corresponding Source to be so available, or (2) arrange to deprive yourself of the benefit of the patent license for this particular work, or (3) arrange, in a manner consistent with the requirements of this License, to extend the patent
license to downstream recipients.  "Knowingly relying" means you have actual knowledge that, but for the patent license, your conveying the covered work in a country, or your recipient's use of the covered work in a country, would infringe one or more identifiable patents in that country that you have reason to believe are valid.

If, pursuant to or in connection with a single transaction or arrangement, you convey, or propagate by procuring conveyance of, a covered work, and grant a patent license to some of the parties receiving the covered work authorizing them to use, propagate, modify or convey a specific copy of the covered work, then the patent license you grant is automatically extended to all recipients of the covered work and works based on it.

A patent license is "discriminatory" if it does not include within the scope of its coverage, prohibits the exercise of, or is conditioned on the non-exercise of one or more of the rights that are specifically granted under this License.  You may not convey a covered work if you are a party to an arrangement with a third party that is in the business of distributing software, under which you make payment to the third party based on the extent of your activity of conveying the work, and under which the third party grants, to any of the parties who would receive the covered work from you, a discriminatory patent license (a) in connection with copies of the covered work conveyed by you (or copies made from those copies), or (b) primarily for and in connection with specific products or compilations that contain the covered work, unless you entered into that arrangement, or that patent license was granted, prior to 28 March 2007.

Nothing in this License shall be construed as excluding or limiting any implied license or other defenses to infringement that may otherwise be available to you under applicable patent law.

12. No Surrender of Others' Freedom.

If conditions are imposed on you (whether by court order, agreement or otherwise) that contradict the conditions of this License, they do not excuse you from the conditions of this License.  If you cannot convey a covered work so as to satisfy simultaneously your obligations under this License and any other pertinent obligations, then as a consequence you may
not convey it at all.  For example, if you agree to terms that obligate you to collect a royalty for further conveying from those to whom you convey the Program, the only way you could satisfy both those terms and this License would be to refrain entirely from conveying the Program.

13. Remote Network Interaction; Use with the GNU General Public License.

Notwithstanding any other provision of this License, if you modify the Program, your modified version must prominently offer all users interacting with it remotely through a computer network (if your version supports such interaction) an opportunity to receive the Corresponding Source of your version by providing access to the Corresponding Source from a network server at no charge, through some standard or customary means of facilitating copying of software.  This Corresponding Source shall include the Corresponding Source for any work covered by version 3 of the GNU General Public License that is incorporated pursuant to the following paragraph.

Notwithstanding any other provision of this License, you have permission to link or combine any covered work with a work licensed under version 3 of the GNU General Public License into a single combined work, and to convey the resulting work.  The terms of this License will continue to apply to the part which is the covered work, but the work with which it is combined will remain governed by version 3 of the GNU General Public License.

14. Revised Versions of this License.

The Free Software Foundation may publish revised and/or new versions of the GNU Affero General Public License from time to time.  Such new versions will be similar in spirit to the present version, but may differ in detail to address new problems or concerns.

Each version is given a distinguishing version number.  If the Program specifies that a certain numbered version of the GNU Affero General Public License "or any later version" applies to it, you have the option of following the terms and conditions either of that numbered version or of any later version published by the Free Software Foundation.  If the Program does not specify a version number of the GNU Affero General Public License, you may choose any version ever published by the Free Software Foundation.

If the Program specifies that a proxy can decide which future versions of the GNU Affero General Public License can be used, that proxy's public statement of acceptance of a version permanently authorizes you to choose that version for the Program.

Later license versions may give you additional or different permissions.  However, no additional obligations are imposed on any author or copyright holder as a result of your choosing to follow a later version.

15. Disclaimer of Warranty.

THERE IS NO WARRANTY FOR THE PROGRAM, TO THE EXTENT PERMITTED BY APPLICABLE LAW.  EXCEPT WHEN OTHERWISE STATED IN WRITING THE COPYRIGHT HOLDERS AND/OR OTHER PARTIES PROVIDE THE PROGRAM "AS IS" WITHOUT WARRANTY OF ANY KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE.  THE ENTIRE RISK AS TO THE QUALITY AND PERFORMANCE OF THE PROGRAM IS WITH YOU.  SHOULD THE PROGRAM PROVE DEFECTIVE, YOU ASSUME THE COST OF ALL NECESSARY SERVICING, REPAIR OR CORRECTION.

16. Limitation of Liability.

IN NO EVENT UNLESS REQUIRED BY APPLICABLE LAW OR AGREED TO IN WRITING WILL ANY COPYRIGHT HOLDER, OR ANY OTHER PARTY WHO MODIFIES AND/OR CONVEYS THE PROGRAM AS PERMITTED ABOVE, BE LIABLE TO YOU FOR DAMAGES, INCLUDING ANY GENERAL, SPECIAL, INCIDENTAL OR CONSEQUENTIAL DAMAGES ARISING OUT OF THE USE OR INABILITY TO USE THE PROGRAM (INCLUDING BUT NOT LIMITED TO LOSS OF DATA OR DATA BEING RENDERED INACCURATE OR LOSSES SUSTAINED BY YOU OR THIRD PARTIES OR A FAILURE OF THE PROGRAM TO OPERATE WITH ANY OTHER PROGRAMS), EVEN IF SUCH HOLDER OR OTHER PARTY HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

17. Interpretation of Sections 15 and 16.

If the disclaimer of warranty and limitation of liability provided above cannot be given local legal effect according to their terms, reviewing courts shall apply local law that most closely approximates an absolute waiver of all civil liability in connection with the Program, unless a warranty or assumption of liability accompanies a copy of the Program in return for a fee.

END OF TERMS AND CONDITIONS

            How to Apply These Terms to Your New Programs

If you develop a new program, and you want it to be of the greatest possible use to the public, the best way to achieve this is to make it free software which everyone can redistribute and change under these terms.

To do so, attach the following notices to the program.  It is safest to attach them to the start of each source file to most effectively state the exclusion of warranty; and each file should have at least the "copyright" line and a pointer to where the full notice is found.

     <one line to give the program's name and a brief idea of what it does.>
     Copyright (C) <year>  <name of author>

     This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

     This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License for more details.

     You should have received a copy of the GNU Affero General Public License along with this program.  If not, see <http://www.gnu.org/licenses/>.

Also add information on how to contact you by electronic and paper mail.

If your software can interact with users remotely through a computer network, you should also make sure that it provides a way for users to get its source.  For example, if your program is a web application, its interface could display a "Source" link that leads users to an archive of the code.  There are many ways you could offer source, and different solutions will be better for different programs; see section 13 for the specific requirements.

You should also get your employer (if you work as a programmer) or school, if any, to sign a "copyright disclaimer" for the program, if necessary. For more information on this, and how to apply and follow the GNU AGPL, see <http://www.gnu.org/licenses/>.
```

</details>

<details>
<summary><strong>ISC License</strong> (<code>ISC</code>)</summary>

```text
// Copyright 2015-2016 Brian Smith.
//
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
//
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHORS DISCLAIM ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

</details>

<details>
<summary><strong>Boost Software License 1.0</strong> (<code>BSL-1.0</code>)</summary>

```text
Boost Software License - Version 1.0 - August 17th, 2003

Permission is hereby granted, free of charge, to any person or organization
obtaining a copy of the software and accompanying documentation covered by
this license (the "Software") to use, reproduce, display, distribute,
execute, and transmit the Software, and to prepare derivative works of the
Software, and to permit third-parties to whom the Software is furnished to
do so, all subject to the following:

The copyright notices in the Software and this entire statement, including
the above license grant, this restriction and the following disclaimer,
must be included in all copies of the Software, in whole or in part, and
all derivative works of the Software, unless such copies or derivative
works are solely in the form of machine-executable object code generated by
a source language processor.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT. IN NO EVENT
SHALL THE COPYRIGHT HOLDERS OR ANYONE DISTRIBUTING THE SOFTWARE BE LIABLE
FOR ANY DAMAGES OR OTHER LIABILITY, WHETHER IN CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

</details>

<details>
<summary><strong>zlib License</strong> (<code>Zlib</code>)</summary>

```text
Copyright (c) 2024 Orson Peters

This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use of
this software.

Permission is granted to anyone to use this software for any purpose, including
commercial applications, and to alter it and redistribute it freely, subject to
the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
    that you wrote the original software. If you use this software in a product,
    an acknowledgment in the product documentation would be appreciated but is
    not required.

2. Altered source versions must be plainly marked as such, and must not be
    misrepresented as being the original software.

3. This notice may not be removed or altered from any source distribution.
```

</details>

<details>
<summary><strong>Community Data License Agreement Permissive 2.0</strong> (<code>CDLA-Permissive-2.0</code>)</summary>

```text
# Community Data License Agreement - Permissive - Version 2.0

This is the Community Data License Agreement - Permissive, Version
2.0 (the "agreement"). Data Provider(s) and Data Recipient(s) agree
as follows:

## 1. Provision of the Data

1.1. A Data Recipient may use, modify, and share the Data made
available by Data Provider(s) under this agreement if that Data
Recipient follows the terms of this agreement.

1.2. This agreement does not impose any restriction on a Data
Recipient's use, modification, or sharing of any portions of the
Data that are in the public domain or that may be used, modified,
or shared under any other legal exception or limitation.

## 2. Conditions for Sharing Data

2.1. A Data Recipient may share Data, with or without modifications, so
long as the Data Recipient makes available the text of this agreement
with the shared Data.

## 3. No Restrictions on Results

3.1. This agreement does not impose any restriction or obligations
with respect to the use, modification, or sharing of Results.

## 4. No Warranty; Limitation of Liability

4.1. All Data Recipients receive the Data subject to the following
terms:

THE DATA IS PROVIDED ON AN "AS IS" BASIS, WITHOUT REPRESENTATIONS,
WARRANTIES OR CONDITIONS OF ANY KIND, EITHER EXPRESS OR IMPLIED
INCLUDING, WITHOUT LIMITATION, ANY WARRANTIES OR CONDITIONS OF TITLE,
NON-INFRINGEMENT, MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.

NO DATA PROVIDER SHALL HAVE ANY LIABILITY FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING
WITHOUT LIMITATION LOST PROFITS), HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE DATA OR RESULTS,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

## 5. Definitions

5.1. "Data" means the material received by a Data Recipient under
this agreement.

5.2. "Data Provider" means any person who is the source of Data
provided under this agreement and in reliance on a Data Recipient's
agreement to its terms.

5.3. "Data Recipient" means any person who receives Data directly
or indirectly from a Data Provider and agrees to the terms of this
agreement.

5.4. "Results" means any outcome obtained by computational analysis
of Data, including for example machine learning models and models'
insights.
```

</details>


## JavaScript runtime dependencies

Production npm dependencies bundled into the renderer.

| Package | Version | License |
|---|---|---|
| [@tauri-apps/api](https://github.com/tauri-apps/tauri#readme) | 2.11.1 | `Apache-2.0 OR MIT` |
| [@types/prismjs](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/prismjs) | 1.26.6 | `MIT` |
| [clsx](https://github.com/lukeed/clsx#readme) | 2.1.1 | `MIT` |
| [prism-react-renderer](https://github.com/FormidableLabs/prism-react-renderer#readme) | 2.4.1 | `MIT` |
| [prismjs](https://github.com/PrismJS/prism#readme) | 1.30.0 | `MIT` |
| [react](https://react.dev/) | 19.2.7 | `MIT` |
| [react-dom](https://react.dev/) | 19.2.7 | `MIT` |
| [scheduler](https://react.dev/) | 0.27.0 | `MIT` |

Total: **8 packages**.

