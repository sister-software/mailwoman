#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the en-nz overlay's dev artifacts. See
 *   @mailwoman/neural-weights-en-us/scripts/link-dev-weights.ts for the base rationale.
 *
 *   #1179 OVERLAY FORM (fr-fr's rewritten shape, adopted here from day one): en-nz declares
 *   `mailwoman.baseWeights: "@mailwoman/neural-weights-en-us"`, so `resolveWeights` falls through
 *   to the en-us package for `model.onnx` / `tokenizer.model`. This script therefore links no
 *   model or tokenizer at all — it REMOVES any leftover local pair so the base fallback engages
 *   (a stale local file would SHADOW the base fallback and silently serve outdated bytes; see the
 *   fr-fr script's header for the incident that taught this).
 *
 *   What en-nz DOES own locally (locale-specific soft-feed siblings; `resolveFromPackageDir`
 *   resolves these from the overlay dir with no base fallback):
 *
 *   - `anchor-lexicon-v1.json` / `country-surface-lexicon-v1.json` — checked-in repo files,
 *       symlinked from `data/gazetteer/`.
 *   - `pair-index-nz.bin` (NZ arc, #1277) — no committed source (derived from the LINZ-derived
 *       OpenAddresses NZ countrywide CSV, the same register `synth-nz-v2` was built from), built in
 *       place via the compiled `gazetteer pair-index` CLI. `--delta 10` is the NZ-sweep-calibrated
 *       value (task-8 report, 2026-07-24 § "NZ arc": saturates at δ=10, identical to 12/15, 0/54
 *       golden-FP throughout) baked into the artifact's header.
 *
 *   UNLIKE en-gb there is NO postcode binary to build: no WOF NZ postcode shard exists
 *   (release.config.json's softFeed.postcodeDBByCountry has no `nz` entry), so the anchor channel
 *   resolves OFF for en-nz until that shard is built — the tracked follow-up in this package's
 *   model-card.json (`nz_artifacts.no_postcode_bin`).
 *
 *   FRESHNESS GUARD on the skip-if-exists path (the en-gb pattern, verbatim rationale): a bare
 *   `existsSync` skip would let an existing `pair-index-nz.bin` go stale against either (a) a
 *   bumped `--delta` literal below or (b) a changed source CSV on disk. So: peek the existing
 *   binary's header (magic + header block ONLY, via a local reimplementation of
 *   `peekPairIndexHeader` — NOT imported from `@mailwoman/neural`, so this data-only package
 *   doesn't gain a dependency on the ONNX-runtime-carrying workspace for one header read) and
 *   compare `header.delta` against this script's `PAIR_INDEX_DELTA`, and `header.sourceMD5s[0]`
 *   against a freshly computed md5 of the CURRENT source CSV (sidecar-cached — the CSV is 2.12M
 *   rows, worth not re-hashing on every `yarn test`). Either mismatch forces a loud rebuild
 *   instead of a silent skip. The NZ CSV is ~12× smaller than GB's PPD source (2.1M vs 25.6M
 *   rows), so even a cold rebuild is well under a minute — the guard exists for correctness, not
 *   build-time savings.
 */

import { spawnSync } from "node:child_process"
import {
	existsSync,
	lstatSync,
	readFileSync,
	renameSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import { resolve } from "node:path"

import { dataRootPath, md5File, repoRootPath } from "@mailwoman/core/utils"

const PKG_DIR = repoRootPath("neural-weights-en-nz")

/**
 * Replicate `ln -sf SRC DEST` ATOMICALLY: symlink under a temp name, then rename over the destination. A plain
 * unlink-then-symlink leaves a no-file window that concurrent vitest workers (weights.test.ts + every other suite
 * resolving weights on the lab runners) can hit mid-suite — bit CI on 2026-07-24 (v1-parse-gate: "missing model files"
 * while the materialize step had verifiably succeeded). rename(2) replaces the destination atomically.
 */
function linkForce(src: string, dest: string): void {
	const tmp = `${dest}.tmp-link`

	if (existsSync(tmp)) {
		unlinkSync(tmp)
	}

	symlinkSync(src, tmp)
	renameSync(tmp, dest)
}

/** Remove a leftover local file/symlink so the #1179 base-weights fallback engages. */
function removeIfPresent(dest: string): void {
	try {
		lstatSync(dest)
	} catch {
		return
	}
	unlinkSync(dest)
	console.log(`removed stale local ${dest} (base fallback to en-us engages)`)
}

/**
 * Read or compute MD5 hash for a file, using a sidecar .md5 cache to avoid re-hashing large files. The sidecar is
 * written in standard md5sum format: `<hash> <filename>` (hash, two spaces, filename). On subsequent runs, if the
 * sidecar exists and its mtime >= the source file's mtime, the hash is read from the sidecar; otherwise it's recomputed
 * and the sidecar is updated.
 */
async function md5FileWithSidecar(path: string): Promise<string> {
	const sidecarPath = `${path}.md5`
	const sourceStats = statSync(path)

	if (existsSync(sidecarPath)) {
		try {
			const sidecarStats = statSync(sidecarPath)

			if (sidecarStats.mtime >= sourceStats.mtime) {
				const sidecarContent = readFileSync(sidecarPath, "utf8").trim()
				const [hash] = sidecarContent.split(/\s+/)

				if (hash && hash.length === 32) {
					// Valid md5 hash (32 hex chars)
					console.log(`md5(${path}): read from sidecar`)

					return hash
				}
			}
		} catch {
			// If sidecar read fails, fall through to recompute
		}
	}

	const hash = await md5File(path)
	const filename = path.split(/[/\\]/).pop() || path
	writeFileSync(sidecarPath, `${hash}  ${filename}\n`)
	console.log(`md5(${path}): computed and cached in sidecar`)

	return hash
}

/**
 * Minimal PIX1 header-only reader: magic + header block, same validation as `PairIndexResolver`'s constructor and
 * `peekPairIndexHeader` (`neural/pair-index-resolver.ts`) — bad-magic throw, future-schema throw — but reimplemented
 * locally rather than imported, so this data-only weights package doesn't gain a dependency on `@mailwoman/neural`
 * (which pulls in onnxruntime-node) just to read four header fields. Kept intentionally tiny; if the PIX1 format ever
 * changes, `pair-index-resolver.ts`'s own header parse is the source of truth this must stay in sync with.
 */
function peekPairIndexDeltaAndSourceMD5(path: string): { delta: number; sourceMD5: string | undefined } {
	const bytes = readFileSync(path)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const MAGIC = 0x31_58_49_50
	// "PIX1" little-endian — mirrors pair-index-resolver.ts's MAGIC const

	if (view.getUint32(0, true) !== MAGIC) {
		throw new Error(`pair index: bad magic reading ${path}`)
	}

	const headerLen = view.getUint32(4, true)
	const header = JSON.parse(Buffer.from(bytes.subarray(8, 8 + headerLen)).toString("utf8")) as {
		delta: number
		sourceMD5s?: string[]
	}

	return { delta: header.delta, sourceMD5: header.sourceMD5s?.[0] }
}

removeIfPresent(resolve(PKG_DIR, "model.onnx"))
removeIfPresent(resolve(PKG_DIR, "tokenizer.model"))

// --- soft-feed siblings (locale-owned; the fresh-worktree gazetteer/country-OFF gap) -----
const SRC_GAZETTEER_LEXICON = repoRootPath("data", "gazetteer", "anchor-lexicon-v1.json")
const SRC_COUNTRY_LEXICON = repoRootPath("data", "gazetteer", "country-surface-lexicon-v1.json")

if (existsSync(SRC_GAZETTEER_LEXICON)) {
	linkForce(SRC_GAZETTEER_LEXICON, resolve(PKG_DIR, "anchor-lexicon-v1.json"))
	console.log(`linked ${PKG_DIR}/anchor-lexicon-v1.json`)
} else {
	console.error(`WARNING: missing ${SRC_GAZETTEER_LEXICON} — gazetteer channel will resolve OFF in this worktree.`)
}

if (existsSync(SRC_COUNTRY_LEXICON)) {
	linkForce(SRC_COUNTRY_LEXICON, resolve(PKG_DIR, "country-surface-lexicon-v1.json"))
	console.log(`linked ${PKG_DIR}/country-surface-lexicon-v1.json`)
} else {
	console.error(`WARNING: missing ${SRC_COUNTRY_LEXICON} — country channel will resolve OFF in this worktree.`)
}

// `pair-index-nz.bin` (NZ arc, #1277) has no committed source (it's derived from the LINZ-derived
// OpenAddresses NZ countrywide CSV) — build it in place via the compiled `gazetteer pair-index`
// CLI, the same command `scripts/copy-weights.ts` runs at publish time
// (softFeed.pairIndexByCountry.nz). Skips with a warning (not a hard failure) so a worktree
// without the source CSV can still link the lexicons. Freshness-guarded per the module doc above.
const NZ_SOURCE_CSV = dataRootPath("openaddresses", "extracted", "nz", "countrywide.csv")
const CLI = repoRootPath("mailwoman", "out", "cli.js")
const PAIR_INDEX_BIN_DEST = resolve(PKG_DIR, "pair-index-nz.bin")
const PAIR_INDEX_DELTA = 10

let pairIndexIsFresh = false

if (existsSync(PAIR_INDEX_BIN_DEST)) {
	try {
		const { delta: existingDelta, sourceMD5: existingSourceMD5 } = peekPairIndexDeltaAndSourceMD5(PAIR_INDEX_BIN_DEST)

		if (existingDelta !== PAIR_INDEX_DELTA) {
			console.log(
				`STALE pair-index-nz.bin: header delta ${existingDelta} !== this script's PAIR_INDEX_DELTA ${PAIR_INDEX_DELTA} — rebuilding.`
			)
		} else if (!existsSync(String(NZ_SOURCE_CSV))) {
			// Delta matches but the source CSV isn't on disk to re-hash — can't do better than trust the
			// delta match (the "missing source, can't build" branch below would fire anyway if this were
			// stale and needed a rebuild).
			pairIndexIsFresh = true
			console.log(
				`skipped pair-index-nz.bin build — ${PAIR_INDEX_BIN_DEST} has a matching delta (source CSV absent, md5 freshness unverifiable)`
			)
		} else {
			const currentSourceMD5 = await md5FileWithSidecar(String(NZ_SOURCE_CSV))

			if (existingSourceMD5 && currentSourceMD5 === existingSourceMD5) {
				pairIndexIsFresh = true
				console.log(`skipped pair-index-nz.bin build — ${PAIR_INDEX_BIN_DEST} is fresh (delta + source md5 match)`)
			} else {
				console.log(
					`STALE pair-index-nz.bin: header source md5 ${existingSourceMD5 ?? "(none recorded)"} != current ` +
						`${NZ_SOURCE_CSV} md5 ${currentSourceMD5} — rebuilding.`
				)
			}
		}
	} catch (err) {
		console.log(`pair-index-nz.bin header unreadable (${(err as Error).message}) — rebuilding.`)
	}
}

if (pairIndexIsFresh) {
	// Nothing to do — the loud skip/rebuild message was already printed above.
} else if (!existsSync(CLI)) {
	console.error(
		`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run this script to build pair-index-nz.bin.`
	)
} else if (!existsSync(String(NZ_SOURCE_CSV))) {
	console.error(
		`WARNING: missing ${NZ_SOURCE_CSV} — pair-index-nz.bin not built; the placetype-pair prior default will resolve OFF for NZ.`
	)
} else {
	const result = spawnSync(
		process.execPath,
		[
			CLI,
			"gazetteer",
			"pair-index",
			"--out",
			PKG_DIR,
			"--country",
			"nz",
			"--source",
			String(NZ_SOURCE_CSV),
			"--delta",
			String(PAIR_INDEX_DELTA),
		],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !existsSync(PAIR_INDEX_BIN_DEST)) {
		console.error(`ERROR: failed to build ${PAIR_INDEX_BIN_DEST} (exit ${result.status})`)
		process.exit(1)
	}
	console.log(`built ${PAIR_INDEX_BIN_DEST}`)
}
