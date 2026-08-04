/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build-time utilities for the demo-assets plugin. Resolves workspace packages and their
 *   sub-entrypoints, copies + validates model artifacts, and builds the FST gazetteer binary.
 *
 *   Runs in Node.js only (Docusaurus config / plugin context). Never bundled into the client.
 */

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

import { $public } from "@mailwoman/core/env"
import { tryParsingJSON } from "@mailwoman/core/objects"
import { dataRootPath } from "@mailwoman/core/utils"

import type { ReleaseInfo } from "#shared/demo-helpers"

//#region Workspace resolution helpers

const requireFromPlugin = createRequire(import.meta.url)

/**
 * Locate a workspace package's root directory via its package.json.
 */
export function resolveWorkspaceDir(packageName: string): string | null {
	try {
		return dirname(requireFromPlugin.resolve(`${packageName}/package.json`))
	} catch {
		return null
	}
}

/**
 * Resolve a workspace package's entry file. Prefers the source `.ts` file so Docusaurus's swc-loader can transpile it
 * inline — avoids requiring a pre-compile step.
 */
export function resolveWorkspaceEntry(packageName: string): string {
	const dir = resolveWorkspaceDir(packageName)

	if (!dir) throw new Error(`Cannot resolve ${packageName}/package.json`)
	const sourceEntry = resolve(dir, "index.ts")

	if (existsSync(sourceEntry)) return sourceEntry

	return resolve(dir, "out", "index.js")
}

/**
 * Resolve a single-file sub-entrypoint within a workspace directory.
 */
export function resolveWorkspaceFile(workspaceDir: string, sub: string): string {
	const sourceEntry = resolve(workspaceDir, `${sub}.ts`)

	if (existsSync(sourceEntry)) return sourceEntry

	return resolve(workspaceDir, "out", `${sub}.js`)
}

/**
 * Resolve a directory-style sub-entrypoint (./sub/index.{ts,js}).
 */
export function resolveWorkspaceDirEntry(workspaceDir: string, sub: string): string {
	const sourceEntry = resolve(workspaceDir, sub, "index.ts")

	if (existsSync(sourceEntry)) return sourceEntry

	return resolve(workspaceDir, "out", sub, "index.js")
}

//#endregion

//#region Webpack alias builder

/**
 * Build the full workspace alias map for webpack — the single home for the demo's alias logic, spread into the
 * Docusaurus webpack config by `plugin.ts`.
 */
