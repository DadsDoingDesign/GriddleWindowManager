# Third-party licenses

Griddle WM is distributed as a single Windows installer that statically links a Rust
executable and embeds a compiled web frontend. This file lists every third-party
component redistributed in, or used to produce, that installer, together with the full
text of every distinct license involved.

Griddle WM itself is licensed under the MIT License; see [`LICENSE`](LICENSE).
Nothing in this file changes the license of Griddle WM's own source code.

## How this list was produced

- **Rust crates** — `cargo metadata --format-version 1 --filter-platform x86_64-pc-windows-msvc`,
  walked from the `griddle-wm` root package across `normal` and `build` dependency edges.
  Dev-dependencies are excluded because they never reach the shipped binary.
- **npm packages** — `license-checker --json` over the workspace, split into the
  production closure of `@griddle-wm/desktop` (code that can reach the compiled frontend)
  and build/test-only tooling.
- License texts are copied verbatim from the files each component ships, not transcribed.

Generated for Griddle WM 0.2.0.

## Summary

Every component below is under a permissive or weak-copyleft license. **No component is
under GPL, AGPL, LGPL, SSPL, CC-BY-SA, a proprietary license, or an unresolved
"UNLICENSED" declaration.** Two points deserve attention:

- **MPL-2.0** applies to five Rust crates (`cssparser`, `cssparser-macros`, `dtoa-short`,
  `option-ext`, `selectors`) that are linked into the shipped executable, and to two
  build-only npm packages (`lightningcss`, `lightningcss-win32-x64-msvc`). MPL-2.0 is
  file-level copyleft, not project-level; see the note in the MPL-2.0 section for the
  obligation this creates and how it is discharged.
- **Apache-2.0** applies to `tao` outright and to a large number of dual-licensed crates.
  Its section 4 requires that this license text and any upstream `NOTICE` file travel with
  the distribution. No component listed here ships a `NOTICE` file, so reproducing the
  license text — as this file does — satisfies it.

---

## Rust crates (271, linked into `griddle-wm.exe`)

Grouped by the SPDX expression each crate declares. An `OR` expression means the crate
is offered under any one of the listed licenses at the redistributor's choice; for those
crates Griddle WM elects the MIT option where MIT is offered, and the Apache-2.0 option
otherwise. An `AND` expression means every listed license applies simultaneously.

### `MIT OR Apache-2.0` — 134 crates

