#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Symlink dev model + tokenizer files into this package for local testing.
 *
 *   The published @mailwoman/neural-weights-en-us bundle contains the real model.onnx
 *   + tokenizer.model files (declared in package.json `files`). In the monorepo only
 *   the metadata files (package.json, model-card.json, README.md) are committed; the
 *   binaries live in `$MAILWOMAN_DATA_ROOT/models/` from training and get copied
 *   in at publish time.
 *
 *   This script symlinks the dev artifacts so `@mailwoman/neural`'s loadFromWeights
 *   can find them during local testing. Run from anywhere; resolves paths from the
 *   package dir.
 *
 *   ---------------------------------------------------------------------------
 *   #397 GUARD — why this script verifies a hash (read before editing the paths)
 *   ---------------------------------------------------------------------------
 *   `neural/test/weights.test.ts` invokes this script, so EVERY `yarn test` run
 *   re-creates these symlinks. If the defaults below point at a stale model, the
 *   whole repo silently starts grading evals against the wrong weights — which is
 *   exactly the trap that wasted an eval shift (the symlink had drifted to
 *   v0.5.3 / tokenizer v0.5.0-a1 while the deployed default was v4.0.0).
 *
 *   To make drift impossible to ignore, when the DEFAULT artifacts are used (no
 *   MAILWOMAN_DEV_MODEL / MAILWOMAN_DEV_TOKENIZER override) this script asserts the
 *   linked bytes match the package's own `model-card.json` `files_md5` — the md5s the
 *   release pipeline re-verifies the PUBLISHED tarball against. A mismatch FAILS LOUD
 *   instead of grading the wrong model.
 *
 *   ON SHIP: bump the two DEFAULT_* paths below to the new artifacts. The md5s are NOT
 *   duplicated here — they come from model-card.json, which the release-prep PR updates
 *   anyway. A path bumped without the card (or vice versa) fails the guard immediately;
 *   the 2026-07-02 v5.1.0 ship missed the path bump here and the duplicated-md5 design
 *   couldn't catch it (the stale pin was self-consistent — #259's trap, post-release form).
 *   ---------------------------------------------------------------------------
 */

