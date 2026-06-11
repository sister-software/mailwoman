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

// ---------------------------------------------------------------------------
// Workspace resolution helpers
// ---------------------------------------------------------------------------

const requireFromPlugin = createRequire(import.meta.url)

/**
 * Locate a workspace package's root directory via its package.json.
 *
 * @param {string} packageName
 *
 * @returns {string | null}
 */
export function resolveWorkspaceDir(packageName) {
	try {
		return dirname(requireFromPlugin.resolve(`${packageName}/package.json`))
	} catch {
		return null
	}
}

/**
 * Resolve a workspace package's entry file. Prefers the source `.ts` file so Docusaurus's
 * swc-loader can transpile it inline — avoids requiring a pre-compile step.
 *
 * @param {string} packageName
 *
 * @returns {string}
 */
export function resolveWorkspaceEntry(packageName) {
	const dir = resolveWorkspaceDir(packageName)
	if (!dir) throw new Error(`Cannot resolve ${packageName}/package.json`)
	const sourceEntry = resolve(dir, "index.ts")
	if (existsSync(sourceEntry)) return sourceEntry
	return resolve(dir, "out", "index.js")
}

/**
 * Resolve a single-file sub-entrypoint within a workspace directory.
 *
 * @param {string} workspaceDir
 * @param {string} sub
 *
 * @returns {string}
 */
export function resolveWorkspaceFile(workspaceDir, sub) {
	const sourceEntry = resolve(workspaceDir, `${sub}.ts`)
	if (existsSync(sourceEntry)) return sourceEntry
	return resolve(workspaceDir, "out", `${sub}.js`)
}

/**
 * Resolve a directory-style sub-entrypoint (./sub/index.{ts,js}).
 *
 * @param {string} workspaceDir
 * @param {string} sub
 *
 * @returns {string}
 */
export function resolveWorkspaceDirEntry(workspaceDir, sub) {
	const sourceEntry = resolve(workspaceDir, sub, "index.ts")
	if (existsSync(sourceEntry)) return sourceEntry
	return resolve(workspaceDir, "out", sub, "index.js")
}

// ---------------------------------------------------------------------------
// Webpack alias builder
// ---------------------------------------------------------------------------

/**
 * Build the full workspace alias map for webpack. Centralises the alias logic that was previously
 * inlined in docusaurus.config.ts.
 *
 * @returns {Record<string, string>}
 */
export function buildWorkspaceAliases() {
	/** @type {Record<string, string>} */
	const aliases = {}

	// Bare package aliases (exact match via `$` suffix).
	for (const pkg of [
		"@mailwoman/neural-web",
		"@mailwoman/resolver-wof-wasm",
		"@mailwoman/core",
		"@mailwoman/query-shape",
		"@mailwoman/kind-classifier",
	]) {
		try {
			aliases[`${pkg}$`] = resolveWorkspaceEntry(pkg)
		} catch {
			// Best-effort
		}
	}

	// @mailwoman/cartographer — only browser-safe sub-entrypoints.
	const cartographerDir = resolveWorkspaceDir("@mailwoman/cartographer")
	if (cartographerDir) {
		aliases["@mailwoman/cartographer/base"] = resolveWorkspaceDirEntry(cartographerDir, "base")
		aliases["@mailwoman/cartographer/styles"] = resolveWorkspaceDirEntry(cartographerDir, "styles")
	}

	// @mailwoman/resolver-wof-sqlite — browser-safe subpaths only (the FST modules plus fts.ts,
	// whose single node:sqlite import is type-only; httpvfs-resolver.ts imports its alias-bag
	// parser so the demo's exact tier can't drift from the Node/WASM resolvers).
	const resolverWofDir = resolveWorkspaceDir("@mailwoman/resolver-wof-sqlite")
	if (resolverWofDir) {
		for (const sub of ["fst-deserialize-web", "fst-matcher", "fst-types", "fts"]) {
			aliases[`@mailwoman/resolver-wof-sqlite/${sub}`] = resolveWorkspaceFile(resolverWofDir, sub)
		}
	}

	// @mailwoman/neural/browser — browser entry that excludes onnxruntime-node.
	const neuralDir = resolveWorkspaceDir("@mailwoman/neural")
	if (neuralDir) {
		aliases["@mailwoman/neural/browser"] = resolveWorkspaceFile(neuralDir, "browser")
	}

	// @mailwoman/core sub-entrypoints (transitive deps from neural / resolver).
	const coreDir = resolveWorkspaceDir("@mailwoman/core")
	if (coreDir) {
		for (const sub of [
			"decoder",
			"resolver",
			"classification",
			"tokenization",
			"parser",
			"solver",
			"formatter",
			"types",
			"resources",
		]) {
			aliases[`@mailwoman/core/${sub}`] = resolveWorkspaceDirEntry(coreDir, sub)
		}
		aliases["@mailwoman/core/environment/load"] = resolveWorkspaceFile(coreDir, "environment/load")
		aliases["@mailwoman/core/kysley/dialect"] = resolveWorkspaceFile(coreDir, "kysley/dialect")
	}

	return aliases
}

