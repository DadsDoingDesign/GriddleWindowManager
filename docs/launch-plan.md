# Launch Plan — Getting Test Users for v0.2.x

Written 2026-08-12, two days after the repository went public. The goal here is
**test users**, not stars: people on Windows 11 who will install the thing, use
it for a week, and tell us what broke. Stars are a side effect.

State of the world at the time of writing: repository public, one release
(v0.2.0), zero stars, zero issues, no screenshots anywhere, binaries unsigned,
Discussions off, no winget or Scoop manifest, and the homepage
(`griddle-window-manager.vercel.app`) resolves to the interactive prototype
rather than a landing page.

## 1. What we are selling

The pitch is already one sentence and it is a good one:

> Windows' snapping gives you halves and quarters. This gives you a 12×6 grid,
> and any window can claim any rectangle of cells.

Three things differentiate this from PowerToys FancyZones, which is the
comparison every reader will make within five seconds:

1. **Reflow.** The dropped window lands exactly where you aimed and the
   neighbours reorganise around it, moving as few as possible. FancyZones drops
   a window into a zone; it does not rearrange the rest of the desktop. This is
   the demo. Lead with it everywhere.
2. **Spanning grids.** One grid across the combined work area of several
   monitors, with L-shaped dead space excluded. This is the wedge into the
   ultrawide and multi-monitor crowd, who are the most underserved and the most
   vocal.
3. **Views.** The whole desktop — every grid, every program's cell — saved and
   restored at startup by executable name, so it survives reboots.

Supporting, credible, and worth stating plainly rather than shouting: MIT, free,
no account, no telemetry, no remote content, update check opt-in and off by
default. That story lands well on Hacker News and r/opensource and is worth
nothing on r/Windows11 — audience it accordingly.

## 2. What will get us killed in the comments

Be honest about the trust deficit, because it is stacked:

- A **two-day-old repository** with **zero stars**,
- shipping an **unsigned installer** that trips SmartScreen,
- from an author nobody has heard of,
- with a README that says **most of the implementation was AI-authored**.

Any one of those is survivable. All four in a Reddit thread reads as "do not
run this stranger's .exe," and that will be the top comment unless we get in
front of it. The mitigations are in §3 and they are not optional.

The AI-authorship disclosure stays. It is checkable, the specs and the full
commit history are in the repository, and removing it would be worse than
useless — someone would find out. But *placement* matters: it belongs in the
README and in an honest answer when asked, not in the first line of a launch
post. Lead with what the software does and how it was tested; answer the
authorship question directly when it comes, once, without defensiveness.

Two more things to have an answer ready for:

- **"Where are the keyboard shortcuts?"** The tiling-window-manager crowd is
  the loudest potential advocate we have and keyboard-driven tiling is the
  first thing they will ask for. It is deferred, it is honest to say so, and it
  should probably be the next feature.
- **"Why is it called Griddle when Griddle is someone else's library?"** The
  full name — *Griddle Window Manager for Windows 11* — is what we post, every
  time. The bare word collides with the upstream library, with cooking
  equipment, and with everything a search engine thinks you meant. Not worth
  renaming; worth never abbreviating in public.

## 3. Before posting anywhere

Roughly a day of work, and skipping it wastes every channel below. These are
ordered by how much damage their absence does.

1. **A demo GIF.** Ten to fifteen seconds: drag one window across a 12×6 grid
   and let the neighbours reflow. This is a spatial product being marketed in
   visual channels with no visuals at all — it is the single highest-return
   task in this document. Plus three stills: the overlay mid-drag, the
   templates gallery, and a spanning grid across two monitors. Drop them at
   `docs/media/`; the README already has the placeholder comment waiting.
   (Already tracked as a line item in the release smoke pass.)
2. **A VirusTotal link** for the installer, in the release notes and beside the
   SmartScreen section of the README. Costs one upload, removes the top comment.
3. **Turn on GitHub Discussions** with a "Feedback" category. Issue templates
   today cover bug reports and feature requests; a test user's most valuable
   report is "this felt weird when I did X," which is neither. Link it from the
   release notes.
4. **Say what we want tested.** A short section in the release notes naming the
   three areas — spanning grids (newest, least mileage), per-app defaults,
   reflow correctness under many windows — and exactly what to send back: one
   sentence and their `config.json`.
5. **A Scoop manifest** (`extras` bucket) and a **winget-pkgs** pull request.
   `winget install GriddleWindowManager` is distribution and trust laundering
   at the same time, and winget was already a planned fast-follow. Scoop is the
   faster of the two and its audience is exactly our early-adopter profile.
6. **Decide the signing answer.** SignPath offers free certificates to open
   source projects, and Azure Trusted Signing has an individual tier in the
   ten-dollars-a-month range with identity checks — verify both against their
   current terms. Even "applied, in progress" is a better answer in a comment
   thread than "certificates cost money."

One asset we already have and undervalue: **the interactive prototype at
`site/demo/`**. It lets someone understand reflow in ten seconds with no
download and no SmartScreen dialog. In every post below, the browser demo is
the first link and the installer is the second.

## 4. Where to post

Ranked by yield of *actual testers per post*, not by reach.

### Tier 1 — people whose pain is exactly this

