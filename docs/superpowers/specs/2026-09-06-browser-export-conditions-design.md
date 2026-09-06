# Browser export conditions: retire the bundler stubs in the owning packages

**Status:** design approved 2026-09-06 (export conditions in the owning packages, never a new leaf package; the
operator's call).
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

Eighteen entries, every one a packaging defect in the package it names, and every one invisible to the
package's own tests. The Earth app moves the same runtime under Vite, and without this design it would
need the same eighteen entries in `vite.config.ts`. A workaround copied into a second bundler is a
workaround that will never be removed.

`rspack` stays disabled in `docs/docusaurus.config.ts` for the same reason: it refuses the `node:`
imports webpack is told to stub. The docs build is slower than it needs to be because the packages are
wrong, not because Docusaurus is.

## Decisions taken

**The fix lives in the owning package.** A subpath that a browser bundle reaches gets a `browser` export
condition pointing at a browser-safe module. No `@mailwoman/browser`, no shim package, no bundler plugin
in a published package. This is the platform-split rule already applied to the license worker, extended
to the client.

**A moved name gets no compatibility re-export.** If a subpath splits into a node half and a browser
half, the browser half is a new file under the same subpath, selected by condition. Nothing re-exports
the old shape.

**The measure is the entry count.** Done means `webpack-policy.ts` carries zero stubs and zero aliases
for `@mailwoman/*`, and the Earth `vite.config.ts` carries no `resolve.alias` for `@mailwoman/*`. Each
removed entry is one commit that names the subpath it fixed.

## Design

### Inventory first

Before any edit, produce the list of `@mailwoman/*` subpaths the docs client bundle reaches, and for
each, the Node builtin it pulls in and through which import. `esbuild` with
`conditions: ["browser"]`, `platform: "browser"` and `bundle: true` over each subpath, run with the
stubs removed, reports the exact chain in its error output. The inventory is a table in the PR
description, not a comment in code.

The likely shape, from the stub list: `@mailwoman/core/fs/*` reached through a resources reader;
`path-ts` composed paths that assume `node:path`; `@mailwoman/core/module/resolvers` reached through a
data-root lookup; `node:worker_threads` reached through the ONNX runner's node half.

### The condition per subpath

For each subpath on the inventory, one of three shapes, chosen in this order:

1. **The import is dead on the browser path.** Move it behind a dynamic `import()` on the node branch,
   as `@mailwoman/neural`'s `tokenizer.ts` already does for `node:fs/promises`. No new file.
2. **The subpath has a browser implementation.** Add a `browser` condition to the subpath's `exports`
   entry pointing at it, ahead of `default`. `./onnx-runner` is the existing example.
3. **The subpath has no browser meaning.** Do not stub it. The client code that imports it is the bug;
   move that import to a subpath with a browser meaning.

A stub that answers `false` today (the nine dead builtins) is removed with no replacement once the
subpath that imported it is fixed under shape 1 or 3.

### The `#` imports map

`@mailwoman/neural` aliases `#onnx-runner` in webpack because the package-private `imports` map is what
the source reads. The `imports` map takes conditions the same way `exports` does, and the package already
declares `"browser"` on `#onnx-runner`. The alias exists because webpack is not asked for the `browser`
condition on `#` imports; the fix is in `docs/docusaurus.config.ts` resolution conditions, not in the
package. Verify before removing.

### Proof

Each fixed subpath gets a row in a bundle test in the owning package, shaped like
`packages/core/test/integration/worker-bundle.test.ts`: `esbuild` bundles the subpath under
`conditions: ["browser"]` with `platform: "browser"` and asserts no `node:` specifier in the output
metafile. The test runs in ordinary CI with no data download. `packages/neural/test/integration/browser-slo.test.ts`
already does this for the neural client graph and stays as the size budget.

## Definition of done

- The inventory table exists in the PR that opens the work.
- `docs/plugins/demo-assets/webpack-policy.ts` carries zero `node:` stubs and zero `@mailwoman/*`
  aliases. The `*-excel-file/node` shims are a third-party defect and stay until that dependency leaves
  the docs graph.
- Each owning package has a browser bundle test row per fixed subpath, green in CI.
- `rspackBundler: true` is retried in `docs/docusaurus.config.ts`; the result is recorded either way.
- The docs site builds and the geocoder page works with the stubs gone. This is the last time the docs
  site is the integration test surface for the browser runtime; the Earth app takes that role next.

## Out of scope

Moving any file out of `docs/src/`. Renaming anything. Both belong to the Earth design.