- **anyhow** 1.0.104 — David Tolnay
- **base64** 0.22.1 — Marshall Pierce
- **bitflags** 2.13.1 — The Rust Project Developers
- **block-buffer** 0.10.4 — RustCrypto Developers
- **camino** 1.2.5 — Without Boats, Ashley Williams, Steve Klabnik, Rain
- **cargo-platform** 0.1.9
- **cc** 1.4.2
- **cfg-if** 1.0.4 — Alex Crichton
- **chrono** 0.4.45
- **cookie** 0.18.2 — Sergio Benitez, Alex Crichton
- **cpufeatures** 0.2.17 — RustCrypto Developers
- **crc32fast** 1.5.0 — Sam Rijs, Alex Crichton
- **crossbeam-channel** 0.5.16
- **crossbeam-utils** 0.8.22
- **crypto-common** 0.1.7 — RustCrypto Developers
- **deranged** 0.5.8 — Jacob Pratt
- **digest** 0.10.7 — RustCrypto Developers
- **dirs** 6.0.0 — Simon Ochsenreither
- **dirs-sys** 0.5.0 — Simon Ochsenreither
- **displaydoc** 0.2.7 — Jane Lusby
- **dtoa** 1.0.11 — David Tolnay
- **dyn-clone** 1.0.20 — David Tolnay
- **erased-serde** 0.4.10 — David Tolnay
- **fdeflate** 0.3.7 — The image-rs Developers
- **find-msvc-tools** 0.1.10
- **flate2** 1.1.9 — Alex Crichton, Josh Triplett
- **form_urlencoded** 1.2.2 — The rust-url developers
- **getrandom** 0.4.3 — The Rand Project Developers
- **getrandom** 0.3.4 — The Rand Project Developers
- **glob** 0.3.4 — The Rust Project Developers
- **hashbrown** 0.12.3 — Amanieu d'Antras
- **hashbrown** 0.17.1
- **heck** 0.5.0
- **hex** 0.4.3 — KokaKiwi
- **html5ever** 0.38.0 — The html5ever Project Developers
- **http** 1.5.0 — Alex Crichton, Carl Lerche, Sean McArthur
- **idna** 1.1.0 — The rust-url developers
- **itoa** 1.0.18 — David Tolnay
- **jsonptr** 0.6.3 — chance dinkins, André Sá de Mello
- **keyboard-types** 0.7.0 — Pyfisch
- **libc** 0.2.189
- **lock_api** 0.4.14 — Amanieu d'Antras
- **log** 0.4.33 — The Rust Project Developers
- **markup5ever** 0.38.0 — The html5ever Project Developers
- **mime** 0.3.17 — Sean McArthur
- **num-conv** 0.2.2 — Jacob Pratt
- **num-traits** 0.2.19 — The Rust Project Developers
- **once_cell** 1.21.4 — Aleksey Kladov
- **parking_lot** 0.12.5 — Amanieu d'Antras
- **parking_lot_core** 0.9.12 — Amanieu d'Antras
- **percent-encoding** 2.3.2 — The rust-url developers
- **png** 0.17.16 — The image-rs Developers
- **powerfmt** 0.2.0 — Jacob Pratt
- **proc-macro2** 1.0.107 — David Tolnay, Alex Crichton
- **quote** 1.0.47 — David Tolnay
- **ref-cast** 1.0.26 — David Tolnay
- **ref-cast-impl** 1.0.26 — David Tolnay
- **regex** 1.13.1 — The Rust Project Developers, Andrew Gallant
- **regex-automata** 0.4.18 — The Rust Project Developers, Andrew Gallant
- **regex-syntax** 0.8.11 — The Rust Project Developers, Andrew Gallant
- **rustc_version** 0.4.1
- **scopeguard** 1.2.0 — bluss
- **semver** 1.0.28 — David Tolnay
- **serde** 1.0.229 — Erick Tryzelaar, David Tolnay
- **serde-untagged** 0.1.9 — David Tolnay
- **serde_core** 1.0.229 — Erick Tryzelaar, David Tolnay
- **serde_derive** 1.0.229 — Erick Tryzelaar, David Tolnay
- **serde_derive_internals** 0.29.1 — Erick Tryzelaar, David Tolnay
- **serde_json** 1.0.151 — Erick Tryzelaar, David Tolnay
- **serde_repr** 0.1.21 — David Tolnay
- **serde_spanned** 1.1.1
- **serde_with** 3.21.0 — Jonas Bushart, Marcin Kaźmierczak
- **serde_with_macros** 3.21.0 — Jonas Bushart
- **serialize-to-javascript** 0.1.2 — Chip Reed
- **serialize-to-javascript-impl** 0.1.2 — Chip Reed
- **servo_arc** 0.4.3 — The Servo Project Developers
- **sha2** 0.10.9 — RustCrypto Developers
- **shlex** 2.0.1 — comex, Fenhl, Adrian Taylor, Alex Touchet, Daniel Parks, Garrett Berg
- **smallvec** 1.15.2 — The Servo Project Developers
- **socket2** 0.6.5 — Alex Crichton, Thomas de Zeeuw
- **softbuffer** 0.4.8
- **stable_deref_trait** 1.2.1 — Robert Grosse
- **string_cache** 0.9.0 — The Servo Project Developers
- **string_cache_codegen** 0.6.1 — The Servo Project Developers
- **syn** 3.0.3 — David Tolnay
- **syn** 2.0.119 — David Tolnay
- **tendril** 0.5.1 — Keegan McAllister, Simon Sapin, Chris Morgan
- **thiserror** 2.0.20 — David Tolnay
- **thiserror** 1.0.69 — David Tolnay
- **thiserror-impl** 1.0.69 — David Tolnay
- **thiserror-impl** 2.0.20 — David Tolnay
- **time** 0.3.55 — Jacob Pratt, Time contributors
- **time-core** 0.1.9 — Jacob Pratt, Time contributors
- **time-macros** 0.2.32 — Jacob Pratt, Time contributors
- **toml** 1.1.4+spec-1.1.0
- **toml** 0.9.12+spec-1.1.0
- **toml_datetime** 0.7.5+spec-1.1.0
- **toml_datetime** 1.1.1+spec-1.1.0
- **toml_parser** 1.1.3+spec-1.1.0
- **toml_writer** 1.1.2+spec-1.1.0
- **tray-icon** 0.24.2
- **typeid** 1.0.3 — David Tolnay
- **typenum** 1.20.1
- **unicode-segmentation** 1.13.3 — kwantam, Manish Goregaokar
- **url** 2.5.8 — The rust-url developers
- **web_atoms** 0.2.5 — The html5ever Project Developers
- **windows** 0.62.2
- **windows** 0.61.3 — Microsoft
- **windows-collections** 0.2.0
- **windows-collections** 0.3.2
- **windows-core** 0.62.2
- **windows-core** 0.61.2 — Microsoft
- **windows-future** 0.3.2
- **windows-future** 0.2.1
- **windows-implement** 0.60.2
- **windows-interface** 0.59.3
- **windows-link** 0.1.3 — Microsoft
- **windows-link** 0.2.1
- **windows-numerics** 0.3.1
- **windows-numerics** 0.2.0
- **windows-result** 0.4.1
- **windows-result** 0.3.4 — Microsoft
- **windows-strings** 0.4.2 — Microsoft
- **windows-strings** 0.5.1
- **windows-sys** 0.59.0 — Microsoft
- **windows-sys** 0.60.2 — Microsoft
- **windows-sys** 0.61.2
- **windows-targets** 0.52.6 — Microsoft
- **windows-targets** 0.53.5
- **windows-threading** 0.1.0 — Microsoft
- **windows-threading** 0.2.1
- **windows-version** 0.1.7
- **windows_x86_64_msvc** 0.53.1
- **windows_x86_64_msvc** 0.52.6 — Microsoft