// ---------------------------------------------------------------------------
// Model artifact resolution + validation
// ---------------------------------------------------------------------------

/**
 * Read the model-card.json from the weights package to get version metadata.
 *
 * @returns {{ version: string; modelSize: number; tokenizerVocab: number; step: string } | null}
 */
export function readModelCard() {
	const weightsDir = resolveWorkspaceDir("@mailwoman/neural-weights-en-us")
	if (!weightsDir) return null
	const cardPath = resolve(weightsDir, "model-card.json")
	if (!existsSync(cardPath)) return null
	try {
		return JSON.parse(readFileSync(cardPath, "utf8"))
	} catch {
		return null
	}
}

/**
 * Resolve a binary artifact from the weights package, dereferencing symlinks. Returns the real path
 * to the file (following symlinks from link-dev-weights.sh).
 *
 * @param {string} filename - E.g. "model.onnx" or "tokenizer.model"
 *
 * @returns {string | null}
 */
export function resolveWeightsArtifact(filename) {
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
 * @param {string} sourcePath
 * @param {string} destPath
 * @param {string} label - For logging
 *
 * @returns {boolean} True if the file was copied
 */
export function syncArtifact(sourcePath, destPath, label) {
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
 * Stage sql.js-httpvfs's runtime assets (the UMD bundle + its Worker + WASM) into `destDir`. The
 * demo loads these at RUNTIME by URL — the UMD via a classic <script>, the worker + wasm passed to
 * createDbWorker — so webpack never sees them. That's deliberate: bundling sql.js-httpvfs (a
 * webpack UMD bundle with dynamic Worker/wasm requires) is exactly what produces "Critical
 * dependency" build warnings, so we keep it out of the graph entirely.
 *
 * @param {string} destDir - E.g. static/mailwoman/sqljs
 *
 * @returns {boolean}
 */
export function stageSqlJsHttpvfs(destDir) {
	let distDir
	try {
		distDir = dirname(requireFromPlugin.resolve("sql.js-httpvfs/dist/index.js"))
	} catch {
		console.warn("[demo-assets] sql.js-httpvfs not resolvable — HTTP-VFS assets not staged")
		return false
	}
	const files = ["index.js", "sqlite.worker.js", "sql-wasm.wasm"]
	for (const f of files) {
		const src = resolve(distDir, f)
		if (!existsSync(src)) {
			console.warn(`[demo-assets] sql.js-httpvfs: missing ${f} in dist`)
			return false
		}
		copyFileSync(src, resolve(destDir, f))
	}
	console.log(`[demo-assets] sql.js-httpvfs: staged ${files.length} runtime assets`)
	return true
}

// ---------------------------------------------------------------------------
// FST builder
// ---------------------------------------------------------------------------

/**
 * Build the FST binary from the WOF admin SQLite database.
 *
 * @param {string} fstPath - Destination path for the binary
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} [opts.wofDb] - Path to WOF admin DB
 *
 * @returns {boolean} True if built successfully
 */
export function buildFstBinary(fstPath, opts) {
	// Canonical custom-built gazetteer (never the off-the-shelf dumps — see feedback-custom-wof-db-only).
	const globalDb = "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
	const wofDb = opts.wofDb ?? process.env.PLAYPEN_WOF_ADMIN_DB ?? globalDb

	if (!existsSync(wofDb)) {
		console.warn(`[demo-assets] FST: WOF admin DB not found at ${wofDb} — skipping FST build`)
		return false
	}

	const isGlobal = wofDb.includes("global")
	const countries = isGlobal ? "['US', 'FR', 'JP', 'CN', 'KR', 'DE', 'GB']" : "['US']"
	const languages = isGlobal ? "['*']" : "['eng', '']"

	const script = `
		import { buildFstFromWof } from '@mailwoman/resolver-wof-sqlite/fst-builder'
		import { serializeFst } from '@mailwoman/resolver-wof-sqlite/fst-serialize'
		import { writeFileSync } from 'node:fs'
		const { matcher, provenance } = buildFstFromWof({
			dbPath: ${JSON.stringify(wofDb)},
			countries: ${countries},
			languages: ${languages},
			onProgress: (phase, msg) => process.stderr.write(phase + ': ' + msg + '\\n'),
		})
		const buf = serializeFst(matcher, provenance)
		writeFileSync(${JSON.stringify(fstPath)}, buf)
		process.stderr.write('FST binary: ' + (buf.length / 1024 / 1024).toFixed(2) + ' MB\\n')
	`

	console.log(`[demo-assets] FST: building from ${wofDb}`)
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

// ---------------------------------------------------------------------------
// WOF slim DB builder
// ---------------------------------------------------------------------------

/**
 * Build the slim WOF database for the browser resolver.
 *
 * @param {string} destPath
 * @param {object} opts
 * @param {string} opts.repoRoot
 *
 * @returns {boolean}
 */
export function buildSlimWofDb(destPath, opts) {
	// Canonical custom-built gazetteer (never the off-the-shelf dumps — see feedback-custom-wof-db-only).
	const globalDb = "/mnt/playpen/mailwoman-data/wof/admin-global-priority.db"
	const adminDb = process.env.PLAYPEN_WOF_ADMIN_DB ?? globalDb
	// Postcodes: the custom build is admin-only today. Set PLAYPEN_WOF_POSTCODE_DB once a custom
	// postcode DB exists; until then the slim build runs admin-only.
	const postcodeDb = process.env.PLAYPEN_WOF_POSTCODE_DB ?? ""

	if (!existsSync(adminDb)) {
		console.warn("[demo-assets] wof-hot.db: WOF admin DB not found — skipping slim build")
		return false
	}

	const slimCli = resolve(opts.repoRoot, "resolver-wof-sqlite/out/build-slim-cli.js")
	if (!existsSync(slimCli)) {
		console.warn("[demo-assets] wof-hot.db: build-slim-cli not compiled — skipping")
		return false
	}

	// `--countries` MUST include every country the demo resolves, AND it gates which `coincident_roles`
	// survive the slim filter (the relation is dropped for any place whose spr row is trimmed). DE/FR
	// carry the city-states the dual-role badge surfaces (Berlin/Hamburg/Bremen, Paris) — a US-only slim
	// has zero coincident roles, so the badge would never appear. Override via SLIM_COUNTRIES.
	const countries = process.env.SLIM_COUNTRIES ?? "US,DE,FR"

	// `--drop-names`: the resolver never reads the names table at runtime (place_search is a
	// self-contained FTS5), so drop it for a ~2/3 size win on the shipped DB (see #359).
	console.log(`[demo-assets] wof-hot.db: building slim DB (countries=${countries}, names dropped)`)
	const result = spawnSync(
		"node",
		[
			slimCli,
			"--in",
			adminDb,
			"--in",
			postcodeDb,
			"--out",
			destPath,
			"--top",
			"1000",
			"--countries",
			countries,
			"--drop-names",
		],
		{
			cwd: opts.repoRoot,
			stdio: "inherit",
			timeout: 300_000,
		}
	)

	return result.status === 0
}
