# Legal & Commercial Review — Griddle Window Manager

**Date:** 2026-08-09 · **Reviewed at:** v0.2.0
**Updated:** 2026-08-10 — §0 records the decisions taken for the public release.
**Not legal advice.** This is an engineering-grade audit of what the project
uses and what those licenses require. Get a lawyer before signing anything or
launching a paid product.

## 0. Decisions taken (2026-08-10)

The open questions this review left for v0.2.0 are now settled:

- **Distribution: free and open source.** Option 1 of §7 — MIT on GitHub, no
  paid tier, no license keys, no signing spend. This is the lowest-burden path
  and the one with the fewest legal obligations: no commercial exposure to
  clear, no support SLA, no refunds.
- **Product name: "Griddle Window Manager".** The full name is what appears in
  every user-facing, legal, and packaging string — the installer `productName`,
  the NSIS publisher and copyright lines, the README title, and the docs. The
  short form "Griddle WM" survives only in the tray tooltip, where a single
  cramped line also has to carry the grid-full message.
- **Repository: `https://github.com/DadsDoingDesign/GriddleWindowManager`.**
  This is the canonical URL, including the updater endpoint in
  `tauri.conf.json`.
- **Internal identifiers are frozen.** The bundle identifier `dev.griddle.wm`,
  the config directory `%APPDATA%\griddle-wm\`, the npm workspace names
  (`@griddle-wm/brain`, `@griddle-wm/desktop`), and the Rust crate name
  `griddle-wm` all keep their existing values. They shipped in v0.1.0; renaming
  them would orphan users' grids, templates, and app defaults for no user-facing
  benefit.

The free-OSS decision materially lowers the trademark exposure analysed in §5;
see the note added there.

## 1. What this app actually is

| Layer | Technology | License | Who owns it |
|---|---|---|---|
| Desktop shell | Tauri 2 | MIT / Apache-2.0 | Tauri contributors |
| Native layer | Rust + `windows` crate | MIT / Apache-2.0 | Rust project, Microsoft |
| UI framework | Svelte 5 + Vite | MIT | Svelte / Vite contributors |
| Layout engine | `@griddle/core`, `@griddle/svelte` | MIT | **You (Trustybits)** |
| Renderer | WebView2 (OS component) | Microsoft redistributable | Microsoft |
| Installer | NSIS | zlib | NSIS contributors |

271 Rust crates and 80 npm packages resolved. Every one declares a license;
none is missing or ambiguous.

## 2. License findings — clean

**No GPL, AGPL, LGPL, SSPL, CC-BY-SA, or proprietary code anywhere.** Nothing
in the tree can force you to publish your source.

The only copyleft present is **MPL-2.0**, in five Rust crates consumed
unmodified: `cssparser`, `cssparser-macros`, `dtoa-short`, `selectors` (all via
`dom_query`), and `option-ext` (via `dirs-sys`). MPL-2.0 is *file-level*
copyleft — it reaches only its own files, never your code. Binary
redistribution in a paid, closed-source product is expressly permitted so long
as recipients are told where to get those files' source. `THIRD-PARTY-LICENSES.md`
does that.

The one thing that would change: if you ever fork, patch, or vendor one of
those five crates, the modified files must be published under MPL-2.0.

Two npm MPL packages (`lightningcss` and its Windows binding) are build-time
only and never ship, so no obligation attaches.

## 3. Attribution — who to credit

Ship `THIRD-PARTY-LICENSES.md` with the product. That single file discharges
essentially every obligation, because MIT, BSD-3-Clause, ISC, and Zlib all
require their copyright notice and license text to travel with binary
redistribution. As of this review it is installed to disk alongside the app
(`bundle.resources`), and the MIT license is shown as the installer's license
page — before that fix, the notices existed only in the repo, which satisfies
nothing for a user who never sees the repo.

Specific credits worth making by name in your README or About screen:

- **Tauri** — the app shell, tray, and updater machinery.
- **Svelte** — the UI.
- **Rust `windows` crate** — Win32 bindings.
- **Griddle** — your own library; credit it prominently, since the whole
  product is a showcase for it.

Apache-2.0 §4 also requires propagating any upstream `NOTICE` file. All 271
crate source directories were scanned: **none ships one**, so the license text
alone suffices. Re-check if the dependency tree changes materially — `tao` is
Apache-2.0-only and is a hard dependency.

## 4. Can this be published? Yes.

Two exposures were found and fixed during this review:

1. **Third-party brand marks were shipping in the installer.** The Vite/Svelte
   scaffold left `public/favicon.svg` and `public/icons.svg` in the repo, the
   latter containing GitHub, Discord, X, and Bluesky logos. Nothing referenced
   them, but Vite copied them into `dist/` and NSIS packaged them. Those are
   *trademarks* — attribution would not cure redistributing them. Both files
   are deleted.
2. **License notices never reached the user.** Fixed via `bundle.resources` +
   `licenseFile` as described above.

Remaining known-and-accepted items: the binary is unsigned, so SmartScreen
warns on first run (documented honestly in the README); code signing is the fix
if you go commercial.

## 5. Trademark: the name is the real commercial risk

**"GRIDDLE" is a live registered US trademark** (Reg. 5082174, GRIDDLE INC.,
filed 2016) covering *social-media-marketing software as a service*.

Trademark protection turns on likelihood of confusion within a market, and a
Windows window manager is a long way from social media marketing SaaS. For a
free open-source project this is low risk. For a **paid product with marketing
spend**, it is a real, if modest, exposure — and the cheapest time to change a
name is before anyone knows it.

Mitigations, cheapest first: keep the name for free/OSS release; or ship
commercially under a distinct product name while the npm library keeps the
`@griddle` scope you already own; or clear the name properly with a trademark
attorney (a few hundred dollars for a screening search).

**Resolved for v0.2.0 (2026-08-10): keep the name.** With the free-OSS decision
in §0, the cheapest mitigation is the one that applies. The registered GRIDDLE
mark covers social-media-marketing SaaS; a free Windows window manager is a
distant market, sold to different buyers through different channels, and there
is no marketing spend building consumer association in the registrant's class.
The residual risk is low and it is accepted. Two conditions attach:

- The full product name is **"Griddle Window Manager"**, which reads as a
  descriptive compound rather than as the bare mark.
- **This decision is scoped to the free OSS release.** If the project ever
  takes money — paid tier, sponsorware, commercial license — §5's original
  analysis reapplies at full weight and the name must be cleared by an attorney
  before any spend.

## 6. How much architecture to expose

**Expose all of it. The architecture is the asset, not the secret.**

Nothing here is a trade secret: `SetWinEventHook` + `DeferWindowPos` is the
documented, obvious way to manage Windows windows, and any competent developer
would arrive at it. What is *distinctive* is the judgment — a TypeScript brain
as single source of truth with Rust as a thin actuator, real windows as puppets
of grid state, preview-on-drag with commit-on-release, expected-rect matching to
suppress feedback loops. That story is worth telling in public: it demonstrates
engineering taste, which is what a portfolio or a launch post is actually
selling. It also markets Griddle-the-library far better than the library's own
README can.

Publish freely: the design spec, the architecture diagram, the brain/hands
split, the security posture, the movement-rules integration, the test strategy,
and the library-feedback findings (dogfooding your own library and filing the
gaps is a *credibility* story).

Keep private only: signing keys and update-endpoint credentials; and, if you
ever add paid licensing, the license-validation logic and its keys — not because
the approach is secret, but because publishing the validator hands out the
bypass.

## 7. Can you charge for it? Legally yes. Commercially, be clear-eyed.

**Legally: unambiguous yes.** Every dependency is permissive; MPL-2.0 explicitly
allows paid closed-source binary distribution with the notice you now ship.
Nothing obliges you to release source, and nothing caps what you charge.

**Commercially, the honest picture.** The competitor is Microsoft PowerToys
FancyZones: free, first-party, preinstalled for many developers, and good
enough for most people. Anyone charging in this category is selling past that.
Market comparables: DisplayFusion ~$39 one-time, AquaSnap Pro ~$18,
macOS equivalents (Magnet, Moom, Rectangle Pro) $10–15. The realistic price
band for a Windows window manager is **$10–25 one-time**, not subscription.

What Griddle Window Manager genuinely has that FancyZones does not: live collision reflow
(neighbors push each other rather than sitting in static zones), grid
restructuring in a live editor, the overlay/collision mode switch, spanning
grids, and startup views. Those are real differentiators, but they need to be
*shown* — this product sells on a 20-second GIF, not a feature list.

Three viable models, best first:

1. **Free and open-source, monetized indirectly.** Ship MIT on GitHub, let it
   drive attention to Griddle-the-library and to you. Best expected value if
   the goal is reputation, and by far the lowest operational burden — no
   licensing, no support SLA, no refunds, no trademark spend.
2. **Sponsorware / open-core.** Source public; free for personal use, paid
   license for commercial use (the model `komorebi` uses successfully in this
   exact category). Preserves the credibility of open source while creating a
   revenue path. Requires an honest license and light enforcement.
3. **Paid closed-source, $15–20 one-time.** Highest revenue ceiling per user,
   but you take on code signing (~$10/month Azure Trusted Signing, or
   $100–400/year OV certificate), a payment processor, license-key
   infrastructure, refunds, and support — against a free Microsoft incumbent.
   Only worth it if you intend to market it properly.

**A caveat that matters for any paid path:** this codebase was largely
AI-generated. Under current US Copyright Office guidance, purely AI-generated
material is not copyrightable; protection attaches to human-authored
contributions — here, the design decisions, specifications, and direction, which
are substantial and yours. In practice this does not stop you selling the
software (you can license and sell what you distribute regardless), but it may
weaken your position against someone who copies the code outright. If enforceable
exclusivity matters to your business model, discuss it with an IP attorney and
keep the design docs and commit history — they evidence the human authorship.

## 8. Recommended sequence

1. Rebuild and verify the installer carries `LICENSE.txt` and
   `THIRD-PARTY-LICENSES.md` — done in this review.
2. Run `docs/smoke-test-v0.2.0.md` on real hardware before any public release.
3. ~~Decide free-OSS versus paid~~ — decided: free OSS (§0). The update
   endpoint now points at the canonical repository; there is no signing spend
   and the name does not need clearing at this scope.
4. If publishing: capture the demo GIF first. It is the whole pitch.