### `MIT` — 48 crates

- **auto-launch** 0.5.0 — zzzgydi
- **bytes** 1.12.1 — Carl Lerche, Sean McArthur
- **cargo_metadata** 0.19.2 — Oliver Schneider
- **cfb** 0.7.3 — Matthew D. Steele
- **darling** 0.23.0 — Ted Driggs
- **darling_core** 0.23.0 — Ted Driggs
- **darling_macro** 0.23.0 — Ted Driggs
- **derive_more** 2.1.1 — Jelte Fennema
- **derive_more-impl** 2.1.1 — Jelte Fennema
- **dom_query** 0.27.0 — niklak, importcjj
- **embed-resource** 3.0.11 — наб, Cat Plus Plus, Liigo, azyobuzin, Peter Atashian, pravic, Gabriel Majeri, SonnyX, Johan Andersson, Jordan Poles, MSxDOS, Jim McGrath, roblabla, Jasper Bekkers, Richard Markiewicz, Emerson de Freitas Barcelos, Li Keqing, Alexis Bourget, Michael Farrell, Jacob Okamoto, Marijn Suijten, Lucas Nogueira, CharlesChen0823, Daniel Schaefer, Rene Leonhardt, ssrlive, Kan-Ru Chen, Tony, Berrysoft, Marcus Ahlberg
- **fern** 0.7.1 — David Ross
- **generic-array** 0.14.7 — Bartłomiej Kamiński, Aaron Trent
- **ico** 0.5.0 — Matthew D. Steele
- **infer** 0.19.0 — Bojan
- **mio** 1.2.2 — Carl Lerche, Thomas de Zeeuw, Tokio Contributors
- **new_debug_unreachable** 1.0.6 — Matt Brubeck, Jonathan Reem
- **phf** 0.13.1 — Steven Fackler
- **phf_codegen** 0.13.1 — Steven Fackler
- **phf_generator** 0.13.1 — Steven Fackler
- **phf_macros** 0.13.1 — Steven Fackler
- **phf_shared** 0.13.1 — Steven Fackler
- **plist** 1.10.0 — Ed Barnard
- **precomputed-hash** 0.1.1 — Emilio Cobos Álvarez
- **quick-xml** 0.41.0
- **schemars** 1.2.2 — Graham Esau
- **schemars** 0.9.0 — Graham Esau
- **schemars** 0.8.22 — Graham Esau
- **schemars_derive** 0.8.22 — Graham Esau
- **simd-adler32** 0.3.10 — Marvin Countryman
- **strsim** 0.11.1 — Danny Guo, maxbachmann
- **synstructure** 0.13.2 — Nika Layzell
- **tauri-winres** 0.3.6 — Tauri Programme within The Commons Conservancy, Max Resch
- **tokio** 1.53.1 — Tokio Contributors
- **tracing** 0.1.44 — Eliza Weisman, Tokio Contributors
- **tracing-attributes** 0.1.31 — Tokio Contributors, Eliza Weisman, David Barsky
- **tracing-core** 0.1.36 — Tokio Contributors
- **urlpattern** 0.3.0 — the Deno authors, crowlKats
- **vswhom** 0.1.0 — nabijaczleweli
- **vswhom-sys** 0.1.3 — наб, forrestsmithfb
- **webview2-com** 0.38.2
- **webview2-com-macros** 0.8.1
- **webview2-com-sys** 0.38.2
- **winnow** 1.0.4
- **winnow** 0.7.15
- **winreg** 0.55.0 — Igor Shaula
- **winreg** 0.10.1 — Igor Shaula
- **zmij** 1.0.23 — David Tolnay

