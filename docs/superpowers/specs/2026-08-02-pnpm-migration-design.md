# yarn → pnpm migration — design

**Date:** 2026-08-02
**Status:** DEFERRED 2026-08-02 — design approved and kept warm, but not scheduled. Deferred to keep
the test-suite performance work focused; the two are independent except for step (e1) there, which is
deferred alongside it. Circle back when the performance ladder is done.
**Driver:** operator direction — pnpm is where the ecosystem is going. This is a **direction call, not
a performance claim**; see "What this is not" below.
**Deliverable:** the repo installs, builds, tests, packs, and publishes under pnpm, with the publish
pipeline verified against a real tarball before anything else lands.
**Blocks:** `2026-08-02-test-suite-performance-design.md` step (e1) — the `node_modules` cache has to
be built against whatever layout wins.

## What this is not

A spike of yarn's `nodeLinker: pnpm` was run first (2026-08-02; full receipt in
`2026-08-02-test-suite-performance-design.md` § e2). It measured **slower** than `node-modules` on
both install (48.4s vs 41.6s) and cold compile (40.5s vs 32.9s) and broke 7 test files.

That result refutes **yarn's pnpm linker as a performance lever**. It does not bear on migrating to
pnpm the package manager, which is a different mechanism: its own resolver, lockfile, and a
machine-wide content-addressed store with hardlinks rather than a per-project `.store`.

So this migration is not justified on speed, and should not be sold as such. Any speed it delivers
is a bonus, and (e1) in the sibling spec is the change that actually removes install from the
critical path either way.

## What was measured before designing

### Finding 1 — strict resolution costs three packages, not a long tail

The predicted blocker was phantom dependencies: pnpm's default layout is non-hoisted, so any module
importing a package it does not declare breaks. Full scan of every workspace's `.ts`/`.tsx` bare
imports against that workspace's declared deps (`docs/` excluded — its `@theme/*`, `@docusaurus/*`,
`@site/*` and `#e2e` specifiers are build-time aliases, not packages):

| package            | workspaces importing it undeclared |
| ------------------ | ---------------------------------: |
| `vitest`           |                                 38 |
| `typescript`       |                    1 (`mailwoman`) |
| `@duckdb/node-api` |                       1 (`corpus`) |

Everything else is already declared where it is used. The sampled high-traffic root devDeps — `zx`,
`csv-parse`, `spliterator`, `fast-glob` — are all correctly declared in every workspace that imports
them. `smoke-clean-install.ts`, whose stated purpose is catching undeclared runtime deps, has been
holding the line.

Fix is mechanical: add the three to the workspaces that use them, or one `public-hoist-pattern` for
`vitest`. Preference is declaring them — it is what the strictness is for, and it keeps
`smoke-clean-install.ts` honest.

### Finding 2 — the publish pipeline is the risk

`scripts/pack-workspace.ts:61–69` injects a derived `publishConfig.exports` into the workspace
manifest and then relies on **`yarn pack` substituting it** into the tarball manifest:

```ts
manifest.publishConfig = { ...manifest.publishConfig, exports: <derived publish map> }
…
spawnSync("yarn", ["pack", "-o", outFile], { cwd: workspaceDir, … })
```

Per AGENTS.md this mechanism exists because the hand-maintained duplication it replaced "shipped a
fully-broken v7.2.0" when removed without a replacement. The committed `exports` map is the DEV map,
carrying a `node` condition that points at `.ts` source; Node refuses type-stripping under
`node_modules`, so if that condition reaches a consumer the package is dead on install
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).

**Whether `pnpm pack` substitutes `publishConfig.exports` identically is the migration's gate.** It
is verified against a real packed tarball before any other step lands — not asserted from
documentation.

Everything downstream of pack inherits the risk: `scripts/publish-workspace.ts`,
`scripts/verify-tarball.ts`, `scripts/smoke-clean-install.ts`, `scripts/bless-package.ts`. The
existing guard that refuses to publish when an exports target is missing from the tarball is the
backstop, and it stays.

### Finding 3 — the surface inventory

- `packageManager: yarn@4.17.0` (root `package.json`), corepack 0.35.0 available; pnpm not currently
  installed on the lab host.
- `.yarnrc.yml` — 10 settings needing translation (table below).
- `yarn.lock` (24,490 lines) → `pnpm-lock.yaml`.
- Root `workspaces` array (54 entries) → `pnpm-workspace.yaml`.
- 5 workflows reference yarn/corepack across 55 lines: `test.yml`, `publish.yml`, `docs-build.yml`,
  `demo-smoke.yml`, `version-parity.yml`.
- `.release-it.json` → `@release-it-plugins/workspaces`, plus hooks invoking `yarn compile` and
  `yarn oxfmt`.
- `package.json` `"docs:build": "yarn workspace @mailwoman/docs build"` → `pnpm --filter`.
- 5 packages need postinstall builds, observed in the install log: `onnxruntime-node`, `@swc/core`,
  `core-js`, `esbuild`, `protobufjs`.

## Design

### Config translation

