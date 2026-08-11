# Landing Page — Prompt for a New Chat

Copy everything between the rules into a new Claude Code session, run from the
repository root. It is written to be self-contained: the new session will have
none of this conversation's context.

---

I want to build a landing page for **Griddle Window Manager**, a free
open-source grid-based window manager for Windows 11. The repository is
`DadsDoingDesign/GriddleWindowManager` and you are in it now. The page will
live in `site/` in this same repository and deploy to Vercel. `site/README.md`
documents the project settings and the deploy config already in place — read it
before changing anything about how the site ships.

**Before you write anything, use the `superpowers:brainstorming` skill**, then
`superpowers:writing-plans`. Do not skip to implementation. This project earned
its quality by speccing first, and I want the same discipline here.

## What the product is

Read `README.md` first — it is accurate and recently copy-edited. In short:
Windows' built-in snapping gives you halves and quarters; this gives you a real
grid (say 12×6) where any window claims any rectangle of cells. Drag a window
and a translucent overlay shows where it lands and which neighbours get pushed.
There are templates, per-app default positions, whole-desktop "views" restored
at startup, and grids that span multiple monitors.

The layout engine underneath is [Griddle](https://github.com/Trustybits/griddle)
(`@griddle/core`, `@griddle/svelte`) — a third-party MIT library by Trustybits.
This app consumes it; it did not author it. Credit it, never imply ownership.

## The one non-obvious idea

**The hero should be a live, interactive grid built with `@griddle/svelte` —
the product's own engine, running in the page.** Visitors drag fake "app
windows" (Figma, Slack, VS Code, a browser) around a grid and watch neighbours
reflow exactly as the real app behaves. The marketing claim and the
demonstration become the same object, and it cannot lie about what the product
does.

Make this work on touch, respect `prefers-reduced-motion`, and ensure it
degrades to a static image if JS fails. It must never block LCP.

## Required elements

- **Primary CTA: download the installer.** Link it directly to
  `https://github.com/DadsDoingDesign/GriddleWindowManager/releases/latest/download/GriddleWindowManager-x64-setup.exe`.
  `release.yml` publishes that version-free alias alongside the versioned
  installer, so the URL is permanent and the page makes no network request to
  resolve it — at build time or at runtime. Never hardcode the versioned
  filename (`Griddle Window Manager_0.2.0_x64-setup.exe`); it changes every
  release. If you want to show the version number beside the button, read it at
  build time from `releases/latest/download/latest.json` and omit the label
  when the fetch fails. See `site/README.md`.
- **Secondary CTA: the GitHub repository.** Visually subordinate to download,
  but easy to find — for this audience the repo link builds trust.
- **Honest framing.** Windows 11 only. The binary is unsigned, so SmartScreen
  warns; say so near the download rather than burying it. Free, MIT, no
  account, no telemetry. Updates are opt-in and off by default.
- **Proof over adjectives.** Real screenshots of the real settings window and
  overlay. No invented testimonials, no fake user counts, no logo walls of
  companies that do not use this.

## Quality bar

Research how the best B2B SaaS and developer-productivity sites solve these
problems, then encode what you learn as an explicit written rubric before you
design. Reference points worth studying — pick the lessons, not the pixels:

- **Linear, Vercel, Resend, Clerk** — typographic discipline, restraint, dark
  mode done properly rather than inverted.
- **Raycast, Warp, Cursor, Arc** — the closest analogues: desktop apps with
  download-first funnels and a free tier.
- **CleanShot X, Obsidian, Tailscale** — credible download pages for utilities,
  including how they handle "unsigned"/security friction and OS requirements.
- **Stripe, Framer** — interactive product demonstration in the hero.

Write the rubric as weighted, *measurable* criteria in
`site/docs/rubric.md`. Cover at least:

1. **Five-second test** — can a stranger say what it is, who it is for, and
   what to do next?
2. **Product truth** — real UI, no abstract illustration standing in for the
   product.
3. **Typography** — a considered scale, 60–75ch measure, at most two families.
4. **Colour & contrast** — WCAG AA minimum body text, AAA where achievable;
   light and dark both designed, not one inverted.
5. **Motion** — purposeful, interruptible, `prefers-reduced-motion` honoured.
6. **Performance budget** — LCP < 1.5s, CLS < 0.05, total transferred < 500 KB,
   no render-blocking third-party anything, self-hosted fonts.
7. **Responsive** — 360px to 2560px, no horizontal scroll at any width.
8. **Accessibility** — keyboard-navigable, visible focus states, semantic
   landmarks, meaningful alt text, and the hero demo usable without a mouse.
9. **Conversion clarity** — one unmistakable primary action per viewport.
10. **Craft** — consistent spacing and radius scales, real hover/active/focus
    states, optical alignment, zero default-browser styling left showing.

**Everything must score above the bar, not at it.** Set the passing threshold
in the rubric and hold to it.

## How to work

Mirror the workflow that built this app — it is why the app is good:

- **Spec before code.** Brainstorm, then a design doc, then a plan with
  discrete tasks. Save them under `site/docs/`.
- **Verification is not self-assessment.** After each build iteration, run
  *adversarial judge agents* that score the page against the rubric
  independently and try to fail it. Take screenshots at multiple viewports and
  actually look at them. Run Lighthouse and axe and report real numbers — never
  claim a score you did not measure.
- **Loop until it clears the bar.** Iterate design → judge → fix. Stop when two
  consecutive judging rounds surface nothing blocking, not when you are bored.
- **No placeholders.** No lorem ipsum, no dead links, no "coming soon", no
  invented metrics.
- **Copy is a deliverable.** Run the copy through the
  `anthropic-skills:copywriting-eos` skill before you call it done. Vigorous
  writing is concise; the README's voice is the reference — plain, specific,
  and willing to state limitations.
- **Commit as you go**, with the repo-local git identity already configured
  here. Never commit secrets.

## Constraints

- Static output only. Vercel can run a server, but nothing here needs one, and
  a page with no runtime dependencies cannot break at 2am. Choose the stack in
  brainstorming; SvelteKit with `adapter-static` is the obvious candidate since
  `@griddle/svelte` is already a dependency here, but argue it rather than
  assuming it. Whatever you pick, set the Build Command and Output Directory in
  the Vercel dashboard to match, and update the table in `site/README.md`.
- Do not disturb the app: `packages/brain`, `apps/desktop`, and the existing
  `.github/workflows/ci.yml` and `release.yml` must keep passing untouched.
  Vercel builds the site; it needs no workflow of its own.
- Self-host all fonts and assets. No CDNs, no analytics, no trackers — the
  product promises no telemetry and the site should keep that promise.
- The site is MIT like the rest of the repo.

Start by reading the repository, then brainstorm with me.

---

## Repo guidance (my recommendation: same repo)

**Keep the site in this repository, in `site/`, deployed to Vercel with the
project's Root Directory set to `site`.**

Reasons, strongest first:

1. **One pull request changes the product and the page it describes.** A
   release that renames a feature can update the copy in the same diff, and
   Vercel attaches a preview URL to that pull request, so the reviewer sees the
   claim and the thing it claims about together. Across repos this becomes two
   pull requests that merge at different times, and the site is wrong in
   between.
2. **Stars and traffic stay in one place.** For a FOSS project, stars on the
   code repository are the credibility signal. A separate site repo splits
   attention and accumulates none.
3. **The site cannot drift from the product.** Screenshots, version numbers,
   and feature copy live beside the code they describe.
4. **The download link depends on a workflow in this repo.** `release.yml`
   publishes the version-free installer alias the button points at. Same repo,
   that dependency is visible and testable; across repos it is invisible until
   it breaks.

Use `site/`, not `docs/` — `docs/` holds the design specs, and they are not a
website.

**When a separate repo would win:** if the site becomes a multi-product
marketing property, if you want a genuinely different tech stack and release
cadence, or if you later hand the site to someone who should not have commit
rights to the app. None of these apply today, and moving a static site between
repositories later is an afternoon's work.

A custom domain is DNS pointed at Vercel — see `site/README.md`. Do not add a
`CNAME` file; that is a GitHub Pages mechanism and means nothing here.
