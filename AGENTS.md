# AGENTS.md

Notes for AI agents (and humans) working on this repo.

## Publishing the neural-weights workspaces

The `neural-weights-<locale>` workspaces ship binary artifacts (`model.onnx`,
`tokenizer.model`) that are **not** committed to git. Two scripts cooperate to
get those files in place:

- `<workspace>/scripts/link-dev-weights.sh` — used during local development.
  Symlinks the artifacts from `/mnt/playpen/mailwoman-data/...` into the
  workspace so `@mailwoman/neural` can find them at runtime.
- `scripts/copy-weights.mjs` — invoked by release-it's `before:init` hook.
  Copies the real binaries into each workspace so `yarn npm publish` picks them
  up via the `files` array.

### Pitfall: `fs.copyFile` follows symlinks at the destination

If `link-dev-weights.sh` has been run, the workspace's `model.onnx` /
`tokenizer.model` are symlinks pointing at `/mnt/playpen/...`. A naïve
`fs.copyFile(SOURCE, dest)` follows the symlink at `dest` and writes through
it — the symlink stays in place. `yarn npm publish` then refuses to upload the
tarball and the registry returns HTTP 415 (`YN0035: Symbolic link is not
allowed`).

`scripts/copy-weights.mjs` mitigates this by `unlink`ing each destination
before copying. **Any new script that materializes files into these workspaces
must do the same** (or use `cp --remove-destination` / `fs.cp` with equivalent
semantics). The same caution applies if a similar dev-symlink helper is added
for other workspaces in the future.

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
    node scripts/publish-workspace.mjs || break
  done
  ```