### `Apache-2.0 OR MIT` — 33 crates

- **autocfg** 1.5.1 — Josh Stone
- **bit-set** 0.8.0 — Alexis Beingessner
- **bit-vec** 0.8.0 — Alexis Beingessner
- **cargo_toml** 0.22.3 — Kornel
- **ctor** 0.8.0 — Matt Mastracci
- **ctor-proc-macro** 0.0.7 — Matt Mastracci
- **dtor** 0.3.0 — Matt Mastracci
- **dtor-proc-macro** 0.0.6 — Matt Mastracci
- **equivalent** 1.0.2
- **fastrand** 2.5.0 — Stjepan Glavina
- **global-hotkey** 0.8.0
- **idna_adapter** 1.2.2 — The rust-url developers
- **indexmap** 2.14.0
- **indexmap** 1.9.3
- **muda** 0.19.3
- **pin-project-lite** 0.2.17
- **rustc-hash** 2.1.3 — The Rust Project Developers
- **tauri** 2.11.5 — Tauri Programme within The Commons Conservancy
- **tauri-build** 2.6.3 — Tauri Programme within The Commons Conservancy
- **tauri-codegen** 2.6.3 — Tauri Programme within The Commons Conservancy
- **tauri-macros** 2.6.3 — Tauri Programme within The Commons Conservancy
- **tauri-plugin** 2.6.3 — Tauri Programme within The Commons Conservancy
- **tauri-plugin-autostart** 2.5.1 — Tauri Programme within The Commons Conservancy
- **tauri-plugin-global-shortcut** 2.3.2 — Tauri Programme within The Commons Conservancy
- **tauri-plugin-log** 2.9.0 — Tauri Programme within The Commons Conservancy
- **tauri-plugin-single-instance** 2.4.3 — Tauri Programme within The Commons Conservancy
- **tauri-runtime** 2.11.3 — Tauri Programme within The Commons Conservancy
- **tauri-runtime-wry** 2.11.4 — Tauri Programme within The Commons Conservancy
- **tauri-utils** 2.9.3 — Tauri Programme within The Commons Conservancy
- **utf8_iter** 1.0.4 — Henri Sivonen
- **uuid** 1.24.0 — Ashley Mannix, Dylan DPC, Hunar Roop Kahlon
- **window-vibrancy** 0.6.0 — Tauri Programme within The Commons Conservancy
- **wry** 0.55.1 — Tauri Programme within The Commons Conservancy

### `Unicode-3.0` — 18 crates

- **icu_collections** 2.2.0 — The ICU4X Project Developers
- **icu_locale_core** 2.2.0 — The ICU4X Project Developers
- **icu_normalizer** 2.2.0 — The ICU4X Project Developers
- **icu_normalizer_data** 2.2.0 — The ICU4X Project Developers
- **icu_properties** 2.2.0 — The ICU4X Project Developers
- **icu_properties_data** 2.2.0 — The ICU4X Project Developers
- **icu_provider** 2.2.0 — The ICU4X Project Developers
- **litemap** 0.8.2 — The ICU4X Project Developers
- **potential_utf** 0.1.5 — The ICU4X Project Developers
- **tinystr** 0.8.3 — The ICU4X Project Developers
- **writeable** 0.6.3 — The ICU4X Project Developers
- **yoke** 0.8.3 — Manish Goregaokar
- **yoke-derive** 0.8.2 — Manish Goregaokar
- **zerofrom** 0.1.8 — The ICU4X Project Developers
- **zerofrom-derive** 0.1.7 — Manish Goregaokar
- **zerotrie** 0.2.4 — The ICU4X Project Developers
- **zerovec** 0.11.6 — The ICU4X Project Developers
- **zerovec-derive** 0.11.3 — Manish Goregaokar

### `MIT/Apache-2.0` — 12 crates