| `.yarnrc.yml`                             | pnpm equivalent                | note                                                                                        |
| ----------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| `nodeLinker: node-modules`                | default (isolated)             | the point of the migration; `node-linker=hoisted` is the fallback if strictness bites       |
| `enableGlobalCache: true`                 | default                        | pnpm's store is global by design                                                            |
| `httpRetry: 8`                            | `fetch-retries=8`              | the 2026-07-28 CDN-flap hardening — must survive                                            |
| `httpTimeout: 60000`                      | `fetch-timeout=60000`          | same                                                                                        |
| `enableScripts: true`                     | `onlyBuiltDependencies: [...]` | **pnpm 10 blocks postinstall by default**; list the 5 from Finding 3                        |
| `supportedArchitectures`                  | `supportedArchitectures`       | same shape                                                                                  |
| `packageExtensions` (`tr46` → `punycode`) | `packageExtensions`            | same shape                                                                                  |
| `npmMinimalAgeGate: 0`                    | `minimumReleaseAge=0`          |                                                                                             |
| `approvedGitRepositories`                 | n/a                            | yarn-specific                                                                               |
| root `resolutions` (6 entries)            | `pnpm.overrides`               | adm-zip, http-proxy-middleware, serialize-javascript, sockjs/uuid, undici, websocket-driver |

### Sequencing — gate first

1. **Gate: pack parity.** Install pnpm, pack one representative workspace (`core` — curated
   subpaths, the `kysley/*` glob, and a `.d.ts` surface) under both tools. Diff the tarball manifests
   and file lists. `publishConfig.exports` must land identically. **Stop here on mismatch** and
   resolve before touching anything else; the fallback is to have `pack-workspace.ts` write the
   publish map into the manifest directly rather than delegating substitution.
2. Declare the three hoisted packages (`vitest` × 38, `typescript`, `@duckdb/node-api`).
3. Config translation + `pnpm-workspace.yaml` + lockfile generation.
4. Rewrite the pack/publish scripts' invocations; re-run `verify-tarball.ts` and
   `smoke-clean-install.ts` against real tarballs.
5. `.release-it.json` + `@release-it-plugins/workspaces` compatibility.
6. Workflows: 5 files, `corepack enable` → `pnpm/action-setup`, `cache: yarn` → `cache: pnpm`.
7. Fix `vitest.config.ts:82` — resolve the `onnxruntime-web` specifier instead of hardcoding
   `node_modules/onnxruntime-web/dist/ort.node.min.mjs`. Surfaced by the linker spike; breaks under
   any layout change, so it must be fixed before the layout changes.
8. Re-measure install / cold compile / `ci:test:fast` against the control (41.6s / 32.9s / 7.48s) and
   record the result whichever way it goes.

### Interaction with the performance spec

Step (e1) there caches `node_modules` as a single archive. Under pnpm the natural equivalent is
caching the **store** and running `pnpm install --offline`, which should beat yarn's numbers because
the store is content-addressed and the install is hardlinks rather than copies. (e1) is therefore
specified against whichever layout this migration lands, and is not built until then.

## Acceptance criteria

- A packed `core` tarball under pnpm is byte-equivalent in manifest `exports` and file list to the
  yarn-packed one. Verified against a real tarball, not documentation.
- `yarn verify-tarball` equivalent and `smoke-clean-install.ts` pass against pnpm-packed tarballs for
  every workspace they currently cover.
- `pnpm install --frozen-lockfile` → `compile` → `ci:test:fast` → `ci:test:slow` all green, with no
  `public-hoist-pattern` escape hatch in place for `vitest` (i.e. the three packages are declared,
  not hoisted around).
- All 5 workflows green.
- A dry-run release completes end to end.
- Install and cold-compile timings recorded against the control, and published in this spec whether
  they improve or regress.

## Risks

- **Pack substitution divergence.** The gate. Failure mode is a fully-broken published package, the
  v7.2.0 class. Mitigated by gating first and by the existing exports-target guard.
- **`@release-it-plugins/workspaces` compatibility.** The plugin is yarn/npm oriented. If it does not
  cooperate, the fallback is driving `publish-workspace.ts` per workspace directly — a path AGENTS.md
  already documents for partial-release recovery, so it is known-good.
- **postinstall blocking.** pnpm 10 refuses build scripts unless allowlisted. Missing one produces a
  package that installs "successfully" and fails at runtime — the meaning-of-zero shape. The 5 known
  builders are listed; a fresh `pnpm install` warning check is part of step 3.
- **Lab host store.** pnpm's store is global per-user; 20+ agent worktrees sharing one store is a
  behaviour change from yarn's global cache. Expected to be fine (hardlinks are the design), but
  worktree isolation is a known-sensitive area here.
- **No speed win.** A plausible outcome: `2026-08-02-test-suite-performance-design.md` § Finding 3
  shows Fetch is already 0.6s on a warm CI cache, and the local control measured 0.4s. Accepted going
  in; the driver is direction, not speed. Step 8 records the result either way rather than quietly
  dropping it if it regresses.

## Non-goals

- Speed. See "What this is not".
- Changing the workspace layout, the `exports` dev-map convention, or the pack-then-`npm publish`
  split. Those stay exactly as they are; only the tool invoking them changes.