export function buildWorkspaceAliases(): Record<string, string> {
	const aliases: Record<string, string> = {}

	// Bare package aliases (exact match via `$` suffix). `@mailwoman/react` resolves to source so its
	// `.tsx` explorers transpile inline (like every other workspace source import); the `./styles.css`
	// subpath is left to package-exports resolution (the `$` keeps this alias from swallowing it).
	for (const pkg of [
		"@mailwoman/resolver-wof-wasm",
		"@mailwoman/core",
		"@mailwoman/query-shape",
		"@mailwoman/kind-classifier",
		"@mailwoman/react",
	]) {
		try {
			aliases[`${pkg}$`] = resolveWorkspaceEntry(pkg)
		} catch {
			// Best-effort
		}
	}

	// @mailwoman/react/map — the geocoder-demo map surface (react-map-gl/maplibre). The bare
	// `@mailwoman/react$` alias above is exact-match ($), so it does NOT catch this subpath; without an
	// explicit source alias webpack would resolve the package `exports` to the COMPILED
	// `react/out/map/index.js` (which `yarn start` never rebuilds — the same staleness trap the core
	// sub-entrypoint aliases document). Point it at source so `<GeocoderDemo>` transpiles inline + hot-reloads.
	const reactDir = resolveWorkspaceDir("@mailwoman/react")

	if (reactDir) {
		aliases["@mailwoman/react/map"] = resolveWorkspaceDirEntry(reactDir, "map")
	}

	// @mailwoman/cartographer — only browser-safe sub-entrypoints.
	const cartographerDir = resolveWorkspaceDir("@mailwoman/cartographer")

	if (cartographerDir) {
		aliases["@mailwoman/cartographer/base"] = resolveWorkspaceDirEntry(cartographerDir, "base")
		aliases["@mailwoman/cartographer/styles"] = resolveWorkspaceDirEntry(cartographerDir, "styles")
		aliases["@mailwoman/cartographer/coverage"] = resolveWorkspaceDirEntry(cartographerDir, "coverage")
	}

	// @mailwoman/resolver-wof-sqlite — browser-safe subpaths only (the FST modules plus fts.ts,
	// whose single node:sqlite import is type-only; httpvfs-resolver.ts imports its alias-bag
	// parser so the demo's exact tier can't drift from the Node/WASM resolvers). `street-normalize`
	// (pure, imports only @mailwoman/codex) + `geo` (pure math) back the httpvfs STREET lookups
	// (httpvfs-street.ts) so the demo's situs/interp normalization can't drift from the Node tiers.
	const resolverWOFDir = resolveWorkspaceDir("@mailwoman/resolver-wof-sqlite")

	if (resolverWOFDir) {
		for (const sub of [
			"fst-deserialize-web",
			"fst-matcher",
			"fst-types",
			"fts",
			"street-normalize",
			"geo",
			"fst-autocomplete",
		]) {
			aliases[`@mailwoman/resolver-wof-sqlite/${sub}`] = resolveWorkspaceFile(resolverWOFDir, sub)
		}
	}

	// @mailwoman/neural/web-loader — the demo's only entry into the neural package, and the root of the
	// browser runtime's whole graph (it reaches the runner and the classifier by relative path). Package
	// `exports` routes it correctly for a production build; the alias points at SOURCE so `yarn start`
	// transpiles it inline and hot-reloads, instead of serving whatever `neural/out/` was last compiled
	// (the same staleness trap the core sub-entrypoint aliases document below).
	const neuralDir = resolveWorkspaceDir("@mailwoman/neural")

	if (neuralDir) {
		aliases["@mailwoman/neural/web-loader"] = resolveWorkspaceFile(neuralDir, "web-loader")
	}

	// @mailwoman/core sub-entrypoints (transitive deps from neural / resolver).
	const coreDir = resolveWorkspaceDir("@mailwoman/core")

	if (coreDir) {
		for (const sub of [
			"decoder",
			"classification",
			"tokenization",
			"parser",
			"solver",
			"formatter",
			"types",
			"resources",
			// `pipeline` + `errors` MUST be here: the demo imports `runPipeline` from
			// `@mailwoman/core/pipeline` directly. Without a source alias, webpack resolves the package
			// `exports` to the COMPILED `core/out/pipeline/index.js` — which `yarn start` never rebuilds
			// (only CI's `ci:docs` runs `yarn compile` first). A stale `core/out` therefore serves whatever
			// pipeline was last compiled: one predating the #566 reconcile retirement mangles the parse
			// (house number bundled into the street) so the street/situs tier can't fire and the geocode
			// falls back to the admin centroid. Aliasing to source keeps dev on current code +
			// hot-reloads core edits, exactly like the bare `@mailwoman/core$` alias already does.
			"pipeline",
			"errors",
		]) {
			aliases[`@mailwoman/core/${sub}`] = resolveWorkspaceDirEntry(coreDir, sub)
		}

		// Barrel-bypass for @mailwoman/resolver — resolve it straight to its `types` module (where
		// `expandPlacetypeFilter`, `DEFAULT_PLACETYPE_MAP`, and `PLACETYPE_FILTER_GROUPS` are DIRECTLY
		// defined) instead of the package barrel `resolver/index.ts`, which RE-EXPORTS them from
		// `./types.js`. In the demo's production web build, webpack mis-wired that re-exported binding on
		// the async resolver chunk: `httpvfs-resolver.ts` saw `expandPlacetypeFilter` as `undefined` at
		// runtime ("expandPlacetypeFilter is not a function"). The ONLY runtime value the bundled graph
		// imports from this barrel is `expandPlacetypeFilter` (the resolver-wof-* lookups + this demo);
		// `createWOFResolver` reaches the graph through the `/resolve` subpath alias below, never through
		// this barrel — keep it that way. This alias is webpack-only — `tsc` still resolves the
		// package barrel, so type-only imports (`CoincidentLocality`, `Ancestor`) keep working.
		// EXACT match (`$`): the bare `@mailwoman/resolver` import resolves to core's types module, but a
		// SUBPATH like `@mailwoman/resolver/span-rescore` must NOT — it has to reach the real package
		// (aliased just below). Without the `$` this prefix-matched the subpath too, sending it to
		// `core/resolver/types/span-rescore` → "Can't resolve" / `findRescoreCandidate is not a function`.
		aliases["@mailwoman/resolver$"] = resolveWorkspaceFile(coreDir, "resolver/types")
		// `objects` is a SINGLE-file entry (`core/objects.ts`, exports `./out/objects.js`), so it needs the
		// flat-file resolver, not the dir-style loop above. Same staleness rationale as `pipeline`/`errors`.
		aliases["@mailwoman/core/objects"] = resolveWorkspaceFile(coreDir, "objects")
		aliases["@mailwoman/core/environment/load"] = resolveWorkspaceFile(coreDir, "environment/load")
		aliases["@mailwoman/core/kysley/dialect"] = resolveWorkspaceFile(coreDir, "kysley/dialect")
	}

	// @mailwoman/resolver/span-rescore — the #370 rescue. The bare-barrel alias above points at CORE's
	// types module (for `expandPlacetypeFilter`), which has no `findRescoreCandidate`; so the demo
	// imports the rescue from this SUBPATH, aliased straight to the real resolver package's source
	// (browser-safe: span-rescore.ts pulls only `@mailwoman/spatial` haversine + type-only core imports).
	const resolverDir = resolveWorkspaceDir("@mailwoman/resolver")

	if (resolverDir) {
		aliases["@mailwoman/resolver/span-rescore"] = resolveWorkspaceFile(resolverDir, "span-rescore")
		// `@mailwoman/resolver/resolve` — createWOFResolver/resolveTree for the demo's #861 shared
		// cascade. The bare-barrel alias above deliberately reaches only core's types module, which
		// carries neither, so the cascade has to come in by subpath. A missing alias here fails
		// SILENTLY: the cascade simply never executes, with no resolution error to notice it by.
		// Same subpath pattern as span-rescore; package exports carry "./resolve" for node/tsc.
		aliases["@mailwoman/resolver/resolve"] = resolveWorkspaceFile(resolverDir, "resolve")
	}

	// @mailwoman/codex — the per-locale pattern modules the bundled neural/core graph imports
	// (`placetype-pair-prior` pulls `es`/`it`; the rest arrive through the same class). Webpack's own
	// exports resolution lands on compiled `out/` (the `default` condition), which `yarn start` never
	// rebuilds — and a tree whose `codex/out` predates a newly added subpath fails the whole build
	// ("no valid target file was found"). Instead of hand-deriving source paths, ask Node's resolver
	// (`require.resolve`, the CJS twin of `import.meta.resolve`): the dev exports map's `node`
	// condition points every entry at its `.ts` source, so the alias lands on source with zero
	// knowledge of the package layout. Enumerated rather than globbed so a new locale module is
	// added here deliberately, like every other curated subpath in this file. EXACT match (`$`) on
	// the bare barrel, same rationale as `@mailwoman/resolver$` above.
	for (const sub of [null, "country", "de", "es", "fr", "gb", "it", "nz", "us"]) {
		const spec = sub ? `@mailwoman/codex/${sub}` : "@mailwoman/codex"

		try {
			const target = requireFromPlugin.resolve(spec)

			if (!target.endsWith(".ts")) {
				console.warn(`[demo-assets] ${spec} resolved to compiled output (${target}) — dev exports drift?`)
			}
			aliases[sub ? spec : "@mailwoman/codex$"] = target
		} catch {
			console.warn(`[demo-assets] ${spec} not resolvable — alias skipped`)
		}
	}

	return aliases
}