- **bitflags** 1.3.2 — The Rust Project Developers
- **bs58** 0.5.1
- **ident_case** 1.0.1 — Ted Driggs
- **json-patch** 3.0.1 — Ivan Dubrov
- **siphasher** 1.0.3 — Frank Denis
- **unic-char-property** 0.9.0 — The UNIC Project Developers
- **unic-char-range** 0.9.0 — The UNIC Project Developers
- **unic-common** 0.9.0 — The UNIC Project Developers
- **unic-ucd-ident** 0.9.0 — The UNIC Project Developers
- **unic-ucd-version** 0.9.0 — The UNIC Project Developers
- **version_check** 0.9.5 — Sergio Benitez
- **winapi** 0.3.9 — Peter Atashian

### `MPL-2.0` — 5 crates

- **cssparser** 0.36.0 — Simon Sapin
- **cssparser-macros** 0.6.1 — Simon Sapin
- **dtoa-short** 0.3.5 — Xidorn Quan
- **option-ext** 0.2.0 — Simon Ochsenreither
- **selectors** 0.36.1 — The Servo Project Developers

> **MPL-2.0 is weak, file-level copyleft.** The reciprocity obligation attaches to the
> *files* of these crates, not to anything that merely links against them. Griddle WM does
> not modify any of these crates — they are consumed unmodified from crates.io — so the
> only live obligation is to say so and to point to the source. Distributing Griddle WM in
> binary form is expressly permitted by MPL-2.0 section 3.2 as long as recipients are told
> how to obtain the Source Code Form of the covered files, on the same license, at no
> charge. That notice is given here: the unmodified sources are the published crates.io
> releases of the exact versions listed above, retrievable at
> `https://crates.io/crates/<name>/<version>`, and this file constitutes the section 3.2
> notice. If any of these crates is ever patched or vendored locally, the modified files
> must be released under MPL-2.0.
>
> How they are reached: `cssparser`, `dtoa-short` and `selectors` arrive through
> `dom_query`; `cssparser-macros` through `cssparser`; `option-ext` through `dirs-sys`.

### `Unlicense OR MIT` — 4 crates

- **aho-corasick** 1.1.5 — Andrew Gallant
- **byteorder** 1.5.0 — Andrew Gallant
- **memchr** 2.8.3 — Andrew Gallant, bluss
- **winapi-util** 0.1.11 — Andrew Gallant

### `BSD-3-Clause` — 2 crates

- **alloc-no-stdlib** 2.0.4 — Daniel Reiter Horn
- **alloc-stdlib** 0.2.4 — Daniel Reiter Horn

### `MIT OR Apache-2.0 OR Zlib` — 2 crates

- **raw-window-handle** 0.6.2 — Osspial
- **tinyvec_macros** 0.1.1 — Soveu

### `Unlicense/MIT` — 2 crates

- **same-file** 1.0.6 — Andrew Gallant
- **walkdir** 2.5.0 — Andrew Gallant

### `(MIT OR Apache-2.0) AND Unicode-3.0` — 1 crate

- **unicode-ident** 1.0.24 — David Tolnay

### `0BSD OR MIT OR Apache-2.0` — 1 crate

- **adler2** 2.0.1 — Jonas Schievink, oyvindln

### `Apache-2.0` — 1 crate

- **tao** 0.35.3 — Tauri Programme within The Commons Conservancy, The winit contributors

### `Apache-2.0 / MIT` — 1 crate

- **fnv** 1.0.7 — Alex Crichton

### `Apache-2.0 AND MIT` — 1 crate

- **dpi** 0.1.2

### `BSD-3-Clause AND MIT` — 1 crate

- **brotli** 8.0.4 — Daniel Reiter Horn, The Brotli Authors

### `BSD-3-Clause/MIT` — 1 crate

- **brotli-decompressor** 5.0.3 — Daniel Reiter Horn, The Brotli Authors

### `CC0-1.0 OR MIT-0 OR Apache-2.0` — 1 crate

- **dunce** 1.0.5 — Kornel

### `MIT OR Zlib OR Apache-2.0` — 1 crate

- **miniz_oxide** 0.8.9 — Frommi, oyvindln, Rich Geldreich richgel99@gmail.com

### `Zlib` — 1 crate

- **foldhash** 0.2.0 — Orson Peters

### `Zlib OR Apache-2.0 OR MIT` — 1 crate

- **tinyvec** 1.12.0 — Lokathor

---

## npm packages

### Redistributed in the installer (23)

The production dependency closure of `@griddle-wm/desktop`. Code from these packages
can be bundled by Vite into the compiled frontend that ships inside the installer.

#### `MIT` — 20

