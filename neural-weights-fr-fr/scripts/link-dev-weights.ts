#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Materialize the fr-fr overlay's dev artifacts. See
 *   @mailwoman/neural-weights-en-us/scripts/link-dev-weights.ts for the base rationale.
 *
 *   #1179 OVERLAY FORM (2026-07-23 rewrite): fr-fr declares `mailwoman.baseWeights:
 *   "@mailwoman/neural-weights-en-us"`, so `resolveWeights` falls through to the en-us package
 *   for `model.onnx` / `tokenizer.model` / the card. This script therefore no longer links a
 *   model or tokenizer at all — it REMOVES any leftover local pair so the base fallback engages.
 *   (The previous version re-symlinked a pinned v241-fr-nsplice model on every `yarn test`;
 *   since #1179 that local file SHADOWED the base fallback, silently running the stale model for
 *   every dev fr-fr parse, and its #397 md5 guard could never pass against the en-us card. One
 *   model, one pin — en-us's script owns it.)
 *
 *   What fr-fr DOES own locally (locale-specific soft-feed siblings; `resolveFromPackageDir`
 *   resolves these from the overlay dir with no base fallback):
 *
 *   - `anchor-lexicon-v1.json` / `country-surface-lexicon-v1.json` — checked-in repo files,
 *       symlinked from `data/gazetteer/`.
 *   - `postcode-fr.bin` — derived from the WOF intl postcode shard
 *       (`softFeed.postcodeDBByCountry.fr` = postalcode-intl.db), built in place via the compiled
 *       `gazetteer postcode-binary` CLI (skip-if-exists; rebuilds in seconds). Without it a fresh
 *       worktree parses anchor-OFF — see the en-us script's section comment for the CI failure
 *       this caused.
 */

import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, renameSync, symlinkSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"

import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

/**
 * Workspace root the artifacts are linked into. Everything below resolves against it.
 */
const PKG_DIR = repoRootPath("neural-weights-fr-fr")

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

/**
 * Remove a leftover local file/symlink so the #1179 base-weights fallback engages.
 */
function removeIfPresent(dest: string): void {
	try {
		lstatSync(dest)
	} catch {
		return
	}

	unlinkSync(dest)

	console.log(`removed stale local ${dest} (base fallback to en-us engages)`)
}

removeIfPresent(resolve(PKG_DIR, "model.onnx"))
removeIfPresent(resolve(PKG_DIR, "tokenizer.model"))

/**
 * --- soft-feed siblings (locale-owned; the fresh-worktree anchor-OFF gap) ----------------.
 */
const SRC_GAZETTEER_LEXICON = repoRootPath("data", "gazetteer", "anchor-lexicon-v1.json")
/**
 * Country-surface lexicon generated into the repo by the codex build.
 */
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

/**
 * WOF postcode database the FR postcode binary is built from — the international build, not the US one.
 */
const FR_WOF_DB = dataRootPath("wof", "postalcode-intl.db")
/**
 * Compiled CLI used to run the build steps below. Requires `yarn compile` to have run.
 */
const CLI = repoRootPath("mailwoman", "out", "cli.js")
/**
 * Where the postcode binary is written — a soft-feed sibling, absent in a lean install.
 */
const POSTCODE_BIN_DEST = resolve(PKG_DIR, "postcode-fr.bin")

if (existsSync(POSTCODE_BIN_DEST)) {
	console.log(`skipped postcode-fr.bin build — ${POSTCODE_BIN_DEST} already present`)
} else if (!existsSync(CLI)) {
	console.error(
		`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run this script to build postcode-fr.bin.`
	)
} else if (!existsSync(FR_WOF_DB)) {
	console.error(
		`WARNING: missing ${FR_WOF_DB} — postcode-fr.bin not built; the anchor channel will resolve OFF for FR.`
	)
} else {
	const result = spawnSync(
		process.execPath,
		[CLI, "gazetteer", "postcode-binary", "--out", PKG_DIR, "--locale", `FR:${FR_WOF_DB}`],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !existsSync(POSTCODE_BIN_DEST)) {
		console.error(`ERROR: failed to build ${POSTCODE_BIN_DEST} (exit ${result.status})`)

		process.exit(1)
	}

	console.log(`built ${POSTCODE_BIN_DEST}`)
}

/**
 * Per-locale FST gazetteer (FST-distribution arc, 2026-07-25): symlink the shared build artifact
 * ($MAILWOMAN_DATA_ROOT/wof/fst-per-locale/) into the package so `resolveWeights` surfaces `fstPath` in dev and the
 * runtime pipeline can auto-wire the gazetteer + street-context gate. The publish flow stages the real binary
 * (release-sequenced).
 */
const FST_SRC = dataRootPath("wof", "fst-per-locale", "fst-fr-fr.bin")
/**
 * Where the locale FST is written — a soft-feed sibling, absent in a lean install.
 */
const FST_DEST = resolve(PKG_DIR, "fst-fr-fr.bin")

if (existsSync(FST_SRC)) {
	linkForce(FST_SRC, FST_DEST)

	console.log(`linked fst-fr-fr.bin ← ${FST_SRC}`)
} else {
	console.error(`WARNING: missing ${FST_SRC} — the FST gazetteer default will resolve OFF for this locale.`)
}

/**
 * Street-morphology FST (static-index candidate 1, 2026-07-26): symlink the sealed locale-general artifact
 * ($MAILWOMAN_DATA_ROOT/wof/fst-street-morphology.bin, `mailwoman gazetteer build street-morphology`) so
 * `resolveWeights` surfaces `streetMorphologyPath` in dev and the street-context gate (#1315) deserializes the artifact
 * instead of rebuilding from dictionaries. Missing is non-fatal — the runtime loader's dictionary-build fallback covers
 * it.
 */
const MORPHOLOGY_SRC = dataRootPath("wof", "fst-street-morphology.bin")
/**
 * Where the street-morphology FST is written — a soft-feed sibling, absent in a lean install.
 */
const MORPHOLOGY_DEST = resolve(PKG_DIR, "fst-street-morphology.bin")

if (existsSync(MORPHOLOGY_SRC)) {
	linkForce(MORPHOLOGY_SRC, MORPHOLOGY_DEST)

	console.log(`linked fst-street-morphology.bin ← ${MORPHOLOGY_SRC}`)
} else {
	console.error(
		`WARNING: missing ${MORPHOLOGY_SRC} — the street-context gate falls back to the per-process dictionary build.`
	)
}

/**
 * Placetype-pair index (hierarchy campaign R6, 2026-08-01): build `pair-index-fr.bin` from the raw BAN dump so
 * `resolveWeights` surfaces `pairIndexPath` in dev and the placetype-pair prior is live for fr-fr.
 *
 * The FR source is BAN's `nom_ld` (lieu-dit), read through `ban/sdk`'s `cleanLieuDit` — NOT WOF. WOF's French
 * neighbourhood records are Paris quartiers, which never appear in a postal address; the lieu-dit is the line French
 * addresses actually carry. See `mailwoman/gazetteer-pipeline/lieudit-pairs.ts`.
 *
 * Freshness guard: the build streams ~26M BAN rows across 101 département files, so an unconditional rebuild would make
 * every test run unusable. Peek the header and rebuild only when the calibrated delta or transition beta has moved.
 * Unlike en-gb this does NOT md5 its source — BAN is a directory of 101 files, and hashing all of them costs more than
 * the guard saves; a BAN refresh is a deliberate act, so re-run with the artifact deleted after one.
 */
const PAIR_INDEX_BIN_DEST = resolve(PKG_DIR, "pair-index-fr.bin")
/**
 * Calibrated soft-prior magnitudes — the pair the R6 bars were measured at (board 0/80 → 76/80, 0/60 confound FPs).
 */
const PAIR_INDEX_DELTA = 10
const PAIR_INDEX_TRANSITION_BETA = 5
const BAN_DIR = dataRootPath("corpus", "sources", "ban")

/**
 * Minimal PIX1 header reader — magic + header block only, reimplemented rather than imported so this data-only package
 * gains no dependency on `@mailwoman/neural`. `neural/pair-index-resolver.ts` owns the format.
 */
function peekPairIndexHeaderFields(path: string): { delta: number; transitionBeta: number | undefined } {
	const bytes = readFileSync(path)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	// "PIX1" little-endian.
	const MAGIC = 0x31_58_49_50

	if (view.getUint32(0, true) !== MAGIC) {
		throw new Error(`pair index: bad magic reading ${path}`)
	}

	const headerLen = view.getUint32(4, true)

	const header = JSON.parse(Buffer.from(bytes.subarray(8, 8 + headerLen)).toString("utf8")) as {
		delta: number
		transitionBeta?: number
	}

	return { delta: header.delta, transitionBeta: header.transitionBeta }
}

if (!existsSync(CLI)) {
	console.error(`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run for pair-index-fr.bin.`)
} else if (!existsSync(String(BAN_DIR))) {
	console.error(
		`WARNING: missing ${BAN_DIR} — pair-index-fr.bin not built; the placetype-pair prior stays inert for FR.`
	)
} else {
	let needsRebuild = true

	if (existsSync(PAIR_INDEX_BIN_DEST)) {
		try {
			const header = peekPairIndexHeaderFields(PAIR_INDEX_BIN_DEST)

			if (header.delta !== PAIR_INDEX_DELTA) {
				console.log(`rebuilding pair-index-fr.bin — delta ${header.delta} → ${PAIR_INDEX_DELTA}`)
			} else if (header.transitionBeta !== PAIR_INDEX_TRANSITION_BETA) {
				console.log(
					`rebuilding pair-index-fr.bin — transitionBeta ${header.transitionBeta} → ${PAIR_INDEX_TRANSITION_BETA}`
				)
			} else {
				needsRebuild = false
			}
		} catch (error) {
			console.log(`rebuilding pair-index-fr.bin — header unreadable (${(error as Error).message})`)
		}
	}

	if (!needsRebuild) {
		console.log(`skipped pair-index-fr.bin build — ${PAIR_INDEX_BIN_DEST} is current`)
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
				"fr",
				"--delta",
				String(PAIR_INDEX_DELTA),
				"--transition-beta",
				String(PAIR_INDEX_TRANSITION_BETA),
				"--ban-dir",
				String(BAN_DIR),
			],
			{ stdio: "inherit" }
		)

		if (result.status !== 0 || !existsSync(PAIR_INDEX_BIN_DEST)) {
			console.error(`FAILED: gazetteer pair-index --country fr (exit ${result.status})`)

			process.exit(1)
		}

		console.log(`built pair-index-fr.bin ← ${BAN_DIR}`)
	}
}