//#endregion

//#region Model artifact resolution + validation

/**
 * Read the model-card.json from the weights package to get version metadata.
 */
export function readModelCard(): ReleaseInfo | null {
	const weightsDir = resolveWorkspaceDir("@mailwoman/neural-weights-en-us")

	if (!weightsDir) return null
	const cardPath = resolve(weightsDir, "model-card.json")

	if (!existsSync(cardPath)) return null

	// Both generics: with only <ReleaseInfo>, F defaults to T and the null fallback fails to type.
	return tryParsingJSON<ReleaseInfo, null>(readFileSync(cardPath, "utf8"), null)
}

/**
 * Resolve a binary artifact from the weights package, dereferencing symlinks. Returns the real path to the file
 * (following symlinks from link-dev-weights.ts).
 *
 * @param filename - E.g. "model.onnx" or "tokenizer.model"
 */
export function resolveWeightsArtifact(filename: string): string | null {
	const weightsDir = resolveWorkspaceDir("@mailwoman/neural-weights-en-us")

	if (!weightsDir) return null
	const filePath = resolve(weightsDir, filename)

	if (!existsSync(filePath)) return null

	const st = lstatSync(filePath)

	if (st.isSymbolicLink()) {
		const target = readlinkSync(filePath)
		const resolved = resolve(dirname(filePath), target)

		return existsSync(resolved) ? resolved : null
	}

	return filePath
}