- **@griddle/core** 0.1.11 — Trustybits
- **@griddle/svelte** 0.1.10 — Trustybits
- **@jridgewell/gen-mapping** 0.3.13 — Justin Ridgewell
- **@jridgewell/remapping** 2.3.5 — Justin Ridgewell
- **@jridgewell/resolve-uri** 3.1.2 — Justin Ridgewell
- **@jridgewell/sourcemap-codec** 1.5.5 — Justin Ridgewell
- **@jridgewell/trace-mapping** 0.3.31 — Justin Ridgewell
- **@sveltejs/acorn-typescript** 1.0.12 — tyrealhu and the Svelte team
- **@types/estree** 1.0.9
- **@types/trusted-types** 2.0.7
- **acorn** 8.18.0
- **clsx** 2.1.1 — Luke Edwards
- **devalue** 5.9.0
- **esm-env** 1.2.2 — Ben McCann
- **esrap** 2.3.2
- **is-reference** 3.0.3 — Rich Harris
- **locate-character** 3.0.0 — Rich Harris
- **magic-string** 0.30.21 — Rich Harris
- **svelte** 5.56.8
- **zimmerframe** 1.1.4

#### `Apache-2.0` — 2

- **aria-query** 5.3.1 — Jesse Beach
- **axobject-query** 4.1.0 — Jesse Beach

#### `Apache-2.0 OR MIT` — 1

- **@tauri-apps/api** 2.11.1

### Build and test tooling only (57)

These packages run on a developer machine to produce the installer. They are **not**
redistributed. They are listed for completeness and for supply-chain review; the
obligations of their licenses do not attach to the shipped artifact.

#### `MIT` — 47

- **@oxc-project/types** 0.143.0 — Boshen and oxc contributors
- **@rolldown/binding-win32-x64-msvc** 1.2.3
- **@rolldown/pluginutils** 1.0.1
- **@standard-schema/spec** 1.1.0 — Colin McDonnell
- **@sveltejs/load-config** 0.2.2
- **@sveltejs/vite-plugin-svelte** 7.3.0
- **@tsconfig/svelte** 5.0.8
- **@types/chai** 5.2.3
- **@types/deep-eql** 4.0.2
- **@types/node** 24.13.3
- **@vitest/expect** 4.1.10
- **@vitest/mocker** 4.1.10
- **@vitest/pretty-format** 4.1.10
- **@vitest/runner** 4.1.10
- **@vitest/snapshot** 4.1.10
- **@vitest/spy** 4.1.10
- **@vitest/utils** 4.1.10
- **assertion-error** 2.0.1 — Jake Luer
- **chai** 6.2.2 — Jake Luer
- **chokidar** 4.0.3 — Paul Miller
- **convert-source-map** 2.0.0 — Thorsten Lorenz
- **deepmerge** 4.3.1
- **es-module-lexer** 2.3.1 — Guy Bedford
- **estree-walker** 3.0.3 — Rich Harris
- **fdir** 6.5.0 — thecodrr
- **magic-string** 1.1.0 — Rich Harris
- **mri** 1.2.0 — Luke Edwards
- **nanoid** 3.3.18 — Andrey Sitnik
- **obug** 2.1.4 — Kevin Deng
- **pathe** 2.0.3
- **picomatch** 4.0.5 — Jon Schlinkert
- **postcss** 8.5.26 — Andrey Sitnik
- **readdirp** 4.1.2 — Thorsten Lorenz
- **rolldown** 1.2.3
- **sade** 1.8.1 — Luke Edwards
- **stackback** 0.0.2 — Roman Shtylman
- **std-env** 4.2.0
- **svelte-check** 4.7.5 — The Svelte Community
- **tinybench** 2.9.0
- **tinyexec** 1.3.0 — James Garbutt
- **tinyglobby** 0.2.17 — Superchupu
- **tinyrainbow** 3.1.1
- **undici-types** 7.18.2
- **vite** 8.2.1 — Evan You
- **vitefu** 1.1.3
- **vitest** 4.1.10 — Anthony Fu
- **why-is-node-running** 2.3.0 — Mathias Buus

#### `Apache-2.0` — 3

- **detect-libc** 2.1.2 — Lovell Fuller
- **expect-type** 1.4.0
- **typescript** 6.0.3 — Microsoft Corp.

#### `Apache-2.0 OR MIT` — 2

- **@tauri-apps/cli-win32-x64-msvc** 2.11.4
- **@tauri-apps/cli** 2.11.4

#### `ISC` — 2

- **picocolors** 1.1.1 — Alexey Raspopov
- **siginfo** 2.0.0 — Emil Bay

#### `MPL-2.0` — 2

