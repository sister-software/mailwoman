# AGENTS.md

Notes for AI agents (and humans) working on this repo.

## Publishing the neural-weights workspaces

The `neural-weights-<locale>` workspaces ship binary artifacts (`model.onnx`,
`tokenizer.model`) that are **not** committed to git. Multiple pieces cooperate
to get those files in place — be careful when changing any of them:

- `<workspace>/scripts/link-dev-weights.sh` — symlinks the artifacts from
  `/mnt/playpen/mailwoman-data/...` into the workspace so `@mailwoman/neural`
  can find them during local dev.
- `neural/test/weights.test.ts` — invokes `link-dev-weights.sh` to verify
  auto-resolve. **Running `yarn test` re-creates the symlinks** in
  `neural-weights-en-us/` as a side effect.
- `scripts/copy-weights.mjs` — invoked by release-it's `before:init` hook.
  Materializes the real binaries into each workspace.
- `scripts/publish-workspace.mjs` — invoked per workspace by release-it. Calls
  `yarn npm publish` and, as a final safety net, dereferences any symlinks
  among the workspace's declared `files` before publishing.

### Pitfall: symlinks in the publish tarball

`yarn npm publish` refuses to upload tarballs containing symlinks — the
registry returns HTTP 415 (`YN0035: Symbolic link is not allowed`). Two
specific traps make this easy to hit:

1. **`fs.copyFile` follows symlinks at the destination.** A naïve
   `fs.copyFile(SOURCE, dest)` where `dest` is a symlink writes through the
   symlink — the symlink stays in place. `scripts/copy-weights.mjs` mitigates
   this by `unlink`ing each destination first. Any new script that
   materializes files into these workspaces **must do the same** (or use
   `cp --remove-destination` / `fs.cp` with equivalent semantics).
2. **Tests re-create symlinks.** `weights.test.ts` calls `link-dev-weights.sh`
   on every run. Even if `copy-weights.mjs` was already run, a subsequent
   `yarn test` (manual or otherwise) re-symlinks `neural-weights-en-us/`.

To make publish robust regardless of repo state, `scripts/publish-workspace.mjs`
walks the workspace's `package.json` `files` array right before
`yarn npm publish` and dereferences any symlinks
(`readlink` → `unlink` → `copyFile`). **Do not remove this safety net** — it
closes the window between `copy-weights.mjs` (one-shot, at `before:init`) and
the actual publish.

### Recovering from a partial release

If a release fails partway through publishing:

- The git commit + tag are already created by release-it.
- `yarn npm publish --tolerate-republish` (used by
  `scripts/publish-workspace.mjs`) makes re-publishing already-published
  versions a no-op.
- Fix the underlying issue, then resume by invoking the publish script
  directly for each remaining workspace:

  ```bash
  for ws in <remaining workspaces>; do
    RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE=./$ws \
    RELEASE_IT_WORKSPACES_TAG=latest \
    RELEASE_IT_WORKSPACES_ACCESS=public \
    RELEASE_IT_WORKSPACES_OTP=<otp-if-needed> \
    node scripts/publish-workspace.mjs || break
  done
  ```

  npm 2FA OTPs expire in ~30s, so do this in quick succession; a single OTP
  usually covers all remaining workspaces.
