# site/

The Griddle Window Manager website. Deployed to Vercel from this directory.

Today it holds one thing: `demo/index.html`, a self-contained interactive
prototype of the grid — inlined CSS, an inlined copy of the Griddle layout
engine, system fonts, and **no network requests at runtime**. `vercel.json`
rewrites `/` to it so the root URL is not a 404.

The real landing page is still to be built. `docs/landing-page-brief.md` at the
repository root is the spec.

## Vercel project settings

Most of the deploy config lives in `vercel.json` and is reviewable in pull
requests. These settings cannot be committed — they live in the Vercel
dashboard and have to be set by hand once. Getting the first two wrong is the
difference between a five-second deploy and Vercel trying to compile a Rust
application.

| Setting | Value | Why |
| --- | --- | --- |
| **Root Directory** | `site` | Scopes the project to this directory. Without it Vercel uploads the whole monorepo and tries to build the Tauri app. |
| **Include files outside of the Root Directory** | **off** | `site/` is self-contained; leaving this on defeats the setting above. |
| Framework Preset | Other | There is no framework yet. |
| Build Command | *(empty)* | Nothing to build. |
| Output Directory | `.` | Serve `site/` as-is. |
| Production Branch | `master` | |
| **Deployment Protection → Vercel Authentication** | **off for Preview** | On by default. Left on, it puts a login wall in front of preview URLs, which silently breaks Lighthouse, axe, and screenshot tooling — they measure the login page and report a number that means nothing. |
| **Web Analytics** | **off** | Injects a third-party script and beacons page views. The product promises no telemetry and the site keeps that promise. |
| **Speed Insights** | **off** | Same reason. |

Custom domain, when there is one: `A` record to `76.76.21.21`, or `CNAME` to
`cname.vercel-dns.com`. Confirm the current values in the Vercel dashboard
rather than trusting this table — they do change.

## Why builds do not fire on every commit

This is a monorepo, and Vercel builds on every push to the connected
repository regardless of Root Directory. Its automatic build-skipping only
understands Turborepo and Nx, and this repo uses neither, so `vercel.json`
sets an explicit `ignoreCommand`:

```
git diff --quiet HEAD^ HEAD -- .
```

It runs with the working directory set to `site/`. No changes here exits `0`
and Vercel skips the build; changes exit `1` and it builds. If `HEAD^` cannot
be resolved the command errors non-zero, which builds — failing toward a
deploy rather than toward a stale site.

Without this, every commit to `packages/brain` or the Rust shell redeploys the
marketing site.

## The download link

The installer filename carries the version
(`Griddle Window Manager_0.2.0_x64-setup.exe`), so
`releases/latest/download/<name>` cannot be hardcoded. Rather than resolve the
asset at build time and rebuild the site on every release, `release.yml`
uploads a **second copy of the same installer under a version-free name**:

```
https://github.com/DadsDoingDesign/GriddleWindowManager/releases/latest/download/GriddleWindowManager-x64-setup.exe
```

That URL is permanent. The download button is a plain `<a href>`, and the site
does not need rebuilding when a release publishes — no deploy hook, no
cross-service trigger, nothing to rot.

If the page ever wants to *display* the version number next to the button,
fetch it at build time from the updater manifest, which is also at a stable
URL and needs no GitHub API token:

```
https://github.com/DadsDoingDesign/GriddleWindowManager/releases/latest/download/latest.json
```

Read its `version` field. Do **not** reuse the `url` field inside it — because
`release.yml` sets `updaterJsonPreferNsis`, that points at the `.nsis.zip`
updater bundle, not the installer. If the fetch fails, omit the version label;
never fall back to a hardcoded number that will go stale.

## Known gap: `unsafe-inline`

The CSP in `vercel.json` earns most of its directives — `connect-src 'none'`
enforces the no-network-requests promise in the browser, and `frame-ancestors`,
`base-uri`, and `form-action` are all locked to nothing.

`script-src` and `style-src` still need `'unsafe-inline'`, because the demo's
entire engine and stylesheet are inlined in the HTML. Closing that means
extracting them to `/griddle.js` and `/griddle.css` — worth doing when the real
landing page is built, not worth churning the prototype for now.