- **lightningcss-win32-x64-msvc** 1.33.0
- **lightningcss** 1.33.0

#### `BSD-3-Clause` — 1

- **source-map-js** 1.2.1 — Valentin 7rulnik Semirulnik

---

## Bundled assets

- `apps/desktop/app-icon.svg` and everything generated from it under
  `apps/desktop/src-tauri/icons/` (`icon.ico`, `icon.png`, `icon.icns`, the `Square*Logo.png`
  set, `32x32.png`, `64x64.png`, `128x128.png`, `128x128@2x.png`, `StoreLogo.png`) are
  original artwork authored for this project and are covered by Griddle WM's own MIT
  license. The raster files are mechanical derivatives of the SVG, produced by
  `npx tauri icon`.
- Griddle WM embeds no fonts. All typography resolves to fonts already present on the
  user's system (`system-ui`, `Segoe UI`, `Roboto`, `ui-monospace`, `Consolas`), which are
  referenced by name only and are not redistributed.
- Griddle WM loads no remote assets at runtime.
- `apps/desktop/public/favicon.svg` and `apps/desktop/public/icons.svg` are project
  scaffolding left over from the initial workspace template. They are not referenced by
  any Griddle WM page and `icons.svg` contains third-party brand marks. Their provenance
  has not been established and they are **not** covered by this attribution file; they
  should be deleted rather than attributed.

---

## License texts

Each distinct license appears once below.

### MIT

> Reproduced from the copy shipped with the `anyhow` crate. Each MIT-licensed component above is covered by this text together with its own copyright notice; the copyright holders are the authors listed beside each component.

```
Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

### Apache-2.0

> No component listed in this file ships a NOTICE file, so Apache-2.0 section 4(d) adds no further attribution text beyond this license.

```
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

Copyright [yyyy] [name of copyright owner]

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

### BSD-3-Clause

```
Copyright (c) 2016 Dropbox, Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### ISC

> Reproduced from the copy shipped with `picocolors`; the copyright line above applies to that package. `siginfo` is covered by the same license text under its own copyright.

```
ISC License

Copyright (c) 2021-2024 Oleksii Raspopov, Kostiantyn Denysov, Anton Verinov

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### Zlib

> Reproduced from the copy shipped with `foldhash`; the copyright line applies to that crate.

```
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

### MPL-2.0

```
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

### Unicode-3.0

```
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

### 0BSD

```
Copyright (C) Jonas Schievink <jonasschievink@gmail.com>

Permission to use, copy, modify, and/or distribute this software for
any purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN
AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT
OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

### Unlicense

```
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org/>
```

### CC0-1.0

> Applies to `dunce`, which is offered under `CC0-1.0 OR MIT-0 OR Apache-2.0`. This is the text the crate itself ships.