/**
 * Copy a file to the static directory, but only if it differs (by size) from what's already there.
 *
 * @param label - For logging
 *
 * @returns True if the file was copied
 */
export function syncArtifact(sourcePath: string, destPath: string, label: string): boolean {
	if (!existsSync(sourcePath)) {
		console.warn(`[demo-assets] ${label}: source missing at ${sourcePath}`)

		return false
	}

	const sourceSize = statSync(sourcePath).size

	if (existsSync(destPath)) {
		const destSize = statSync(destPath).size

		if (sourceSize === destSize) return false
	}

	copyFileSync(sourcePath, destPath)
	const sizeMB = (sourceSize / 1024 / 1024).toFixed(1)

	console.log(`[demo-assets] ${label}: synced (${sizeMB} MB)`)

	return true
}

/**
 * Stage sql.js-httpvfs's runtime assets (the UMD bundle + its Worker + WASM) into `destDir`. The demo loads these at
 * RUNTIME by URL — the UMD via a classic <script>, the worker + wasm passed to createDbWorker — so webpack never sees
 * them. That's deliberate: bundling sql.js-httpvfs (a webpack UMD bundle with dynamic Worker/wasm requires) is exactly
 * what produces "Critical dependency" build warnings, so we keep it out of the graph entirely.
 *
 * @param destDir - E.g. static/mailwoman/sqljs
 */
export function stageSQLJSHTTPVFS(destDir: string): boolean {
	let distDir: string

	try {
		distDir = dirname(requireFromPlugin.resolve("sql.js-httpvfs/dist/index.js"))
	} catch {
		console.warn("[demo-assets] sql.js-httpvfs not resolvable — HTTP-VFS assets not staged")

		return false
	}

	const files = ["index.js", "sqlite.worker.js", "sql-wasm.wasm"]
	let copied = 0

	for (const f of files) {
		const src = resolve(distDir, f)

		if (!existsSync(src)) {
			console.warn(`[demo-assets] sql.js-httpvfs: missing ${f} in dist`)

			return false
		}

		const dest = resolve(destDir, f)

		// Idempotent stage: skip when the destination already matches (by size). This runs in
		// loadContent(), which the Docusaurus dev server (`yarn start`) re-invokes on reload — and
		// `destDir` lives under the watched `static/` tree. An UNCONDITIONAL copyFileSync rewrites the
		// file (fresh mtime) even when the bytes are identical, the watcher sees a "change" and reloads,
		// loadContent() re-runs and re-copies… a reload LOOP that shows up as the /demo page flickering
		// during `start`. Skipping the no-op copy breaks the cycle. (Prod `build` runs loadContent once,
		// so the loop is a dev-server-only hazard.)
		if (existsSync(dest) && statSync(dest).size === statSync(src).size) continue
		copyFileSync(src, dest)

		copied++
	}

	if (copied > 0) {
		console.log(`[demo-assets] sql.js-httpvfs: staged ${copied} runtime asset(s)`)
	}

	return true
}

