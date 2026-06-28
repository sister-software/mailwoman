/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Diagnose corpus shard loading — run locally or on Modal to confirm which shards the data loader
 *   actually sees.
 *
 *   Ported faithfully from the original `scripts/diagnose-corpus.py` (now retired). It lives under
 *   `scripts/diagnostic/` per `scripts/AGENTS.md` — diagnostic scripts inspect training data /
 *   artifacts and are not part of the shipped toolchain.
 *
 *   The Python original re-used `_shard_paths` / `_shard_first_source` from
 *   `corpus-python/src/mailwoman_train/data_loader.py`. Those two helpers are inlined here (the TS
 *   toolchain has no dependency on the Python training package), preserving their exact resolution
 *   behavior — including the overlay-corpus cross-dir refs, the stale-path re-rooting, and the
 *   STRICT partial-resolution guard (#480, the v0.7.1 trap).
 *
 *   Usage: node scripts/diagnostic/diagnose-corpus.ts --corpus-dir
 *   /mnt/playpen/mailwoman-data/corpus/versioned/v0.4.0/corpus-v0.4.0
 *
 *   On Modal: modal run scripts/modal/train_remote.py::diagnose_corpus
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api"

interface ManifestShard {
	path: string
	split?: string
	rows?: number
	[key: string]: unknown
}

interface Manifest {
	shards?: ManifestShard[]
	base_corpus_version?: string | null
	[key: string]: unknown
}

/**
 * `str(PurePosixPath(input))` — the normalized string form Python's `pathlib` prints. Collapses redundant `/`, drops
 * `.` segments and a trailing slash; preserves `..` (Python does not resolve it). Used so this script's printed paths
 * and the sort order of resolved shards match the Python original byte-for-byte on the realistic (clean, absolute)
 * inputs.
 */
function pyPosixPathStr(input: string): string {
	if (input === "") return "."
	const isAbs = input.startsWith("/")
	const parts = input.split("/").filter((p) => p !== "" && p !== ".")

	if (parts.length === 0) return isAbs ? "/" : "."
	const joined = parts.join("/")

	return isAbs ? "/" + joined : joined
}

/** `PurePosixPath(input).parts` — `('/', 'a', 'b')` for absolute, `('a', 'b')` for relative. */
function pyPosixParts(input: string): string[] {
	const norm = pyPosixPathStr(input)

	if (norm === ".") return []

	if (norm === "/") return ["/"]
	const isAbs = norm.startsWith("/")
	const segs = norm.split("/").filter((p) => p !== "")

	return isAbs ? ["/", ...segs] : segs
}

/** `PurePosixPath(input).name` — the final path component (empty for the root). */
function pyPosixName(input: string): string {
	const parts = pyPosixParts(input)

	if (parts.length === 0) return ""
	const last = parts[parts.length - 1]!

	return last === "/" ? "" : last
}

/** `str(PurePosixPath(a) / b)` for a relative `b` — join then normalize. */
function pyPosixJoin(a: string, b: string): string {
	return pyPosixPathStr(a + "/" + b)
}

/**
 * Resolve train/val/test shard paths via MANIFEST.json (adapter-addition corpora) or legacy glob fallback (monolithic
 * corpora). Faithful port of `_shard_paths` from the Python data loader.
 *
 * Per shard: use the manifest path AS-IS when it exists (overlay cross-dir refs, or a corpus on its build machine);
 * otherwise RE-ROOT it under `corpusDir` (take the `<split>/<basename>` tail). A manifest that declares shards this
 * loop cannot find is BROKEN (#480) — fail loud with the full missing list. Falls back to a glob over `corpusDir/split`
 * only when the manifest yields nothing.
 */
function shardPaths(corpusDir: string, split: string): string[] {
	const corpusDirStr = pyPosixPathStr(corpusDir)
	const manifestPath = pyPosixJoin(corpusDirStr, "MANIFEST.json")

	if (existsSync(manifestPath)) {
		const data = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest
		const baseVersion = data.base_corpus_version
		const resolved: string[] = []
		let rerooted = 0
		const missing: string[] = []
		let declared = 0

		for (const s of data.shards ?? []) {
			if (s.split !== split) continue
			declared += 1
			const rawStr = pyPosixPathStr(s.path)

			if (existsSync(rawStr)) {
				// Path is valid as-is (overlay cross-dir ref, or corpus on its build machine).
				resolved.push(rawStr)
				continue
			}
			// Stale absolute path (corpus moved): re-root the <split>/<file> tail under corpusDir.
			const parts = pyPosixParts(rawStr)
			const idx = parts.indexOf(split)
			const tail = idx >= 0 ? parts.slice(idx).join("/") : split + "/" + pyPosixName(rawStr)
			const cand = pyPosixJoin(corpusDirStr, tail)

			if (existsSync(cand)) {
				resolved.push(cand)
				rerooted += 1
			} else {
				missing.push(rawStr)
			}
		}

		// STRICT partial-resolution guard (#480, the v0.7.1 trap): a manifest that declares shards
		// this loop cannot find means the corpus is BROKEN — training on the survivors silently
		// measures the wrong corpus. All-missing falls through to the legacy glob.
		if (resolved.length > 0 && missing.length > 0) {
			throw new Error(
				`MANIFEST declares ${declared} '${split}' shards but ${missing.length} are unresolvable ` +
					`(as-is AND re-rooted under ${corpusDirStr}):\n  ` +
					missing.slice(0, 10).join("\n  ") +
					(missing.length > 10 ? "\n  ..." : "")
			)
		}

		if (resolved.length > 0) {
			console.log(
				`[shards] ${split}: ${resolved.length} resolved (${rerooted} re-rooted) from MANIFEST` +
					(baseVersion ? ` (base_corpus_version=${baseVersion})` : " (no base_corpus_version field)")
			)

			return resolved.slice().sort()
		}
	}

	// legacy fallback (monolithic corpora, or manifest yielded no resolvable shards)
	const splitDir = pyPosixJoin(corpusDirStr, split)
	let paths: string[] = []

	if (existsSync(splitDir)) {
		paths = readdirSync(splitDir)
			.filter((name) => name.endsWith(".parquet"))
			.map((name) => pyPosixJoin(splitDir, name))
			.sort()
	}

	if (paths.length === 0) {
		throw new Error(`no shards via MANIFEST or ${splitDir}`)
	}

	return paths
}

/**
 * Return the `source` value of the first row in a parquet shard. Faithful port of `_shard_first_source`. Corpus v0.2.0
 * shards are 100% source-segregated (one source per shard), so the first row's source identifies the shard's source.
 * `threads=1` + `LIMIT 1` returns the first physical row (matching PyArrow's `read_row_group(0)[0]`).
 */
async function shardFirstSource(con: DuckDBConnection, shard: string): Promise<string> {
	const escaped = shard.replace(/'/g, "''")
	const result = await con.runAndReadAll(`SELECT source FROM read_parquet('${escaped}') LIMIT 1`)
	const rows = result.getRowObjects() as Array<Record<string, unknown>>

	if (rows.length === 0) throw new Error("empty shard (no rows)")

	return rows[0]!.source as string
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: { "corpus-dir": { type: "string" } },
		allowPositionals: false,
	})
	const corpusDirArg = values["corpus-dir"]

	if (!corpusDirArg) {
		console.error("usage: diagnose-corpus.ts --corpus-dir CORPUS_DIR")
		console.error("diagnose-corpus.ts: error: the following arguments are required: --corpus-dir")
		process.exit(2)
	}

	const corpusDir = pyPosixPathStr(corpusDirArg)
	const manifestPath = pyPosixJoin(corpusDir, "MANIFEST.json")
	const manifestExists = existsSync(manifestPath)

	console.log(`Corpus dir: ${corpusDir}`)
	console.log(`Manifest exists: ${manifestExists ? "True" : "False"}`)

	if (manifestExists) {
		const data = JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest
		const shards = data.shards ?? []
		const trainShards = shards.filter((s) => s.split === "train")
		console.log(`MANIFEST: ${shards.length} total shards, ${trainShards.length} train`)
		const trainRows = trainShards.reduce((acc, s) => acc + (s.rows as number), 0)
		console.log(`MANIFEST train rows: ${trainRows.toLocaleString("en-US")}`)

		// Check which paths exist
		let existing = 0
		let missing = 0

		for (const s of trainShards) {
			const p = pyPosixPathStr(s.path)

			if (existsSync(p)) {
				existing += 1
			} else {
				missing += 1

				if (missing <= 5) console.log(`  MISSING: ${p}`)
			}
		}

		console.log(`\nTrain shard files: ${existing} exist, ${missing} missing`)

		if (missing > 5) console.log(`  ... and ${missing - 5} more missing`)
	}

	// Now test the actual data loader indexing
	console.log("\n--- Data loader shard indexing ---")
	const paths = shardPaths(corpusDir, "train")
	console.log(`_shard_paths returned ${paths.length} train shards`)

	const instance = await DuckDBInstance.create()
	const con = await instance.connect()
	await con.run("SET threads=1;")

	const bySource = new Map<string, number>()
	let errors = 0

	for (const p of paths) {
		if (!existsSync(p)) {
			errors += 1
			continue
		}

		try {
			const src = await shardFirstSource(con, p)
			bySource.set(src, (bySource.get(src) ?? 0) + 1)
		} catch (exc) {
			errors += 1
			console.log(`  ERROR reading ${p}: ${exc instanceof Error ? exc.message : String(exc)}`)
		}
	}

	con.closeSync()

	console.log(`\nSource index (${errors} errors):`)
	// Counter.most_common(): count descending; ties broken by insertion order (stable sort).
	const ordered = [...bySource.entries()].sort((a, b) => b[1] - a[1])

	for (const [src, count] of ordered) {
		console.log(`  ${String(src).padEnd(35)} ${String(count).padStart(4)} shards`)
	}
}

main().catch((err: unknown) => {
	console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
	process.exit(1)
})