```
Creative Commons Legal Code

CC0 1.0 Universal

    CREATIVE COMMONS CORPORATION IS NOT A LAW FIRM AND DOES NOT PROVIDE
    LEGAL SERVICES. DISTRIBUTION OF THIS DOCUMENT DOES NOT CREATE AN
    ATTORNEY-CLIENT RELATIONSHIP. CREATIVE COMMONS PROVIDES THIS
    INFORMATION ON AN "AS-IS" BASIS. CREATIVE COMMONS MAKES NO WARRANTIES
    REGARDING THE USE OF THIS DOCUMENT OR THE INFORMATION OR WORKS
    PROVIDED HEREUNDER, AND DISCLAIMS LIABILITY FOR DAMAGES RESULTING FROM
    THE USE OF THIS DOCUMENT OR THE INFORMATION OR WORKS PROVIDED
    HEREUNDER.

Statement of Purpose

The laws of most jurisdictions throughout the world automatically confer
exclusive Copyright and Related Rights (defined below) upon the creator
and subsequent owner(s) (each and all, an "owner") of an original work of
authorship and/or a database (each, a "Work").

Certain owners wish to permanently relinquish those rights to a Work for
the purpose of contributing to a commons of creative, cultural and
scientific works ("Commons") that the public can reliably and without fear
of later claims of infringement build upon, modify, incorporate in other
works, reuse and redistribute as freely as possible in any form whatsoever
and for any purposes, including without limitation commercial purposes.
These owners may contribute to the Commons to promote the ideal of a free
culture and the further production of creative, cultural and scientific
works, or to gain reputation or greater distribution for their Work in
part through the use and efforts of others.

For these and/or other purposes and motivations, and without any
expectation of additional consideration or compensation, the person
associating CC0 with a Work (the "Affirmer"), to the extent that he or she
is an owner of Copyright and Related Rights in the Work, voluntarily
elects to apply CC0 to the Work and publicly distribute the Work under its
terms, with knowledge of his or her Copyright and Related Rights in the
Work and the meaning and intended legal effect of CC0 on those rights.

1. Copyright and Related Rights. A Work made available under CC0 may be
protected by copyright and related or neighboring rights ("Copyright and
Related Rights"). Copyright and Related Rights include, but are not
limited to, the following:

  i. the right to reproduce, adapt, distribute, perform, display,
     communicate, and translate a Work;
 ii. moral rights retained by the original author(s) and/or performer(s);
iii. publicity and privacy rights pertaining to a person's image or
     likeness depicted in a Work;
 iv. rights protecting against unfair competition in regards to a Work,
     subject to the limitations in paragraph 4(a), below;
  v. rights protecting the extraction, dissemination, use and reuse of data
     in a Work;
 vi. database rights (such as those arising under Directive 96/9/EC of the
     European Parliament and of the Council of 11 March 1996 on the legal
     protection of databases, and under any national implementation
     thereof, including any amended or successor version of such
     directive); and
vii. other similar, equivalent or corresponding rights throughout the
     world based on applicable law or treaty, and any national
     implementations thereof.

2. Waiver. To the greatest extent permitted by, but not in contravention
of, applicable law, Affirmer hereby overtly, fully, permanently,
irrevocably and unconditionally waives, abandons, and surrenders all of
Affirmer's Copyright and Related Rights and associated claims and causes
of action, whether now known or unknown (including existing as well as
future claims and causes of action), in the Work (i) in all territories
worldwide, (ii) for the maximum duration provided by applicable law or
treaty (including future time extensions), (iii) in any current or future
medium and for any number of copies, and (iv) for any purpose whatsoever,
including without limitation commercial, advertising or promotional
purposes (the "Waiver"). Affirmer makes the Waiver for the benefit of each
member of the public at large and to the detriment of Affirmer's heirs and
successors, fully intending that such Waiver shall not be subject to
revocation, rescission, cancellation, termination, or any other legal or
equitable action to disrupt the quiet enjoyment of the Work by the public
as contemplated by Affirmer's express Statement of Purpose.

3. Public License Fallback. Should any part of the Waiver for any reason
be judged legally invalid or ineffective under applicable law, then the
Waiver shall be preserved to the maximum extent permitted taking into
account Affirmer's express Statement of Purpose. In addition, to the
extent the Waiver is so judged Affirmer hereby grants to each affected
person a royalty-free, non transferable, non sublicensable, non exclusive,
irrevocable and unconditional license to exercise Affirmer's Copyright and
Related Rights in the Work (i) in all territories worldwide, (ii) for the
maximum duration provided by applicable law or treaty (including future
time extensions), (iii) in any current or future medium and for any number
of copies, and (iv) for any purpose whatsoever, including without
limitation commercial, advertising or promotional purposes (the
"License"). The License shall be deemed effective as of the date CC0 was
applied by Affirmer to the Work. Should any part of the License for any
reason be judged legally invalid or ineffective under applicable law, such
partial invalidity or ineffectiveness shall not invalidate the remainder
of the License, and in such case Affirmer hereby affirms that he or she
will not (i) exercise any of his or her remaining Copyright and Related
Rights in the Work or (ii) assert any associated claims and causes of
action with respect to the Work, in either case contrary to Affirmer's
express Statement of Purpose.

4. Limitations and Disclaimers.

 a. No trademark or patent rights held by Affirmer are waived, abandoned,
    surrendered, licensed or otherwise affected by this document.
 b. Affirmer offers the Work as-is and makes no representations or
    warranties of any kind concerning the Work, express, implied,
    statutory or otherwise, including without limitation warranties of
    title, merchantability, fitness for a particular purpose, non
    infringement, or the absence of latent or other defects, accuracy, or
    the present or absence of errors, whether or not discoverable, all to
    the greatest extent permissible under applicable law.
 c. Affirmer disclaims responsibility for clearing rights of other persons
    that may apply to the Work or any use thereof, including without
    limitation any person's Copyright and Related Rights in the Work.
    Further, Affirmer disclaims responsibility for obtaining any necessary
    consents, permissions or other rights required for any use of the
    Work.
 d. Affirmer understands and acknowledges that Creative Commons is not a
    party to this document and has no duty or obligation with respect to
    this CC0 or use of the Work.
```