| Channel | Why | Angle |
|---|---|---|
| **r/ultrawidemasterrace** | The best-fit audience anywhere. Halves and quarters are useless on a 49" monitor and they know it. | The GIF, a 16×6 grid on an ultrawide, "any window, any rectangle." |
| **r/multimonitor** | Spanning grids are a headline feature and almost nobody else ships them. | One grid across three displays, dead space excluded. |
| **r/Windows11**, **r/windows** | The general Windows-utility pipeline. | FancyZones comparison, stated plainly and fairly. |
| **r/software** | Built for exactly this kind of post. | Free, MIT, no telemetry, here is the GIF. |
| **r/opensource**, **r/coolgithubprojects**, **r/SideProject** | Forgiving of a v0.2.0 and receptive to "please break this." | The engineering split and the test suite. |
| **AlternativeTo** | Evergreen long-tail: people who already searched for this. | List as an alternative to FancyZones, Magnet, Divvy, GridMove, WindowGrid. |

Read each subreddit's self-promotion rules first — several require a flair, a
specific day, or prior comment history, and the ones that don't will still bury
an account whose entire history is one link. Upload the GIF natively rather
than posting a bare link; Reddit downranks link posts.

### Tier 2 — developers, who tolerate rough edges and file excellent bugs

- **Show HN.** Worth exactly one shot, so spend it after the GIF, Discussions,
  and a Scoop manifest exist. The angle that works on Hacker News is the
  architecture — *TypeScript brain, Rust hands: every layout decision is pure
  TypeScript with 330 tests and no Win32 anywhere near it* — with the product
  as the payoff. Weekday morning US Eastern. Be in the thread for the first
  three hours. Prepared answers: keyboard tiling, unsigned binaries, AI
  authorship, and how it differs from FancyZones.
- **Tauri Discord `#showcase` and a PR to `awesome-tauri`.** A Tauri app that
  drives native Win32 windows is genuinely unusual there, and that community
  reliably amplifies shipped apps.
- **r/rust and This Week in Rust.** `SetWinEventHook` plus batched
  `DeferWindowPos` from Rust is a real post, not a plug.
- **r/sveltejs / Svelte Society showcase.** Svelte 5 in a shipped desktop app.
- **Trustybits/griddle, upstream.** Open a friendly issue offering to be listed
  as a real-world consumer and point at `docs/library-feedback.md`. Costs
  nothing, and their readers are pre-qualified.

### Tier 3 — reach, once there is a landing page and a video

- **Product Hunt.** After the landing page and a 30–60 second video. The
  audience skews Mac and SaaS, so expect moderate returns, but the backlink and
  the launch artifact get reused everywhere else.
- **Press tips to XDA-Developers, Neowin, How-To Geek, MakeUseOf.** These
  outlets publish "FancyZones alternatives" pieces on a schedule. A four-line
  email to a writer who has covered PowerToys — what it is, the GIF, why it is
  different, MIT and no telemetry — is free and occasionally works.
- **YouTube outreach.** Small and mid-sized Windows-tips channels, and
  ultrawide monitor reviewers. Send a twenty-second clip, not a wall of text.
- **MajorGeeks, Softpedia.** Long-tail search traffic, low effort, some
  downmarket baggage. Optional.
- **Mastodon (fosstodon), Bluesky, X.** The GIF plus one sentence. Low yield
  alone, useful as something for the other channels to link back to.

### Where not to bother

- **Issue trackers and subreddits belonging to other products** — including
  microsoft/PowerToys. It is spam and it burns the name.
- **r/productivity, r/pcmasterrace** — reach without intent.
- **All the subreddits in one day.** Spam filters notice, and so do people. One
  or two per week, with copy written for that audience, beats a simultaneous
  blast every time.

## 5. Sequence

- **Week 0** — everything in §3.
- **Week 1** — r/ultrawidemasterrace, then r/multimonitor a few days later.
  Highest fit, smallest blast radius; fix whatever the first twenty installs
  surface before more people see it.
- **Week 2** — r/Windows11, r/opensource, AlternativeTo, awesome-tauri, Tauri
  Discord, upstream Griddle.
- **Week 3** — Show HN, once the week 1–2 bugs are fixed and there is a v0.2.x
  whose release notes credit the reporters by name. "Fixed in the last week
  thanks to testers" is the strongest thing a Show HN post can contain.
- **After** — winget lands, landing page ships, then Product Hunt and press.

## 6. Measuring it without telemetry

We collect nothing from the app and that is not going to change, so attribution
comes from what GitHub already counts:

- Release asset **download counts** via the API — the closest thing to installs.
- Repository **Insights → Traffic**: views, unique visitors, and referring
  sites, which is what makes per-channel attribution possible.
- Stars, issues opened, and Discussion posts, bucketed by the week they landed.

Post to one channel at a time and the referrer data is legible. Post to six the
same day and it is noise.

## 7. The ask that actually produces testers

"Check it out" produces stars. A specific request with a number produces
testers:

> I need twenty people on Windows 11 with two or more monitors to try the
> spanning grids and tell me what breaks. It is the newest feature and the one
> I trust least.

That is the closing line of every Tier 1 post, adjusted to the audience. Naming
the weakest feature also buys credibility that no amount of adjectives will.
