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

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, renameSync, symlinkSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"

import { $public } from "@mailwoman/core/env"
import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"

/**
 * --- current default -------------- 6.7.0-bundle ships the v3.23.0-bundle-guard step-4000 int8 (the Option-A evidence
 * bundle; digit-guarded lexicons + inputMode register gating) + the v0.9.0-multisplice tokenizer (tokenizer UNCHANGED
 * since 6.1.0). Bump these two paths on each ship; the expected md5s live in model-card.json `files_md5` (single source
 * — see the header).
 */
const DEFAULT_MODEL = dataRootPath("models", "quantized", "model-v3240-ordinal-step-004000-int8.onnx")
/**
 * Tokenizer the workspace links when `$MAILWOMAN_DEV_TOKENIZER` is unset.
 */
const DEFAULT_TOKENIZER = dataRootPath("models", "tokenizer", "v0.9.0-multisplice", "tokenizer.model")

/**
 * Workspace root the artifacts are linked into. Everything below resolves against it.
 */
const PKG_DIR = repoRootPath("neural-weights-en-us")

/**
 * The shipped-bytes truth (#397 guard): the card's files_md5 block, which release Step 4 re-verifies against the
 * published tarball — so dev symlinks, the card, and npm agree.
 */
const CARD = JSON.parse(readFileSync(resolve(PKG_DIR, "model-card.json"), "utf8")) as {
	files_md5?: Record<string, string>
}

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

if (!existsSync(SRC_MODEL)) {
	console.error(`missing source model: ${SRC_MODEL}`)
	console.error("set MAILWOMAN_DEV_MODEL to override")

	process.exit(1)
}

if (!existsSync(SRC_TOKENIZER)) {
	console.error(`missing source tokenizer: ${SRC_TOKENIZER}`)
	console.error("set MAILWOMAN_DEV_TOKENIZER to override")

	process.exit(1)
}

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
 * Where `model.onnx` is linked. `@mailwoman/neural` auto-resolves this path.
 */
const MODEL_DEST = resolve(PKG_DIR, "model.onnx")
/**
 * Where `tokenizer.model` is linked. `@mailwoman/neural` auto-resolves this path.
 */
const TOKENIZER_DEST = resolve(PKG_DIR, "tokenizer.model")

linkForce(SRC_MODEL, MODEL_DEST)
linkForce(SRC_TOKENIZER, TOKENIZER_DEST)

console.log("linked:")
console.log(`  ${MODEL_DEST} → ${SRC_MODEL}`)
console.log(`  ${TOKENIZER_DEST} → ${SRC_TOKENIZER}`)

// --- #397 drift guard: assert default bytes match what the demo serves ------
function assertMd5(label: string, path: string, expected: string): void {
	const actual = createHash("md5").update(readFileSync(path)).digest("hex")

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
	assertMd5("model", MODEL_DEST, DEFAULT_MODEL_MD5)
} else {
	console.error("  (model override active — skipping #397 default-hash check)")
}

if (!TOKENIZER_OVERRIDDEN) {
	assertMd5("tokenizer", TOKENIZER_DEST, DEFAULT_TOKENIZER_MD5)
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

// Evidence-bundle lexicons (Option-A, v3.23): street-type is a repo file; locality-surface lives in
// the DATA ROOT (~7 MB, never in git) — a fresh worktree without $MAILWOMAN_DATA_ROOT parses with the
// locality channel resolving OFF (degrade-absent for a card that doesn't require it; fail-closed once
// the bundle card ships, which is the intended loud signal).
const SRC_STREET_TYPE_LEXICON = repoRootPath("data", "gazetteer", "street-type-lexicon-v3.json")
const SRC_LOCALITY_SURFACE_LEXICON = dataRootPath("gazetteer", "locality-surface-lexicon-v6.json")

if (existsSync(SRC_STREET_TYPE_LEXICON)) {
	linkForce(SRC_STREET_TYPE_LEXICON, resolve(PKG_DIR, "street-type-lexicon-v3.json"))

	console.log(`linked ${PKG_DIR}/street-type-lexicon-v3.json`)
} else {
	console.error(`WARNING: missing ${SRC_STREET_TYPE_LEXICON} — street_type channel will resolve OFF in this worktree.`)
}

if (existsSync(SRC_LOCALITY_SURFACE_LEXICON)) {
	linkForce(SRC_LOCALITY_SURFACE_LEXICON, resolve(PKG_DIR, "locality-surface-lexicon-v6.json"))

	console.log(`linked ${PKG_DIR}/locality-surface-lexicon-v6.json`)
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
const CLI = repoRootPath("mailwoman", "out", "cli.js")
/**
 * Where the postcode binary is written — a soft-feed sibling, absent in a lean install.
 */
const POSTCODE_BIN_DEST = resolve(PKG_DIR, "postcode-us.bin")

if (existsSync(POSTCODE_BIN_DEST)) {
	console.log(`skipped postcode-us.bin build — ${POSTCODE_BIN_DEST} already present`)
} else if (!existsSync(CLI)) {
	console.error(
		`WARNING: ${CLI} not built — run \`yarn compile\` first, then re-run this script to build postcode-us.bin.`
	)
} else if (!existsSync(US_WOF_DB)) {
	console.error(
		`WARNING: missing ${US_WOF_DB} — postcode-us.bin not built; the anchor channel will resolve OFF for US.`
	)
} else {
	const result = spawnSync(
		process.execPath,
		[CLI, "gazetteer", "postcode-binary", "--out", PKG_DIR, "--locale", `US:${US_WOF_DB}`],
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
const FST_SRC = dataRootPath("wof", "fst-per-locale", "fst-en-us.bin")
/**
 * Where the locale FST is written — a soft-feed sibling, absent in a lean install.
 */
const FST_DEST = resolve(PKG_DIR, "fst-en-us.bin")

if (existsSync(FST_SRC)) {
	linkForce(FST_SRC, FST_DEST)

	console.log(`linked fst-en-us.bin ← ${FST_SRC}`)
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