import { $public } from "@mailwoman/core/env"
import { readLocalTextFile, statPath, pathExists, readLocalJSONFile, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { dataRootPath, md5File, repoRootPath, weightsOverlayPath, workspacePath } from "@mailwoman/core/utils"
import { spawnSync } from "@mailwoman/platform/child_process"
import { createHash } from "@mailwoman/platform/crypto"
import { resolve } from "@mailwoman/platform/path"
import {
	linkForce,
	pairIndexStaleReason,
	peekPairIndexHeaderFields,
	warnIfFSTStale,
} from "@mailwoman/resolver-wof-sqlite/weights-overlay-linker"

/**
 * Hex characters in an md5 digest.
 */
const MD5_HEX_LENGTH = 32

/**
 * --- current default -------------- 9.1.0 ships the v4.4.0-suffix-boundary-v2 step-60000 int8 (the suffix-boundary
 * cure on the anchor-cure base) + the v0.9.0-multisplice tokenizer (tokenizer UNCHANGED since 6.1.0). Bump this path,
 * model-card.json `files_md5`, and release.config.json `weights.model` in LOCKSTEP on each ship — the 9.0.0 cut moved
 * only release.config, which left this default and the card's md5 record on the prior base for a full release cycle.
 */
const DEFAULT_MODEL = dataRootPath("models", "quantized", "model-v440-suffix-boundary-v2-step-060000-int8.onnx")
/**
 * Tokenizer the workspace links when `$MAILWOMAN_DEV_TOKENIZER` is unset.
 */
const DEFAULT_TOKENIZER = dataRootPath("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model")

/**
 * Workspace root the artifacts are linked into. Everything below resolves against it.
 */
const PKG_DIR = workspacePath("neural-weights-en-us")
/**
 * Where the artifacts LAND — the data-root overlay, never this tracked package.
 *
 * The binaries are not in git, so materializing them here made a fresh worktree unable to geocode, made `yarn test`
 * mutate a tracked directory as a side effect of `weights.test.ts`, and put a symlink into a publish tarball
 * (`YN0035`). PKG_DIR stays for the one thing that IS committed and must be read from the checkout: `model-card.json`.
 */
const DEST_DIR = String(weightsOverlayPath("en-us"))

await makeDirectories(DEST_DIR)

/**
 * The shipped-bytes truth (#397 guard): the card's files_md5 block, which release Step 4 re-verifies against the
 * published tarball — so dev symlinks, the card, and npm agree.
 */
const CARD = await readLocalJSONFile<{
	files_md5?: Record<string, string>
}>(resolve(PKG_DIR, "model-card.json"))

/**
 * Expected model digest from the model card, checked so a stale or truncated link is caught here rather than at
 * inference.
 */
const DEFAULT_MODEL_MD5 = CARD.files_md5?.["model.onnx"]
/**
 * Expected tokenizer digest from the model card; see {@link DEFAULT_MODEL_MD5}.
 */
const DEFAULT_TOKENIZER_MD5 = CARD.files_md5?.["tokenizer.model"]

if (!DEFAULT_MODEL_MD5 || !DEFAULT_TOKENIZER_MD5) {
	console.error(
		"ERROR (#397 guard): model-card.json has no files_md5.{model.onnx,tokenizer.model} — cannot verify the dev pin."
	)

	process.exit(1)
}

/**
 * An explicit override means the caller is deliberately experimenting with a non-default model — skip the hash
 * assertion in that case (but warn loudly).
 */
const MODEL_OVERRIDDEN = !!$public.MAILWOMAN_DEV_MODEL
/**
 * Whether the tokenizer came from the environment rather than the card, which relaxes the digest check.
 */
const TOKENIZER_OVERRIDDEN = !!$public.MAILWOMAN_DEV_TOKENIZER

/**
 * Model actually linked — the environment override if set, otherwise the card's default.
 */
const SRC_MODEL = $public.MAILWOMAN_DEV_MODEL || DEFAULT_MODEL
/**
 * Tokenizer actually linked — the environment override if set, otherwise the card's default.
 */
const SRC_TOKENIZER = $public.MAILWOMAN_DEV_TOKENIZER || DEFAULT_TOKENIZER

if (!(await pathExists(SRC_MODEL))) {
	console.error(`missing source model: ${SRC_MODEL}`)
	console.error("set MAILWOMAN_DEV_MODEL to override")

	process.exit(1)
}

if (!(await pathExists(SRC_TOKENIZER))) {
	console.error(`missing source tokenizer: ${SRC_TOKENIZER}`)
	console.error("set MAILWOMAN_DEV_TOKENIZER to override")

	process.exit(1)
}

/**
 * Where `model.onnx` is linked. `@mailwoman/neural` auto-resolves this path.
 */
const MODEL_DEST = resolve(DEST_DIR, "model.onnx")
/**
 * Where `tokenizer.model` is linked. `@mailwoman/neural` auto-resolves this path.
 */
const TOKENIZER_DEST = resolve(DEST_DIR, "tokenizer.model")

linkForce(SRC_MODEL, MODEL_DEST)
linkForce(SRC_TOKENIZER, TOKENIZER_DEST)

console.log("linked:")
console.log(`  ${MODEL_DEST} → ${SRC_MODEL}`)
console.log(`  ${TOKENIZER_DEST} → ${SRC_TOKENIZER}`)

// --- #397 drift guard: assert default bytes match what the demo serves ------
async function assertMd5(label: string, path: string, expected: string): Promise<void> {
	const actual = createHash("md5")
		.update(await readLocalBuffer(path))
		.digest("hex")

	if (actual !== expected) {
		console.error("")
		console.error(`ERROR (#397 guard): linked default ${label} md5 mismatch.`)
		console.error(`  linked:   ${path}`)
		console.error(`  got:      ${actual}`)
		console.error(`  expected: ${expected} (deployed en-us defaultVersion)`)
		console.error("  The dev symlink has drifted from the deployed default. Either the")
		console.error("  artifact moved, or releases.json defaultVersion changed without a")
		console.error(`  matching bump to DEFAULT_${label.toUpperCase()}_MD5 in this script.`)

		process.exit(1)
	}
}

if (!MODEL_OVERRIDDEN) {
	await assertMd5("model", MODEL_DEST, DEFAULT_MODEL_MD5)
} else {
	console.error("  (model override active — skipping #397 default-hash check)")
}

if (!TOKENIZER_OVERRIDDEN) {
	await assertMd5("tokenizer", TOKENIZER_DEST, DEFAULT_TOKENIZER_MD5)
} else {
	console.error("  (tokenizer override active — skipping #397 default-hash check)")
}

/**
 * --- soft-feed siblings (the fresh-worktree anchor-OFF gap; mirrors en-gb's script) ------ Historically this script
 * linked only model+tokenizer, leaving `anchor-lexicon-v1.json` / `country-surface-lexicon-v1.json` / `postcode-us.bin`
 * absent in a fresh worktree — the CLI then parses anchor-OFF/gazetteer-OFF/country-OFF with only stderr warnings
 * (train/inference mismatch, visibly degraded parses: the 2026-07-23 CI unit-leg failure was "Paris, TX" resolving to
 * Paris FRANCE on the self-hosted runners' fresh checkouts for exactly this reason). The two lexicons are checked-in
 * repo files (`data/gazetteer/…` — the same source `release.config.json`'s `softFeed.*` names and
 * `scripts/copy-weights.ts` copies at publish time); `postcode-us.bin` is derived from the WOF US postcode shard, built
 * in place via the compiled `gazetteer postcode-binary` CLI (skip-if-exists — it rebuilds in seconds, and the shard is
 * versionless on disk, unlike en-gb's md5-guarded pair index).
 */
const SRC_GAZETTEER_LEXICON = repoRootPath("data", "gazetteer", "anchor-lexicon-v1.json")
/**
 * Country-surface lexicon generated into the repo by the codex build.
 */
const SRC_COUNTRY_LEXICON = repoRootPath("data", "gazetteer", "country-surface-lexicon-v1.json")

if (await pathExists(SRC_GAZETTEER_LEXICON)) {
	linkForce(SRC_GAZETTEER_LEXICON, resolve(DEST_DIR, "anchor-lexicon-v1.json"))

	console.log(`linked ${DEST_DIR}/anchor-lexicon-v1.json`)
} else {
	console.error(`WARNING: missing ${SRC_GAZETTEER_LEXICON} — gazetteer channel will resolve OFF in this worktree.`)
}

if (await pathExists(SRC_COUNTRY_LEXICON)) {
	linkForce(SRC_COUNTRY_LEXICON, resolve(DEST_DIR, "country-surface-lexicon-v1.json"))

	console.log(`linked ${DEST_DIR}/country-surface-lexicon-v1.json`)
} else {
	console.error(`WARNING: missing ${SRC_COUNTRY_LEXICON} — country channel will resolve OFF in this worktree.`)
}

// Evidence-bundle lexicons (Option-A, v3.23): street-type is a repo file; locality-surface lives in
// the DATA ROOT (~7 MB, never in git) — a fresh worktree without $MAILWOMAN_DATA_ROOT parses with the
// locality channel resolving OFF (degrade-absent for a card that doesn't require it; fail-closed once
// the bundle card ships, which is the intended loud signal).
const SRC_STREET_TYPE_LEXICON = repoRootPath("data", "gazetteer", "street-type-lexicon-v3.json")
const SRC_LOCALITY_SURFACE_LEXICON = dataRootPath("gazetteer", "locality-surface-lexicon-v7.json")

if (await pathExists(SRC_STREET_TYPE_LEXICON)) {
	linkForce(SRC_STREET_TYPE_LEXICON, resolve(DEST_DIR, "street-type-lexicon-v3.json"))

	console.log(`linked ${DEST_DIR}/street-type-lexicon-v3.json`)
} else {
	console.error(`WARNING: missing ${SRC_STREET_TYPE_LEXICON} — street_type channel will resolve OFF in this worktree.`)
}

if (await pathExists(SRC_LOCALITY_SURFACE_LEXICON)) {
	linkForce(SRC_LOCALITY_SURFACE_LEXICON, resolve(DEST_DIR, "locality-surface-lexicon-v7.json"))

	console.log(`linked ${DEST_DIR}/locality-surface-lexicon-v7.json`)
} else {
	console.error(
		`WARNING: missing ${SRC_LOCALITY_SURFACE_LEXICON} — locality_surface channel will resolve OFF in this worktree.`
	)
}

/**
 * WOF postcode database the postcode binary is built from.
 */
const US_WOF_DB = dataRootPath("wof", "postalcode-us.db")
/**
 * Compiled CLI used to run the build steps below. Requires `yarn compile` to have run.
 */
const CLI = workspacePath("mailwoman", "out", "cli.js")
/**
 * Where the postcode binary is written — a soft-feed sibling, absent in a lean install.
 */
const POSTCODE_BIN_DEST = resolve(DEST_DIR, "postcode-us.bin")

if (await pathExists(POSTCODE_BIN_DEST)) {
	console.log(`skipped postcode-us.bin build — ${POSTCODE_BIN_DEST} already present`)
} else if (!(await pathExists(CLI))) {
	console.error(
		`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run this script to build postcode-us.bin.`
	)
} else if (!(await pathExists(US_WOF_DB))) {
	console.error(
		`WARNING: missing ${US_WOF_DB} — postcode-us.bin not built; the anchor channel will resolve OFF for US.`
	)
} else {
	const result = spawnSync(
		process.execPath,
		[CLI, "gazetteer", "postcode-binary", "--out", DEST_DIR, "--locale", `US:${US_WOF_DB}`],
		{ stdio: "inherit" }
	)

	if (result.status !== 0 || !(await pathExists(POSTCODE_BIN_DEST))) {
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
const FST_SRC = dataRootPath("wof", "fst-per-locale", "fst-en-us.bin")
/**
 * Where the locale FST is written — a soft-feed sibling, absent in a lean install.
 */
const FST_DEST = resolve(DEST_DIR, "fst-en-us.bin")

if (await pathExists(FST_SRC)) {
	linkForce(FST_SRC, FST_DEST)

	console.log(`linked fst-en-us.bin ← ${FST_SRC}`)

	await warnIfFSTStale(FST_SRC, "en-us")
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
const MORPHOLOGY_DEST = resolve(DEST_DIR, "fst-street-morphology.bin")

if (await pathExists(MORPHOLOGY_SRC)) {
	linkForce(MORPHOLOGY_SRC, MORPHOLOGY_DEST)

	console.log(`linked fst-street-morphology.bin ← ${MORPHOLOGY_SRC}`)
} else {
	console.error(
		`WARNING: missing ${MORPHOLOGY_SRC} — the street-context gate falls back to the per-process dictionary build.`
	)
}

/**
 * Placetype-pair index (hierarchy campaign R5, 2026-08-01): build `pair-index-us.bin` from the WOF admin DB so
 * `resolveWeights` surfaces `pairIndexPath` in dev and the placetype-pair prior is live for en-us.
 *
 * Unlike en-gb there is NO source CSV — the US has no postal register carrying dependent localities (USPS routes
 * city/state/ZIP), so every pair comes from `--borough-db`. The command refuses a build with no source of any kind, so
 * dropping the flag fails loud rather than writing an empty index.
 *
 * Freshness guard: the test suite shells this script out on every run, so an unconditional rebuild would cost minutes
 * per `yarn test`. Peek the header instead and rebuild only when the FORMAT (`schemaVersion`), a calibrated magnitude,
 * or the source DB's md5 has moved. The format+magnitude half of that comparison lives in
 * `@mailwoman/resolver-wof-sqlite/weights-overlay-linker`'s `pairIndexStaleReason` — shared with the other three base
 * linkers and every overlay, because when each script carried its own copy three of the four could not notice a schema
 * bump. The md5 half stays here: only this script knows which sources it passes. An ABSENT optional magnitude reads
 * `undefined` and forces the rebuild that stamps it in.
 */
const PAIR_INDEX_BIN_DEST = resolve(DEST_DIR, "pair-index-us.bin")
/**
 * Calibrated soft-prior magnitudes — the SAME set the R5 bars were measured with (gauntlet unchanged, 0/60
 * venue-confound false positives, 60/60 tag-correct). Changing any of these numbers invalidates those receipts.
 *
 * `PAIR_INDEX_PARENT_DELTA` is the whole-edge parent bias (#46), default-on for US at the verdict's recommended δ=5 —
 * the smallest magnitude that saturates bar B-2's brooklyn-class sub-board (18.3% → 98.3% whole-edge), flat from there
 * to 20, with 0.00% parent-side false positives on B-3. See
 * `docs/records/evals/2026-08-04-pix1-whole-edge-verdict.md`.
 */
const PAIR_INDEX_DELTA = 10
const PAIR_INDEX_TRANSITION_BETA = 5
const PAIR_INDEX_PARENT_DELTA = 5
const PAIR_INDEX_SOURCE_DB = dataRootPath("wof", "admin-global-priority.db")

/**
 * Read or compute the md5 of a file, using a sidecar `.md5` cache so a multi-gigabyte source isn't re-hashed on every
 * `yarn test` (the borough DB is ~5 GB). The sidecar is written in standard md5sum format: `<hash> <filename>`. It is
 * trusted only while its mtime is at least the source's; an older sidecar is recomputed and rewritten. Mirrors the
 * en-gb/en-nz link scripts rather than importing theirs — each weights package's script stands alone.
 */
async function md5FileWithSidecar(path: string): Promise<string> {
	const sidecarPath = `${path}.md5`
	const sourceStats = await statPath(path)

	if (await pathExists(sidecarPath)) {
		try {
			const sidecarStats = await statPath(sidecarPath)

			if (sidecarStats.mtime >= sourceStats.mtime) {
				const sidecarContent = (await readLocalTextFile(sidecarPath)).trim()
				const [hash] = sidecarContent.split(/\s+/)

				if (hash && hash.length === MD5_HEX_LENGTH) {
					console.log(`md5(${path}): read from sidecar`)

					return hash
				}
			}
		} catch {
			// A missing or malformed sidecar is not an error — recompute below.
		}
	}

	const hash = await md5File(path)
	const filename = path.split(/[/\\]/).pop() || path

	await writeLocalTextFile(`${hash}  ${filename}\n`, sidecarPath)

	console.log(`md5(${path}): computed and cached in sidecar`)

	return hash
}

if (!(await pathExists(CLI))) {
	console.error(
		`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run this script for pair-index-us.bin.`
	)
} else if (!(await pathExists(String(PAIR_INDEX_SOURCE_DB)))) {
	console.error(
		`WARNING: missing ${PAIR_INDEX_SOURCE_DB} — pair-index-us.bin not built; the placetype-pair prior stays inert for US.`
	)
} else {
	let needsRebuild = true

	if (await pathExists(PAIR_INDEX_BIN_DEST)) {
		try {
			const header = await peekPairIndexHeaderFields(PAIR_INDEX_BIN_DEST)
			// EVERY md5 the header records has to match. A comparison that covers only some of them leaves the
			// guard blind to the rest, and a stale artifact then keeps reporting itself fresh while the data it was
			// built from has moved. The US build passes exactly one source (`--borough-db`; there is no register CSV
			// and no `--pairs-jsonl`), so `gazetteer pair-index` records exactly one md5 and the comparison below IS
			// the whole set — a header recording any other count cannot have come from this build, which is itself
			// staleness. The hash is sidecar-cached, so re-reading it on every `yarn test` costs a stat.
			const currentSourceMD5 = await md5FileWithSidecar(String(PAIR_INDEX_SOURCE_DB))
			const [existingSourceMD5] = header.sourceMD5s

			const staleReason = pairIndexStaleReason(header, {
				delta: PAIR_INDEX_DELTA,
				transitionBeta: PAIR_INDEX_TRANSITION_BETA,
				parentDelta: PAIR_INDEX_PARENT_DELTA,
			})

			if (staleReason) {
				console.log(`rebuilding pair-index-us.bin — ${staleReason}`)
			} else if (header.sourceMD5s.length !== 1) {
				console.log(
					`rebuilding pair-index-us.bin — header records ${header.sourceMD5s.length} source md5s ` +
						`[${header.sourceMD5s.join(", ") || "(none recorded)"}], but this build reads exactly one source ` +
						`(${PAIR_INDEX_SOURCE_DB})`
				)
			} else if (existingSourceMD5 !== currentSourceMD5) {
				console.log(
					`rebuilding pair-index-us.bin — ${PAIR_INDEX_SOURCE_DB} md5 ${existingSourceMD5} → ${currentSourceMD5}`
				)
			} else {
				needsRebuild = false
			}
		} catch (error) {
			// Covers both an unreadable header and a source md5 that could not be computed: either way the
			// artifact cannot be shown fresh, and an unverifiable index is treated as stale.
			console.log(`rebuilding pair-index-us.bin — freshness unverifiable (${(error as Error).message})`)
		}
	}

	if (!needsRebuild) {
		console.log(`skipped pair-index-us.bin build — ${PAIR_INDEX_BIN_DEST} is current`)
	} else {
		const result = spawnSync(
			process.execPath,
			[
				CLI,
				"gazetteer",
				"pair-index",
				"--out",
				DEST_DIR,
				"--country",
				"us",
				"--delta",
				String(PAIR_INDEX_DELTA),
				"--transition-beta",
				String(PAIR_INDEX_TRANSITION_BETA),
				"--parent-delta",
				String(PAIR_INDEX_PARENT_DELTA),
				"--borough-db",
				String(PAIR_INDEX_SOURCE_DB),
			],
			{ stdio: "inherit" }
		)

		if (result.status !== 0 || !(await pathExists(PAIR_INDEX_BIN_DEST))) {
			console.error(`FAILED: gazetteer pair-index --country us (exit ${result.status})`)

			process.exit(1)
		}

		console.log(`built pair-index-us.bin ← ${PAIR_INDEX_SOURCE_DB}`)
	}
}
