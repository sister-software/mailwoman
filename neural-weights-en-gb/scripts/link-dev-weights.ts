#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Symlink dev model + tokenizer files into this package for local testing.
 *   See @mailwoman/neural-weights-en-us/scripts/link-dev-weights.ts for the rationale.
 *
 *   A single multilingual model serves both en-us and en-gb (byte-identical artifact;
 *   en-gb just carries its own postcode-anchor calibration). Re-symlinks the SAME files
 *   as en-us until per-locale training lands. Keep these defaults in lockstep with en-us's
 *   DEFAULT_* on every ship. The md5 guard reads en-us's model-card `files_md5` — one truth
 *   for the one artifact (en-gb's own card carries no files_md5 block).
 *
 *   ALSO links the soft-feed siblings a fresh worktree is otherwise missing (the
 *   fresh-worktree anchor-OFF gap: `link-dev-weights.ts` historically symlinked only
 *   model+tokenizer, leaving `anchor-lexicon-v1.json` / `country-surface-lexicon-v1.json` /
 *   `postcode-gb.bin` absent — the CLI then parses anchor-OFF/gazetteer-OFF with only a
 *   stderr warning). The two lexicons are checked-in repo files (`data/gazetteer/…`), so
 *   they're symlinked straight from there. `postcode-gb.bin` has no committed source — it's
 *   a derived artifact built from the WOF GB postcode shard — so this script BUILDS it in
 *   place via the compiled `gazetteer postcode-binary` CLI (same command
 *   `scripts/copy-weights.ts` runs at publish time), mirroring how `postcode-fr.bin`
 *   already lives as a real (non-symlinked) file in `neural-weights-fr-fr/`.
 *
 *   ALSO builds `pair-index-gb.bin` (placetype-pair-prior arc, Task 5) the same way: no
 *   committed source (derived from the HM Land Registry PPD tuples CSV), built in place via
 *   the compiled `gazetteer pair-index` CLI. `--delta 6.0` is the rung-3-measured value baked
 *   into the real `docs/static/mailwoman/pair-index-gb.bin` artifact's header (Task 3) — LOUD
 *   NOTE: this is NOT a final calibrated number, it's the rung-3 probe-set delta; a future
 *   calibration task owns re-setting it, and this script's literal must move in lockstep with
 *   whatever that task lands (same discipline as the `DEFAULT_MODEL`/`DEFAULT_TOKENIZER`
 *   lockstep comment above).
 *
 *   FRESHNESS GUARD on the skip-if-exists path (review follow-up): a bare `existsSync` skip is
 *   right for `postcode-gb.bin` (rebuilds in seconds from a small WOF shard) but wrong on its own
 *   here — an existing `pair-index-gb.bin` could be stale against either (a) a bumped `--delta`
 *   literal below (the #397-guard-style md5-lockstep discipline the model/tokenizer check above
 *   already uses, applied to this artifact) or (b) a changed PPD source CSV on disk. Mirrors that
 *   SAME md5-lockstep pattern: peek the existing binary's header (magic + header block ONLY, via
 *   `peekPairIndexHeader` — reimplemented locally, not imported from `@mailwoman/neural`, so this
 *   data-only package doesn't gain a dependency on the ONNX-runtime-carrying workspace for one
 *   header read) and compare `header.delta` against this script's own `PAIR_INDEX_DELTA` const,
 *   and `header.sourceMD5s[0]` (the md5 the artifact was actually built from, per
 *   `pair-index.tsx`'s own self-recorded provenance) against a freshly computed md5 of the CURRENT
 *   PPD source CSV. Either mismatch forces a loud rebuild instead of a silent skip.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { $public } from "@mailwoman/core/env"
import { dataRootPath, md5File, repoRootPath } from "@mailwoman/core/utils"

const PKG_DIR = repoRootPath("neural-weights-en-gb")
// In lockstep with en-us's DEFAULT_* (one multilingual artifact serves both) — keep this
// pair identical to neural-weights-en-us/scripts/link-dev-weights.ts's DEFAULT_MODEL /
// DEFAULT_TOKENIZER on every ship. The guard below fails loud on any future miss.
const SRC_MODEL =
	$public.MAILWOMAN_DEV_MODEL || dataRootPath("models", "quantized", "model-v385-latam-step-008000-int8.onnx")
const SRC_TOKENIZER =
	$public.MAILWOMAN_DEV_TOKENIZER || dataRootPath("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model")

if (!existsSync(SRC_MODEL)) {
	console.error(`missing source model: ${SRC_MODEL}`)
	process.exit(1)
}

if (!existsSync(SRC_TOKENIZER)) {
	console.error(`missing source tokenizer: ${SRC_TOKENIZER}`)
	process.exit(1)
}

/** Replicate `ln -sf SRC DEST`: drop any pre-existing link/file at the destination, then symlink. */
function linkForce(src: string, dest: string): void {
	if (existsSync(dest)) {
		unlinkSync(dest)
	}

	symlinkSync(src, dest)
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
	const MAGIC = 0x31_58_49_50 // "PIX1" little-endian — mirrors pair-index-resolver.ts's MAGIC const

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

linkForce(SRC_MODEL, resolve(PKG_DIR, "model.onnx"))
linkForce(SRC_TOKENIZER, resolve(PKG_DIR, "tokenizer.model"))

console.log(`linked ${PKG_DIR}/{model.onnx,tokenizer.model}`)

// #397 guard, lockstep form: the en-gb artifact IS the en-us artifact, so verify the
// linked default bytes against en-us's model-card `files_md5` (skipped under an
// explicit MAILWOMAN_DEV_* override — deliberate experimentation).
if (!$public.MAILWOMAN_DEV_MODEL || !$public.MAILWOMAN_DEV_TOKENIZER) {
	const enUSCard = JSON.parse(
		readFileSync(resolve(PKG_DIR, "..", "neural-weights-en-us", "model-card.json"), "utf8")
	) as { files_md5?: Record<string, string> }
	const checks: Array<[string, string, string | undefined]> = [
		["model", resolve(PKG_DIR, "model.onnx"), enUSCard.files_md5?.["model.onnx"]],
		["tokenizer", resolve(PKG_DIR, "tokenizer.model"), enUSCard.files_md5?.["tokenizer.model"]],
	]

	for (const [label, path, expected] of checks) {
		if (
			($public.MAILWOMAN_DEV_MODEL && label === "model") ||
			($public.MAILWOMAN_DEV_TOKENIZER && label === "tokenizer")
		)
			continue

		if (!expected) {
			console.error(
				`ERROR (#397 guard): en-us model-card.json has no files_md5 entry for ${label} — cannot verify the dev pin.`
			)
			process.exit(1)
		}
		const actual = createHash("md5").update(readFileSync(path)).digest("hex")

		if (actual !== expected) {
			console.error(
				`ERROR (#397 guard): linked default ${label} md5 ${actual} != shipped ${expected} (en-us card files_md5).`
			)
			console.error("  Bump this script's SRC_* defaults in lockstep with en-us on each ship.")
			process.exit(1)
		}
	}
}

// --- soft-feed siblings (the fresh-worktree anchor-OFF gap) -----------------------------

// The gazetteer + country soft-feed lexicons are checked-in repo files — symlink straight
// from `data/gazetteer/` (the same source `release.config.json`'s `softFeed.gazetteerLexicon` /
// `softFeed.countryLexicon` name, and what `scripts/copy-weights.ts` copies verbatim at
// publish time).
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

// `postcode-gb.bin` has no committed source (it's derived from the WOF GB postcode shard),
// so build it in place with the compiled `gazetteer postcode-binary` CLI — the same command
// `scripts/copy-weights.ts` runs per-locale at publish time. Requires `yarn compile` to have
// run first (mailwoman/out/cli.js must exist); skips with a warning (not a hard failure) so a
// worktree without the GB WOF shard can still link the model/tokenizer/lexicons.
const GB_WOF_DB = dataRootPath("wof", "postalcode-gb.db")
const CLI = repoRootPath("mailwoman", "out", "cli.js")
const POSTCODE_BIN_DEST = resolve(PKG_DIR, "postcode-gb.bin")

if (!existsSync(CLI)) {
	console.error(
		`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run this script to build postcode-gb.bin.`
	)
} else if (!existsSync(GB_WOF_DB)) {
	console.error(
		`WARNING: missing ${GB_WOF_DB} — postcode-gb.bin not built; the anchor channel will resolve OFF for GB.`
	)
} else {
	const result = spawnSync(
		process.execPath,
		[CLI, "gazetteer", "postcode-binary", "--out", PKG_DIR, "--locale", `GB:${GB_WOF_DB}`],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !existsSync(POSTCODE_BIN_DEST)) {
		console.error(`ERROR: failed to build ${POSTCODE_BIN_DEST} (exit ${result.status})`)
		process.exit(1)
	}
	console.log(`built ${POSTCODE_BIN_DEST}`)
}

// `pair-index-gb.bin` (placetype-pair-prior arc, Task 5) has no committed source either (it's
// derived from the HM Land Registry PPD tuples CSV) — build it the same way, via the compiled
// `gazetteer pair-index` CLI. `PAIR_INDEX_DELTA` mirrors the rung-3-measured value baked into the
// real `docs/static/mailwoman/pair-index-gb.bin` header (Task 3) — see this file's header comment:
// NOT a final calibrated number, only the rung-3 probe-set delta. Skips with a warning (not a hard
// failure) so a worktree without the PPD source CSV can still link everything else.
//
// UNLIKE postcode-gb.bin above (small WOF shard, rebuilds in seconds), the PPD tuples CSV is
// ~25.6M rows — a cold build takes several minutes (measured 2026-07-22: ~4-5 min). `weights.test.ts`
// invokes this script on every `yarn test`/`yarn vitest` run (the #397-guard pattern), so REBUILDING
// UNCONDITIONALLY here would make every test run pay that cost. Skip ONLY when the existing artifact
// is verifiably FRESH (see the FRESHNESS GUARD module-doc paragraph above) — a stale skip would let a
// bumped delta or a changed PPD snapshot silently ship a byte-identical-looking but out-of-date
// artifact into every test run.
const PPD_SOURCE_CSV = dataRootPath("ppd", "2026-07-22", "gb-tuples.csv")
const PAIR_INDEX_BIN_DEST = resolve(PKG_DIR, "pair-index-gb.bin")
const PAIR_INDEX_DELTA = 6.0

let pairIndexIsFresh = false

if (existsSync(PAIR_INDEX_BIN_DEST)) {
	try {
		const { delta: existingDelta, sourceMD5: existingSourceMD5 } = peekPairIndexDeltaAndSourceMD5(PAIR_INDEX_BIN_DEST)

		if (existingDelta !== PAIR_INDEX_DELTA) {
			console.log(
				`STALE pair-index-gb.bin: header delta ${existingDelta} !== this script's PAIR_INDEX_DELTA ${PAIR_INDEX_DELTA} — rebuilding.`
			)
		} else if (!existsSync(String(PPD_SOURCE_CSV))) {
			// Delta matches but the source CSV isn't on disk to re-hash — can't do better than trust the
			// delta match (the "missing source, can't build" branch below would fire anyway if this were
			// stale and needed a rebuild).
			pairIndexIsFresh = true
			console.log(
				`skipped pair-index-gb.bin build — ${PAIR_INDEX_BIN_DEST} has a matching delta (source CSV absent, md5 freshness unverifiable)`
			)
		} else {
			const currentSourceMD5 = await md5FileWithSidecar(String(PPD_SOURCE_CSV))

			if (existingSourceMD5 && currentSourceMD5 === existingSourceMD5) {
				pairIndexIsFresh = true
				console.log(`skipped pair-index-gb.bin build — ${PAIR_INDEX_BIN_DEST} is fresh (delta + source md5 match)`)
			} else {
				console.log(
					`STALE pair-index-gb.bin: header source md5 ${existingSourceMD5 ?? "(none recorded)"} != current ` +
						`${PPD_SOURCE_CSV} md5 ${currentSourceMD5} — rebuilding.`
				)
			}
		}
	} catch (err) {
		console.log(`pair-index-gb.bin header unreadable (${(err as Error).message}) — rebuilding.`)
	}
}

if (pairIndexIsFresh) {
	// Nothing to do — the loud skip/rebuild message was already printed above.
} else if (!existsSync(CLI)) {
	console.error(
		`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run this script to build pair-index-gb.bin.`
	)
} else if (!existsSync(String(PPD_SOURCE_CSV))) {
	console.error(
		`WARNING: missing ${PPD_SOURCE_CSV} — pair-index-gb.bin not built; the placetype-pair prior default will resolve OFF for GB.`
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
			"gb",
			"--source",
			String(PPD_SOURCE_CSV),
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
