# Releasing Griddle Window Manager

Human steps for cutting a release. The build itself is automated
([`.github/workflows/release.yml`](../.github/workflows/release.yml)) and fires
on a pushed `v*` tag; everything below is the part a person has to do.

> **Never paste, echo, log or screenshot the private signing key.** It lives at
> `~/.griddle-wm-keys/griddle-wm.key`, outside the repository, and `.gitignore`
> blocks `*.key` / `*.pem` as a second line of defence. Anyone holding it can
> sign an update that every installed copy of the app will accept as genuine.

---

## One-time: repository secrets

Both secrets go in **Settings → Secrets and variables → Actions → Repository
secrets** on
<https://github.com/DadsDoingDesign/GriddleWindowManager>.

### `TAURI_SIGNING_PRIVATE_KEY`

The **contents** of `~/.griddle-wm-keys/griddle-wm.key` — the whole file,
including the `untrusted comment:` first line and the trailing newline. Not the
path to it.

Get it into the clipboard without it appearing anywhere on screen or in shell
history:

```powershell
Get-Content "$env:USERPROFILE\.griddle-wm-keys\griddle-wm.key" -Raw | Set-Clipboard
```

Paste into the secret's value box, save, then clear the clipboard:

```powershell
Set-Clipboard -Value ' '
```

Do **not** `cat` the file, do not open it in an editor that syncs, and do not
put it in a scratch file. GitHub masks the value in Actions logs once it is a
secret, but only there.

### `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

**An empty string.** The key was generated without a passphrase, so the value is
blank — create the secret with an empty value rather than omitting it. Tauri's
signer expects the variable to exist; if it is missing entirely the build fails
with a password prompt it cannot answer in CI.

GitHub's UI will accept an empty secret value. If it refuses, create it with a
single space and remove the space.

### Verifying the pair matches

The public half pinned in
[`apps/desktop/src-tauri/tauri.conf.json`](../apps/desktop/src-tauri/tauri.conf.json)
(`plugins.updater.pubkey`) must correspond to the private key in the secret. It
is the base64 of `~/.griddle-wm-keys/griddle-wm.key.pub`. Confirm they still
line up before the first release from a new machine:

```powershell
# Safe to run — this only touches the PUBLIC key.
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
  (Get-Content "$env:USERPROFILE\.griddle-wm-keys\griddle-wm.key.pub" -Raw)))
```

Compare against `plugins.updater.pubkey`. If they differ, every client will
reject the signature and the update will silently never install — the release
will look fine and do nothing.

---

## Cutting a release

### 1. Land everything on `master` with CI green

`npm run test -w packages/brain`, `cargo test` (from `apps/desktop/src-tauri`)
and `npm run build -w apps/desktop` all pass — CI runs exactly these.

### 1b. Re-check the attribution and network gates — if any dependency moved

Skip only if neither `Cargo.lock` nor `package-lock.json` changed since the
last release. Otherwise all three must hold; a stale
`THIRD-PARTY-LICENSES.md` ships a binary whose components are not attributed,
which is the one legal defect a user can catch by reading the file.

```powershell
cd apps/desktop/src-tauri

# (a) Nothing but the updater may pull in an HTTP client.
#     Expect exactly: reqwest -> tauri-plugin-updater -> griddle-wm
cargo tree -i reqwest -e normal --target x86_64-pc-windows-msvc

# (b) The linked closure must match what THIRD-PARTY-LICENSES.md lists.
#     Its header states the crate count; compare against this.
cargo metadata --format-version 1 --filter-platform x86_64-pc-windows-msvc
```

```powershell
# (c) No webview-side network calls — all traffic stays behind the Rust plugin.
#     Expect no matches.
Select-String -Path apps/desktop/src -Pattern 'fetch\(|XMLHttpRequest|WebSocket|EventSource' -Recurse
```

If the closure moved, regenerate `THIRD-PARTY-LICENSES.md` by the method its
own "How this list was produced" section documents, add any newly distinct
license text, correct the counts in the header and in
[`legal-and-commercial-review.md`](legal-and-commercial-review.md), and re-run
the "no GPL/AGPL/LGPL/SSPL" check against the new closure. If the network
surface moved, update finding 6 in
[`security-review.md`](security-review.md).

### 2. Run the human smoke pass — before tagging

