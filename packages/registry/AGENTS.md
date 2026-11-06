# AGENTS.md — `@mailwoman/registry`

Read the repository-root `AGENTS.md` first.

The package compiles standardized identifiers from pinned open sources into RGY1 lookup artifacts. `docs/rgy1.md`
is the normative layout, `docs/data-policy.md` states the sources and their terms, and `docs/performance.md` holds
the benchmark report.

## Source roots

`lib/` is the library: the reader (`lib/rgy1/`), the key encodings, the brands, the narrow predicates and record
APIs, the collision index and the wasm loader. Its only imports are its own modules, with no `@mailwoman/core` and no
`node:` module, so a bundle of one predicate holds one artifact and the reader. `sdk/` downloads the pinned sources. `tools/` normalizes,
compiles, generates and benchmarks. `crates/` holds the Rust workspace members: `registry-core` (the `no_std`
reader and lookups), `registry-build` (the compiler) and `registry-wasm` (the C-ABI adapter).

## Generated files

`lib/rgy1/sections.generated.ts` and `crates/registry-core/src/sections.rs` come from `definitions/sections.json`
through `tools/generate-sections.run.ts`. `lib/artifacts/*.ts`, `data/manifests/artifacts.json` and
`test/fixtures/artifacts/*.rgy1` come from `tools/generate.run.ts`. `wasm/*.wasm` come from
`tools/build-wasm.run.ts`. Each tool takes `--check` and exits non-zero when a committed file differs. Edit the
definition, the data or the compiler, then rerun the tool; never edit a generated file.

## The order of a data change

Fetch (`sdk/fetch.run.ts --repin`), normalize (`tools/normalize.run.ts`), generate (`tools/generate.run.ts`). The
compiler refuses a code outside its grammar and two current records on one code rather than dropping a row, so a
refused build prints the record to fix in the normalizer or the source.

## Tests

`lib/overlap/country-airport.test.ts` holds every one of the 17,576 three-letter keys of the three bitsets equal to a
set oracle built from the normalized JSON. `lib/rgy1/layout.test.ts` walks the committed fixture artifacts with its
own byte reader against `test/fixtures/layout.json`, so the writer and the reader agreeing is never the only check;
when the fixture data changes, recompute the expectations by hand from the formula in that file's comment.
`lib/wasm.test.ts` runs both wasm variants over the whole key space against the TypeScript reader. `cargo test -p
registry-core` runs the Rust conformance suite over the same fixtures. `tools/bundle-fixtures.integration.test.ts`
bundles tiny consumers with esbuild and checks which artifacts each bundle retains; it reads `out/`, so compile first.