/**
 * Stage the placetype-pair indexes (placetype-pair-prior arc, #1278) SAME-ORIGIN into `destDir`
 * (`static/mailwoman/pair-index/`). The `pair-index-<cc>.bin` files are NOT on the R2 bucket yet — that repoint is the
 * release-train's job — so for dev/staged verification the demo fetches them from the site's own origin, alongside the
 * sql.js worker assets. Sources are `neural-weights-en-{gb,nz}/pair-index-{gb,nz}.bin`, materialized locally by each
 * package's `scripts/link-dev-weights.ts` (built from the register source CSV; not committed, like model.onnx).
 *
 * TOLERANT by design: a missing binary (a fresh worktree that never ran link-dev-weights, or a CI build with no dev
 * weights) is skipped with a warn — the demo loader fetches these with the same 404-tolerance, so an unstaged binary
 * just means that country's pair prior resolves OFF (byte-stable). `copyFileSync` dereferences a symlinked source, so
 * no symlink lands in the deploy.
 *
 * @param destDir - E.g. static/mailwoman/pair-index
 */
export function stagePairIndexes(destDir: string): boolean {
	const sources: Array<{ pkg: string; file: string }> = [
		{ pkg: "@mailwoman/neural-weights-en-gb", file: "pair-index-gb.bin" },
		{ pkg: "@mailwoman/neural-weights-en-nz", file: "pair-index-nz.bin" },
	]

	let copied = 0

	for (const { pkg, file } of sources) {
		const pkgDir = resolveWorkspaceDir(pkg)

		if (!pkgDir) {
			console.warn(`[demo-assets] pair-index: ${pkg} not resolvable — ${file} not staged`)

			continue
		}

		const src = resolve(pkgDir, file)

		if (!existsSync(src)) {
			console.warn(
				`[demo-assets] pair-index: ${file} missing at ${src} — not staged ` +
					`(run ${pkg}'s scripts/link-dev-weights.ts to build it; the demo tolerates its absence — that country's pair prior stays OFF).`
			)

			continue
		}

		const dest = resolve(destDir, file)

		// Idempotent stage (same reload-loop guard as stageSQLJSHTTPVFS): skip a byte-identical copy.
		if (existsSync(dest) && statSync(dest).size === statSync(src).size) continue
		copyFileSync(src, dest)

		copied++
	}

	if (copied > 0) {
		console.log(`[demo-assets] pair-index: staged ${copied} index binary/binaries`)
	}

	return true
}

//#endregion

//#region FST builder

/**
 * Build the FST binary from the WOF admin SQLite database.
 *
 * @param fstPath - Destination path for the binary
 *
 * @returns True if built successfully
 */
export function buildFSTBinary(fstPath: string, opts: { repoRoot: string; wofDB?: string }): boolean {
	// Canonical custom-built gazetteer (never the off-the-shelf dumps — see feedback-custom-wof-db-only).
	const globalDB = dataRootPath("wof", "admin-global-priority.db")
	const wofDB = opts.wofDB ?? $public.PLAYPEN_WOF_ADMIN_DB ?? globalDB

	if (!existsSync(wofDB)) {
		console.warn(`[demo-assets] FST: WOF admin DB not found at ${wofDB} — skipping FST build`)

		return false
	}

	const isGlobal = wofDB.includes("global")
	const countries = isGlobal ? "['US', 'FR', 'JP', 'CN', 'KR', 'DE', 'GB']" : "['US']"
	const languages = isGlobal ? "['*']" : "['eng', '']"

	const script = `
		import { buildFSTFromWOF } from '@mailwoman/resolver-wof-sqlite/fst-builder'
		import { serializeFST } from '@mailwoman/resolver-wof-sqlite/fst-serialize'
		import { writeFileSync } from 'node:fs'
		const { matcher, provenance } = buildFSTFromWOF({
			dbPath: ${JSON.stringify(wofDB)},
			countries: ${countries},
			languages: ${languages},
			onProgress: (phase, msg) => process.stderr.write(phase + ': ' + msg + '\\n'),
		})
		const buf = serializeFST(matcher, provenance)
		writeFileSync(${JSON.stringify(fstPath)}, buf)
		process.stderr.write('FST binary: ' + (buf.length / 1024 / 1024).toFixed(2) + ' MB\\n')
	`

	console.log(`[demo-assets] FST: building from ${wofDB}`)

	const result = spawnSync("node", ["--input-type=module", "-e", script], {
		cwd: opts.repoRoot,
		stdio: ["pipe", "inherit", "inherit"],
		timeout: 120_000,
	})

	if (result.status !== 0) {
		console.warn(`[demo-assets] FST: build failed (exit ${result.status})`)

		return false
	}

	console.log(`[demo-assets] FST: built successfully`)

	return true
}

//#endregion
