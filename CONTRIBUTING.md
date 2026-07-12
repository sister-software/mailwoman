# Contributing to Mailwoman

Thanks for wanting to help. Mailwoman is a postal-address parser — a calibrated,
retrieval-augmented neural sequence labeler plus a Who's on First gazetteer
resolver — and there's plenty to do at every layer: the model, the resolver, the
CLI, the docs, the data pipelines.

This guide covers the general flow. If you're touching the **model** (training,
shards, evals), read [`docs/articles/plan/CONTRIBUTING_MODEL_WORK.mdx`](./docs/articles/plan/CONTRIBUTING_MODEL_WORK.mdx)
first — model work has its own gates and discipline.

## Before you start

For anything larger than a typo or an obvious bug fix, open an issue first so we
can agree on the approach before you spend the time.

## Contribution terms (DCO + dual license)

Mailwoman is dual-licensed under **AGPL-3.0-only** and a separate **commercial
license** (see [`LICENSE.md`](./LICENSE.md)). For that dual model to hold, every
contribution has to reach us under terms that let us offer it under _both_
licenses. So, by submitting a contribution (a pull request, patch, or any change),
you agree to the following. **You keep the copyright in your contribution** — this
is a license grant, not an assignment.

1. **Developer Certificate of Origin.** You certify the DCO (version 1.1, full
   text below) for every commit. Sign off each commit to indicate this:

   ```bash
   git commit -s          # appends a "Signed-off-by: Your Name <you@example.com>" trailer
   ```

   The sign-off name and email must be real and must match the commit author.

2. **License grant.** You grant Teffen Ellis (DBA Sister Software),
   a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable license to use, reproduce, modify, prepare derivative works of,
   publicly display, publicly perform, and distribute your contribution and such
   derivative works, and to **sublicense and relicense** your contribution under
   any terms — including under AGPL-3.0-only and under Sister Software's commercial
   license (and any future or successor versions of either). You also grant a
   patent license on the same terms as Section 11 of the AGPL for any patent claims
   you own that are necessarily infringed by your contribution.

3. **You have the right to grant this.** Your contribution is your original work,
   or you otherwise have the rights to submit it under these terms; and if your
   employer has rights to work you create, you have permission to make the
   contribution, or your employer has waived those rights.

If you are contributing on behalf of a company and need a signed corporate CLA
rather than the DCO trailer, contact teffen@sister.software.

<details>
<summary><strong>Developer Certificate of Origin 1.1</strong> (full text)</summary>

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

</details>

## Prerequisites

- **Node ≥ 24.18.0** (the published `engines` floor). The repo itself is developed on Node 26.
- **Yarn 4** via Corepack — don't install Yarn globally.
- **git**, and a POSIX-ish shell for the helper scripts.

## Getting set up

```bash
git clone https://github.com/sister-software/mailwoman.git
cd mailwoman
corepack enable          # activates the pinned Yarn 4
yarn install --immutable # honors the committed lockfile
yarn compile             # tsc -b across all workspaces
yarn test                # vitest (Ctrl-C to exit watch; `yarn ci:test` runs once)
```

If `yarn install --immutable` fails, the lockfile is out of date — fix that
before anything else; it'll otherwise hide behind every later step.

### A note on the model weights

The trained model binaries (`model.onnx`, `tokenizer.model`) are **not committed
to git** — they're large, and they version on a different cadence than the code.
Most contributions (parser logic, the resolver, the CLI, docs, data pipelines)
don't need them. The handful of tests that do are gated and will skip cleanly
without them.

If you do need the weights — to run the neural classifier locally or work on the
model — see [`REPRODUCIBILITY.md`](./REPRODUCIBILITY.md) for how the artifacts are
produced and fetched. The published `@mailwoman/neural-weights-en-us` /
`-fr-fr` npm packages also carry a usable bundle.

## Repository layout

Mailwoman is a Yarn-4 monorepo. Source lives at **each workspace's root** (no
`src/` nesting), with tests co-located as `*.test.ts`. The orientation table and
the architectural "why" live in [`AGENTS.md`](./AGENTS.md) — read it before
changing anything structural. The short version:

- `mailwoman/` — the CLI + the high-level pipeline (the user-facing entry).
- `core/` — tokenization, classification, the solver/decoder, bundled
  dictionaries.
- `resolver*/`, `codex/`, `classifiers/`, `corpus/`, `neural*/`, `spatial/`,
  `normalize/`, … — the supporting packages.
- `docs/` — the Docusaurus site published to https://mailwoman.sister.software.

## Building, testing, and type-checking

| Command                                | What it does                                                       |
| -------------------------------------- | ------------------------------------------------------------------ |
| `yarn compile`                         | `tsc -b` over the workspaces (the build)                           |
| `yarn test`                            | vitest, watch mode                                                 |
| `yarn ci:test`                         | vitest, single run (what CI runs)                                  |
| `yarn typecheck:scripts`               | type-checks the `scripts/` toolshed (it's outside the build graph) |
| `yarn lint`                            | oxlint + oxfmt (Oxc toolchain)                                     |
| `yarn workspace @mailwoman/docs start` | the docs site at http://localhost:7770                             |

A vitest config in `core/` and `neural/` aliases sibling `@mailwoman/*` imports
to source, so `yarn test` runs without a precompile step.

**One gotcha worth knowing:** when a test file imports `@mailwoman/core` _both_
bare and via a subpath, Vite can leave the bare re-exports unbound and a base
class evaluates as `undefined`. The fix is a side-effect `import "@mailwoman/core"`
at the top of the test file. `AGENTS.md` documents this under the bare/subpath
import cycle.

## Running the CLI locally

After `yarn compile`:

```bash
node mailwoman/out/cli.js parse "1600 Amphitheatre Parkway, Mountain View, CA 94043"
node mailwoman/out/cli.js --help
```

## Commits and pull requests

- **Branch off `main`.** Open the PR against `main`.
- **Conventional commits.** Match the existing history: `feat(scope): …`,
  `fix(scope): …`, `refactor(scope): …`, `docs(scope): …`, `chore(scope): …`.
- **The pre-commit hook** (Husky + lint-staged) runs oxlint and oxfmt on your staged files. Let it run; it catches the formatting and
  type drift that CI would otherwise bounce. It only checks staged files, so for
  a change that spans packages, run the full `yarn ci:test` before pushing.
- **CI must be green** — the Test and Docs workflows run on every push. A red
  Docs build usually means an MDX syntax slip; a red Test build is a real failure.
- Keep PRs focused. One concept per PR is much easier to review (and to revert).

## Where to read next

- [`AGENTS.md`](./AGENTS.md) — architecture, workspace conventions, the release
  pipeline, and the load-bearing gotchas.
- [`docs/articles/plan/CONTRIBUTING_MODEL_WORK.mdx`](./docs/articles/plan/CONTRIBUTING_MODEL_WORK.mdx)
  — the model-work runbook: which evals gate a change, how to add a shard.
- [`docs/articles/concepts/what-mailwoman-is.mdx`](./docs/articles/concepts/what-mailwoman-is.mdx)
  — what the system _is_, if you're new to the project.

Questions that don't fit an issue? teffen@sister.software.
