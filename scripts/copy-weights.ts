#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Copy the trained neural model + tokenizer into each `neural-weights-<locale>` workspace so `npm
 *   publish` picks them up via the package's `files` glob. The workspace dirs hold only metadata in
 *   git (gitignored model.onnx + tokenizer.model); this script materializes the binaries at release
 *   time.
 *
 *   The source model + tokenizer FILENAMES come from `release.config.json` (`weights.model` /
 *   `weights.tokenizer`) so the version-bearing names live in one place rather than hardcoded here.
 *   They resolve against `mailwomanDataRoot()`, which is the one home for the root itself. Override
 *   at release time via env vars:
 *
 *   - MAILWOMAN_DATA_ROOT: the machine's data dir
 *   - MAILWOMAN_PUBLISH_MODEL: absolute path to the int8 quantized model.onnx (wins outright)
 *   - MAILWOMAN_PUBLISH_TOKENIZER: absolute path to the matching tokenizer.model (wins outright)
 *
 *   Also materializes the #718 D1 SOFT-FEED artifacts so the library default `loadFromWeights` feeds
 *   the anchor + gazetteer channels the trained model expects (without these, the package's default
 *   load path serves the model anchor-OFF — the #566/#685 OOD crater):
 *
 *   - `postcode-<cc>.bin` — the compact PCB1 postcode-anchor binary, built from the WOF postcode shard
 *       (`softFeed.postcodeDBByCountry[<cc>]`) via `mailwoman gazetteer postcode-binary`.
 *   - `anchor-lexicon-v1.json` — the codex-generated gazetteer-anchor lexicon
 *       (`softFeed.gazetteerLexicon`).
 *   - `pair-index-<cc>.bin` — the placetype-pair-prior arc's PIX1 retrieval index, built from a
 *       PPD-style (child, parent) tuples CSV (`softFeed.pairIndexByCountry[<cc>].source` + `.delta`) via
 *       `mailwoman gazetteer pair-index`. COUNTRY-SPECIFIC BY DESIGN — a workspace whose country has no
 *       `pairIndexByCountry` entry ships no sibling and is silently skipped (see materializePairIndex).
 *
 *   Idempotent. Used by .release-it.json's before:init hook.
 */

import { spawnSync } from "node:child_process"
import type { PathLike } from "node:fs"
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import { copyFile, mkdir, stat, unlink } from "node:fs/promises"
import { resolve } from "node:path"

import { $public } from "@mailwoman/core/env"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { runIfScript } from "@mailwoman/core/scripting"
import { mailwomanDataRoot, repoRootPath } from "@mailwoman/core/utils"

import { derivedWeightsDir, derivedWeightsKey } from "./derived-weights-key.ts"

const repoRoot = repoRootPath()

/**
 * The derived-artifact store for THIS checkout's inputs. Computed once — the key is a hash over files that do not
 * change mid-run.
 */
const derivedStore = derivedWeightsDir(derivedWeightsKey())

/**
 * Serve `filename` into `dir` from the derived store, if this checkout's key already has it.
 *
 * Returns true when the file was placed, which tells the caller to skip its CLI spawn. A miss returns false; the caller
 * builds and then calls {@link stashDerived}.
 *
 * Replaces the actions/cache round-trip that carried 76.3 MB at ~1.6 MB/s (48–54s per leg) to a runner that already
 * holds the source model locally. See scripts/derived-weights-key.ts.
 */
function serveFromDerivedStore(dir: string, filename: string): boolean {
	const cached = resolve(derivedStore, filename)

	if (!existsSync(cached)) return false

	const dest = resolve(dir, filename)

	// Unlink first. `fs.copyFile` FOLLOWS a symlink at the destination and writes THROUGH it, leaving
	// the symlink in place — and the registry refuses a tarball containing one (HTTP 415, YN0035).
	// Same discipline as the rest of this script; see AGENTS.md "symlinks in the publish tarball".
	try {
		unlinkSync(dest)
	} catch {
		// Nothing there to remove.
	}

	copyFileSync(cached, dest)
	process.stderr.write(`derived store HIT → ${filename}\n`)

	return true
}

/**
 * Deposit a freshly-built `filename` into the derived store under this checkout's key.
 *
 * Best-effort by design: a store write that fails must never fail a release. The build already succeeded and the
 * workspace already has the artifact — the store is an optimization, not a source of truth, so a failure here costs the
 * next run five minutes and nothing else.
 */
function stashDerived(dir: string, filename: string): void {
	try {
		mkdirSync(derivedStore, { recursive: true })
		copyFileSync(resolve(dir, filename), resolve(derivedStore, filename))
		process.stderr.write(`derived store WRITE → ${filename}\n`)
	} catch (error) {
		process.stderr.write(`derived store write skipped for ${filename}: ${String(error)}\n`)
	}
}

/**
 * The slice of `release.config.json` this script reads. `softFeed` stays loose — its per-locale shape is validated at
 * each use site, and a schema here would be a second place to update when a locale gains an artifact.
 */
interface ReleaseConfig {
	locales: string[]
	weights: { model: string; tokenizer: string }
	softFeed?: Record<string, unknown>
}

const config = parseJSONStrict<ReleaseConfig>(readFileSync(resolve(repoRoot, "release.config.json"), "utf8"))
const dataRoot = String(mailwomanDataRoot())
/**
 * Model binary to copy into each weights workspace before packing.
 */
const SOURCE_MODEL = $public.MAILWOMAN_PUBLISH_MODEL ?? resolve(dataRoot, config.weights.model)
/**
 * Tokenizer binary to copy into each weights workspace before packing.
 */
const SOURCE_TOKENIZER = $public.MAILWOMAN_PUBLISH_TOKENIZER ?? resolve(dataRoot, config.weights.tokenizer)

/**
 * Soft-feed artifact paths from the release config. Absent entries simply mean the locale ships without that sibling,
 * which is a supported (lean) install rather than an error.
 */
const SOFT_FEED = config.softFeed ?? {}
/**
 * Anchor lexicon source, or null when this release ships without one.
 */
const SOURCE_GAZETTEER = SOFT_FEED.gazetteerLexicon ? resolve(repoRoot, SOFT_FEED.gazetteerLexicon) : null
/**
 * Country-surface lexicon source, or null when this release ships without one.
 */
const SOURCE_COUNTRY = SOFT_FEED.countryLexicon ? resolve(repoRoot, SOFT_FEED.countryLexicon) : null
// Option-A evidence bundle (v3.23): street-type is a small repo-committed file; locality-surface is a
// ~7 MB data-root artifact (never in git) — note the DIFFERENT base dirs.
const SOURCE_STREET_TYPE = SOFT_FEED.streetTypeLexicon ? resolve(repoRoot, SOFT_FEED.streetTypeLexicon) : null

const SOURCE_LOCALITY_SURFACE = SOFT_FEED.localitySurfaceLexicon
	? resolve(dataRoot, SOFT_FEED.localitySurfaceLexicon)
	: null

/**
 * Per-country pair-index build inputs, keyed by country code.
 *
 * Every field the `gazetteer pair-index` command accepts is represented, because this path builds the SHIPPED artifact
 * and any flag it silently drops produces a materially different binary from the one the model card's md5 records. That
 * bug was live until 2026-08-01: the type declared only `{ source, delta }`, so the release build rebuilt
 * `pair-index-gb.bin` WITHOUT the calibrated `transitionBeta` and WITHOUT the R2/R3/R4b borough + London pair sources —
 * a quietly degraded index. It never shipped because CI sets `MAILWOMAN_SKIP_WEIGHTS_COPY` and the operator publishes
 * the dev-linked binary, but a local `yarn release` would have produced it.
 *
 * `source` is OPTIONAL: it is the GB postal register (PPD), and countries whose pairs come entirely from the WOF admin
 * DB (US) have no equivalent — the command itself refuses a build with no source of any kind.
 */
const PAIR_INDEX_BY_COUNTRY: Record<
	string,
	{ source?: string; delta: number; transitionBeta?: number; boroughDb?: string; pairsJsonl?: string; banDir?: string }
> = SOFT_FEED.pairIndexByCountry ?? {}

/**
 * Weights workspaces to materialize, derived from the release config's locale list.
 */
const TARGETS = config.locales.map((locale: string) => `neural-weights-${locale}`)

async function exists(path: PathLike) {
	try {
		await stat(path)

		return true
	} catch {
		return false
	}
}

async function main() {
	// CI release workflow sets MAILWOMAN_SKIP_WEIGHTS_COPY=1 when release_weights
	// input is false (the default). Weights binaries live at /mnt/playpen on the
	// operator's host and aren't fetchable from CI; the workflow excludes the
	// weights workspaces from the publish set in that mode, so skipping the
	// copy is correct.
	if ($public.MAILWOMAN_SKIP_WEIGHTS_COPY) {
		process.stderr.write("copy-weights: MAILWOMAN_SKIP_WEIGHTS_COPY set — skipping.\n")

		return
	}

	if (!(await exists(SOURCE_MODEL))) {
		throw new Error(`Missing source model: ${SOURCE_MODEL}\nSet MAILWOMAN_PUBLISH_MODEL to override.`)
	}

	if (!(await exists(SOURCE_TOKENIZER))) {
		throw new Error(`Missing source tokenizer: ${SOURCE_TOKENIZER}\nSet MAILWOMAN_PUBLISH_TOKENIZER to override.`)
	}

	for (const workspace of TARGETS) {
		const dir = resolve(repoRoot, workspace)
		await mkdir(dir, { recursive: true })
		const modelDest = resolve(dir, "model.onnx")
		const tokenizerDest = resolve(dir, "tokenizer.model")
		// Unlink first so a pre-existing symlink (from link-dev-weights.ts) is
		// replaced with a real file. Otherwise copyFile follows the symlink and
		// writes through it, leaving the symlink in place — which yarn refuses
		// to publish (npm registry rejects symlinks with HTTP 415).
		await removeIfPresent(modelDest)
		await removeIfPresent(tokenizerDest)
		await copyFile(SOURCE_MODEL, modelDest)
		await copyFile(SOURCE_TOKENIZER, tokenizerDest)
		process.stderr.write(`copied weights → ${workspace}/{model.onnx,tokenizer.model}\n`)

		await materializeSoftFeed(workspace, dir)
		await materializeFST(workspace, dir)
		await materializeStreetMorphology(workspace, dir)
		await materializePairIndex(workspace, dir)
	}
}

/**
 * Materialize the per-locale FST gazetteer binary (#1318 FST-distribution arc) into a weights workspace. The source
 * binary lives at $MAILWOMAN_DATA_ROOT/wof/fst-per-locale/fst-<locale>.bin — a verbatim copy (no build step). En-nz has
 * no FST sibling and is skipped silently (byte-stable).
 */
async function materializeFST(workspace: string, dir: string) {
	const locale = workspace.replace(/^neural-weights-/, "")
	const src = resolve(dataRoot, "wof", "fst-per-locale", `fst-${locale}.bin`)

	if (!existsSync(src)) {
		process.stderr.write(
			`copy-weights: no FST at ${src} — skipping ${workspace}/fst-${locale}.bin (byte-stable; en-nz has none)\n`
		)

		return
	}

	const dest = resolve(dir, `fst-${locale}.bin`)
	await removeIfPresent(dest)
	await copyFile(src, dest)
	process.stderr.write(`copied FST → ${workspace}/fst-${locale}.bin\n`)
}

/**
 * Materialize the locale-GENERAL street-morphology FST (`fst-street-morphology.bin`, the #1315 street-context gate's
 * signal source) into a weights workspace — a verbatim copy of the sealed artifact staged by `mailwoman gazetteer build
 * street-morphology` at $MAILWOMAN_DATA_ROOT/wof/. Shipping it as a weights sibling is what carries it to the
 * per-version R2 asset layout the browser demo fetches — the node runtimes can rebuild from the bundled libpostal
 * dictionaries, the browser cannot. A missing source is skipped with a warning (byte-stable: node consumers fall back
 * to the per-process dictionary build; the demo parses without the street-context gate, exactly as before).
 */
async function materializeStreetMorphology(workspace: string, dir: string) {
	const src = resolve(dataRoot, "wof", "fst-street-morphology.bin")

	if (!existsSync(src)) {
		process.stderr.write(
			`copy-weights: no street-morphology FST at ${src} — skipping ${workspace}/fst-street-morphology.bin (byte-stable)\n`
		)

		return
	}

	const dest = resolve(dir, "fst-street-morphology.bin")
	await removeIfPresent(dest)
	await copyFile(src, dest)
	process.stderr.write(`copied street-morphology FST → ${workspace}/fst-street-morphology.bin\n`)
}

/**
 * Materialize the #718 D1 soft-feed artifacts into a weights workspace: the gazetteer-anchor lexicon (a verbatim copy)
 * + the per-country PCB1 postcode-anchor binary (built fresh from the WOF shard). Both `removeIfPresent` first — same
 * symlink-in-tarball trap the model/tokenizer copy guards against.
 */
async function materializeSoftFeed(workspace: string, dir: string) {
	// Gazetteer-anchor lexicon (#464) — a small JSON, copied verbatim from the repo source.
	if (SOURCE_GAZETTEER) {
		if (!(await exists(SOURCE_GAZETTEER))) {
			throw new Error(
				`Missing gazetteer lexicon: ${SOURCE_GAZETTEER}\nSet softFeed.gazetteerLexicon in release.config.json.`
			)
		}

		const dest = resolve(dir, "anchor-lexicon-v1.json")
		await removeIfPresent(dest)
		await copyFile(SOURCE_GAZETTEER, dest)
		process.stderr.write(`copied soft-feed → ${workspace}/anchor-lexicon-v1.json\n`)
	}

	// Country-surface lexicon (#1104) — the dedicated country soft-feed vocabulary, copied verbatim from
	// the repo source. Ships alongside the gazetteer lexicon for models whose card carries requires.country.
	if (SOURCE_COUNTRY) {
		if (!(await exists(SOURCE_COUNTRY))) {
			throw new Error(`Missing country lexicon: ${SOURCE_COUNTRY}\nSet softFeed.countryLexicon in release.config.json.`)
		}

		const dest = resolve(dir, "country-surface-lexicon-v1.json")
		await removeIfPresent(dest)
		await copyFile(SOURCE_COUNTRY, dest)
		process.stderr.write(`copied soft-feed → ${workspace}/country-surface-lexicon-v1.json\n`)
	}

	// Evidence-bundle lexicons (Option-A, v3.23): copied verbatim like the gazetteer/country lexicons —
	// every locale package ships them because every locale ships the same bundle-trained base model
	// (the card carries requires.street_type/locality_surface; withholding a sibling would fail closed).
	for (const [source, basename, label] of [
		[SOURCE_STREET_TYPE, "street-type-lexicon-v3.json", "softFeed.streetTypeLexicon"],
		[SOURCE_LOCALITY_SURFACE, "locality-surface-lexicon-v6.json", "softFeed.localitySurfaceLexicon"],
	] as const) {
		if (!source) continue

		if (!(await exists(source))) {
			throw new Error(`Missing evidence lexicon: ${source}\nSet ${label} in release.config.json.`)
		}

		const dest = resolve(dir, basename)
		await removeIfPresent(dest)
		await copyFile(source, dest)
		process.stderr.write(`copied soft-feed → ${workspace}/${basename}\n`)
	}

	// PCB1 postcode-anchor binary (#240) — built from the locale's WOF postcode shard. The locale's
	// region subtag (`en-us` → `us`) names both the binary and the postcodeDBByCountry source entry.
	const country = workspace.replace(/^neural-weights-[a-z]+-/, "")
	const dbRel = SOFT_FEED.postcodeDBByCountry?.[country]

	if (!dbRel) {
		process.stderr.write(
			`soft-feed: no postcodeDBByCountry entry for "${country}" — skipping ${workspace}/postcode-${country}.bin\n`
		)

		return
	}

	const db = dbRel.startsWith("/") ? dbRel : resolve(dataRoot, "wof", dbRel)

	if (!existsSync(db)) {
		throw new Error(
			`Missing postcode shard for ${country}: ${db}\nSet MAILWOMAN_DATA_ROOT or softFeed.postcodeDBByCountry.`
		)
	}

	const binDest = resolve(dir, `postcode-${country}.bin`)

	if (serveFromDerivedStore(dir, `postcode-${country}.bin`)) return

	await removeIfPresent(binDest)
	// `gazetteer postcode-binary` is the compiled Pastel command (ported from the old
	// scripts/build-postcode-binary.ts). `.release-it.json` runs `yarn compile` right before this
	// script, so mailwoman/out/cli.js exists. --out is the workspace dir, so the command writes
	// postcode-<cc>.bin directly where the `files` array expects it.
	const cli = resolve(repoRoot, "mailwoman/out/cli.js")

	const r = spawnSync(
		process.execPath,
		[cli, "gazetteer", "postcode-binary", "--out", dir, "--locale", `${country.toUpperCase()}:${db}`],
		{ stdio: "inherit" }
	)

	if (r.status !== 0) throw new Error(`gazetteer postcode-binary failed for ${country} (exit ${r.status})`)

	if (!existsSync(binDest)) throw new Error(`gazetteer postcode-binary ran but ${binDest} was not produced`)
	stashDerived(dir, `postcode-${country}.bin`)
	process.stderr.write(`built soft-feed → ${workspace}/postcode-${country}.bin\n`)
}

/**
 * Materialize the placetype-pair-prior arc's PIX1 index (`pair-index-<cc>.bin`) into a weights workspace — mirrors
 * {@link materializeSoftFeed}'s postcode-binary block exactly, but keyed off `softFeed.pairIndexByCountry` (a CSV
 * source + a required calibrated `--delta`, not a WOF DB) instead of `postcodeDBByCountry`. COUNTRY-SPECIFIC BY DESIGN,
 * same as the runtime resolver (`neural/weights.ts`'s `resolvePairIndexSibling`): a workspace whose country has no
 * `pairIndexByCountry` entry ships no pair-index sibling and is skipped silently (not every locale gets one).
 */
async function materializePairIndex(workspace: string, dir: string) {
	const country = workspace.replace(/^neural-weights-[a-z]+-/, "")
	const entry = PAIR_INDEX_BY_COUNTRY[country]

	if (!entry) {
		return
	}

	// Inputs resolve against DIFFERENT roots, and conflating them is a real failure mode (it broke CI once):
	// `source` and `boroughDb` are large acquired datasets under the data root, while `pairsJsonl` is a curated file
	// CHECKED INTO THE REPO (`data/gazetteer/london-pairs-v2.jsonl`). Absolute paths pass through untouched either way.
	const resolveFrom = (root: string, value: string) => (value.startsWith("/") ? value : resolve(root, value))
	const source = entry.source ? resolveFrom(dataRoot, entry.source) : undefined
	const boroughDb = entry.boroughDb ? resolveFrom(dataRoot, entry.boroughDb) : undefined

	// A COMMA-SEPARATED list since R7 (London + NI): resolve each entry, then rejoin.
	const pairsJsonl = entry.pairsJsonl
		? entry.pairsJsonl
				.split(",")
				.map((path) => resolveFrom(repoRoot, path.trim()))
				.join(",")
		: undefined

	const banDir = entry.banDir ? resolveFrom(dataRoot, entry.banDir) : undefined

	for (const path of pairsJsonl ? pairsJsonl.split(",") : []) {
		if (!existsSync(path)) {
			throw new Error(`Missing pair-index pairs JSONL for ${country}: ${path}`)
		}
	}

	for (const [label, path] of [
		["source CSV", source],
		["borough DB", boroughDb],

		["BAN dir", banDir],
	] as const) {
		if (path && !existsSync(path)) {
			throw new Error(
				`Missing pair-index ${label} for ${country}: ${path}\nSet MAILWOMAN_DATA_ROOT or softFeed.pairIndexByCountry.${country}.`
			)
		}
	}

	const binDest = resolve(dir, `pair-index-${country}.bin`)

	if (serveFromDerivedStore(dir, `pair-index-${country}.bin`)) return

	await removeIfPresent(binDest)
	// `gazetteer pair-index` is the compiled Pastel command; `.release-it.json` runs `yarn compile` right
	// before this script, so mailwoman/out/cli.js exists (same precondition as postcode-binary above).
	const cli = resolve(repoRoot, "mailwoman/out/cli.js")

	const r = spawnSync(
		process.execPath,
		[
			cli,
			"gazetteer",
			"pair-index",
			"--out",
			dir,
			"--country",
			country,
			"--delta",
			String(entry.delta),
			...(source ? ["--source", source] : []),
			...(entry.transitionBeta !== undefined ? ["--transition-beta", String(entry.transitionBeta)] : []),
			...(boroughDb ? ["--borough-db", boroughDb] : []),
			...(pairsJsonl ? ["--pairs-jsonl", pairsJsonl] : []),
			...(banDir ? ["--ban-dir", banDir] : []),
		],
		{ stdio: "inherit" }
	)

	if (r.status !== 0) throw new Error(`gazetteer pair-index failed for ${country} (exit ${r.status})`)

	if (!existsSync(binDest)) throw new Error(`gazetteer pair-index ran but ${binDest} was not produced`)
	stashDerived(dir, `pair-index-${country}.bin`)
	process.stderr.write(`built soft-feed → ${workspace}/pair-index-${country}.bin (delta=${entry.delta})\n`)
}

async function removeIfPresent(path: PathLike) {
	try {
		await unlink(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
}

runIfScript(import.meta, main)
