# Browser export conditions: retire the bundler stubs in the owning packages

**Status:** design approved 2026-09-06. The operator chose export conditions in the owning packages over a new leaf
package. Implemented 2026-09-07 (PR #2192).
**Builds on:** the platform-split rule that put `workerd`/`browser` conditions beside `node` in `@mailwoman/core`
for the license worker (`packages/core/test/integration/worker-bundle.test.ts` is the proof shape), and the
`browser` condition `@mailwoman/neural` already carries on `./onnx-runner`.
**Precedes:** the Earth app (`2026-09-06-earth-app-design.md`) and the planetary app
(`2026-09-06-planetary-app-design.md`). Both consume the packages this design fixes, under a second bundler.

## The problem

The docs site bundles the browser geocoder through webpack, and the only way it builds today is a
Docusaurus plugin, `docs/plugins/demo-assets/`, whose `webpack-policy.ts` rewrites module resolution for
`@mailwoman/*`. Counted on 2026-09-06 against `c79757bdf`:

| Entry kind                                                                                                                   | Count | What it hides                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------- |
| `node:` builtins stubbed with a shim (`fs`, `path`, `worker_threads`, `stream/web`, `fs/promises`)                           | 5     | A `@mailwoman/core` subpath the client reaches imports a Node builtin.     |
| `node:` builtins set to `false` (`module`, `url`, `crypto`, `stream`, `buffer`, `util`, `perf_hooks`, `os`, `child_process`) | 9     | The same, on subpaths whose builtin use is dead on the browser path.       |
| Aliases (`@mailwoman/neural/onnx-runner` and `#onnx-runner` to the browser runner; two `*-excel-file/node` shims)            | 4     | The package's `exports` map does not answer the browser bundler by itself. |

Each of the eighteen entries is a packaging defect in the package it refers to, and none of them is
visible to that package's own tests. The Earth app moves the same runtime under Vite, and without this
design it would need the same eighteen entries in `vite.config.ts`. A workaround copied into a second
bundler is unlikely ever to be removed.

`rspack` stays disabled in `docs/docusaurus.config.ts` for the same reason: it refuses the `node:`
imports webpack is told to stub. The docs build is slower than necessary because of packaging defects
in the packages, and Docusaurus is not the cause.

## Decisions taken

**The fix lives in the owning package.** A subpath that a browser bundle reaches gets a `browser` export
condition pointing at a browser-safe module. The design adds no `@mailwoman/browser`, no shim package, and
no bundler plugin in a published package. This extends the platform-split rule, already applied to the
license worker, to the client.

**A moved name gets no compatibility re-export.** If a subpath splits into a node half and a browser
half, the browser half is a new file under the same subpath, selected by condition. No file re-exports
the old shape.

**Progress is measured by the entry count.** The work is done when `webpack-policy.ts` carries zero
stubs and zero aliases for `@mailwoman/*`, and the Earth `vite.config.ts` carries no `resolve.alias` for
`@mailwoman/*`. Each removed entry is one commit, and the commit message states the subpath it fixed.

## Design

### Inventory first

Before any edit, list the `@mailwoman/*` subpaths the docs client bundle reaches. For each, record the
Node builtin it pulls in and the import that pulls it in. Running `esbuild` with
`conditions: ["browser"]`, `platform: "browser"` and `bundle: true` over each subpath, with the stubs
removed, reports the exact chain in its error output. The inventory is a table in the PR description
rather than a comment in code.

The stub list suggests the likely causes: `@mailwoman/core/fs/*` reached through a resources reader,
`path-ts` composed paths that assume `node:path`, `@mailwoman/core/module/resolvers` reached through a
data-root lookup, and `node:worker_threads` reached through the ONNX runner's node half.

### The condition per subpath

Each subpath on the inventory gets one of three fixes, checked in this order:

1. **The import is dead on the browser path.** Move it behind a dynamic `import()` on the node branch,
   as `@mailwoman/neural`'s `tokenizer.ts` already does for `node:fs/promises`. This needs no new file.
2. **The subpath has a browser implementation.** Add a `browser` condition to the subpath's `exports`
   entry pointing at it, ahead of `default`. `./onnx-runner` is the existing example.
3. **The subpath has no browser meaning.** Do not stub it. The client code that imports it is the bug,
   so move that import to a subpath with a browser meaning.

A stub that answers `false` today (the nine dead builtins) is removed without replacement once the
subpath that imported it is fixed under fix 1 or 3.

### The `#` imports map

The `imports` map takes conditions the same way `exports` does, and `@mailwoman/neural` already declares
`"browser"` on `#onnx-runner`. The docs alias for it applies only to the SSR bundle, which resolves the
`node` condition and would otherwise bundle `onnxruntime-node`. That is a Docusaurus property and is out
of scope here. The `imports` entry that did need a condition is `#classifier/loader`. esbuild and Vite
follow the classifier's lazy `import("#classifier/loader")` regardless of `webpackIgnore`, so under
`browser` it now resolves to `classifier/loader-browser.ts`, a module that throws a refusal.

### Proof

Every bundle walk lives in one place: the `bundle-graph` check in `@mailwoman/repo-health`
(`packages/repo-health/lib/checks/bundle-graph.ts`), which `yarn health` runs in the CI static leg after
`yarn compile`. The check is a table of rows. Each row is an entry specifier with the platform and
conditions a consumer bundles it under. `esbuild` bundles the row, and the check reads the metafile for
a builtin on a static edge, a dynamic builtin import that no row lists, and files the row says the bundle
must or must not carry. The same table now holds the two license-key rows under
`["workerd", "worker", "browser"]` that `packages/core/test/integration/worker-bundle.test.ts` held, and
the classifier row that `packages/neural/test/unit/browser-graph.test.ts` held. Both files are gone, so
the repository has one esbuild walk rather than three. `packages/neural/test/integration/browser-slo.test.ts`
keeps its reduced graph because it measures timing, and it remains the size budget. Subpaths in packages
that `neural` does not depend on (`react`, `spatial`, `cartographer`, `resolver-wof-wasm`,
`resolver-wof-sqlite`) measured clean, and the Earth app's Vite build guards them.

## Definition of done

- The inventory table exists in the PR that opens the work.
- `docs/plugins/demo-assets/webpack-policy.ts` carries zero `node:` stubs, zero fallbacks, and zero
  client-side aliases for `@mailwoman/*`. The `*-excel-file/node` shims were the XLSX reader on the
  `core/objects` chain and were removed with it. The SSR-only `onnx-runner` alias is a Docusaurus
  property and is removed with the geocoder page in the Earth design.
- Every fixed subpath is a row in the `bundle-graph` check, green in CI.
- `rspackBundler: true` is retried in `docs/docusaurus.config.ts`, and the result is recorded either way.
- The docs site builds and the geocoder page works with the stubs gone. After this, the Earth app
  replaces the docs site as the integration test surface for the browser runtime.

## Out of scope

Moving any file out of `docs/src/` and renaming anything are out of scope. Both belong to the Earth design.