Build the installer locally and work through
[`smoke-test-v0.2.0.md`](smoke-test-v0.2.0.md) (or the current version's file):

```powershell
cd apps/desktop
npx tauri build
# → src-tauri/target/release/bundle/nsis/Griddle Window Manager_<version>_x64-setup.exe
```

Every **P0** item must be checked off by a human at a real GUI. The automated
suites cover logic only; the pixels have to be seen once.

This happens *before* the tag because the release workflow publishes a **live,
non-draft** release. The updater endpoint
`.../releases/latest/download/latest.json` only resolves to a published
non-prerelease release, so there is no "tag it, smoke it, then publish" order
available. A tag is a promise the build is good.

Add a version section to the smoke-test file for any GUI-only behaviour the
release introduces.

### 3. Bump the version

The version appears in **five tracked files** plus two lockfiles. They must all
agree — the NSIS installer filename, the updater's `latest.json` and the app's
own "you are on version X" comparison are all derived from them, and a mismatch
between `tauri.conf.json` and the published tag makes the updater think an
update is available forever.

| File | Field |
| --- | --- |
| `package.json` | `version` |
| `packages/brain/package.json` | `version` |
| `apps/desktop/package.json` | `version`, **and** the `@griddle-wm/brain` dependency range |
| `apps/desktop/src-tauri/tauri.conf.json` | `version` — this is the one the installer and updater use |
| `apps/desktop/src-tauri/Cargo.toml` | `[package] version` |

Then refresh the lockfiles so the workflow's `--locked` / `npm ci` steps do not
fail:

```powershell
npm install                                  # updates package-lock.json
cd apps/desktop/src-tauri; cargo check; cd ../../..   # updates Cargo.lock
```

Sanity check that nothing was missed:

```powershell
Select-String -Path package.json,packages\brain\package.json,apps\desktop\package.json,apps\desktop\src-tauri\tauri.conf.json,apps\desktop\src-tauri\Cargo.toml -Pattern '"?version"?\s*[:=]'
```

Also update `README.md` where it names the installer filename and the
"New in x.y.z" section, and move anything newly shipped out of
[`deferred.md`](deferred.md).

### 4. Commit, tag, push

The tag name must be `v` + the exact version in `tauri.conf.json`.

```powershell
git add -A
git commit -m "release: v0.3.0 — <one-line summary>"
git tag v0.3.0
git push origin master
git push origin v0.3.0
```

Push the branch first, then the tag: the workflow checks out the tag, and a tag
that points at an unpushed commit will fail to resolve.

### 5. Watch the workflow

**Actions → Release**. It reruns both test suites, then builds and publishes.
On success the release at
`https://github.com/DadsDoingDesign/GriddleWindowManager/releases/tag/v0.3.0`
carries:

- `Griddle Window Manager_0.3.0_x64-setup.exe` — the installer people download
- `Griddle Window Manager_0.3.0_x64-setup.nsis.zip` — the updater payload
- `Griddle Window Manager_0.3.0_x64-setup.nsis.zip.sig` — its minisign signature
- `latest.json` — the updater manifest

If `latest.json` is absent, the signing env vars did not reach the build. If the
release came out as a draft, `releaseDraft` was flipped — publish it manually or
the updater endpoint stays broken.

### 6. Verify the updater sees it

The endpoint is a fixed URL that GitHub redirects to the newest published
release, so it must resolve *without* the version in the path:

```powershell
# Should return 200 and JSON with "version": "0.3.0"
Invoke-RestMethod https://github.com/DadsDoingDesign/GriddleWindowManager/releases/latest/download/latest.json
```

Check three things in the response:

1. **`version`** matches the release you just cut (no leading `v` — Tauri writes
   the bare version here even though the tag has the prefix).
2. **`platforms.windows-x86_64.url`** points at the `.nsis.zip` asset of this
   release and returns 200.
3. **`platforms.windows-x86_64.signature`** is a non-empty minisign blob. Empty
   or missing means the build ran unsigned; clients will refuse it.

Then check it end to end from the app: install the *previous* version, enable
the update check in Settings, and confirm it offers the new one and installs it.
The updater is opt-in and off by default, so a broken update path is quiet —
this manual pass is the only thing that catches it.

Finally, download the installer from the release page yourself and install it on
a clean profile. Expect the SmartScreen warning (the binaries are unsigned, by
design and documented in the README); confirm *More info → Run anyway* proceeds
and the app launches.

---

## If something went wrong

- **Bad build published.** Delete the release *and* the tag
  (`git push origin :refs/tags/v0.3.0`), fix, and cut the next patch version.
  Do not reuse a tag: anyone who already pulled has the old commit, and clients
  cache release metadata.
- **Signature rejected by clients.** The secret and the pinned `pubkey` have
  diverged. Rotating the key is a breaking change for the updater — every
  already-installed copy trusts only the old public key and will have to be
  updated by hand. Do not rotate casually.
- **Never** commit the key, paste it into an issue, or attach it to a release.
