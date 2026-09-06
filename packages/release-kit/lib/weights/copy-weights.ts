/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Copy the trained neural model + tokenizer into each `neural-weights-<locale>` workspace so `npm
 *   publish` picks them up via the package's `files` glob. The workspace dirs hold only metadata in
 *   git (gitignored model.onnx + tokenizer.model); this operation materializes the binaries at release
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
 *   - `postcode-<cc>.bin` — the compact PCB1 postcode-anchor binary, built from the WOF postcode extract
 *       (`softFeed.postcodeDBByCountry[<cc>]`) via `mailwoman gazetteer postcode-binary`.
 *   - `anchor-lexicon-v1.json` — the codex-generated gazetteer-anchor lexicon
 *       (`softFeed.gazetteerLexicon`).
 *   - `pair-index-<cc>.bin` — the placetype-pair-prior arc's PIX1 retrieval index, built from a
 *       PPD-style (child, parent) tuples CSV (`softFeed.pairIndexByCountry[<cc>].source` + `.delta`) via
 *       `mailwoman gazetteer pair-index`. COUNTRY-SPECIFIC BY DESIGN — a workspace whose country has no
 *       `pairIndexByCountry` entry ships no sibling and is silently skipped (see materializePairIndex).
 *
 *   Idempotent. Used by .release-it.json's before:init hook through `mwops release copy-weights`.
 */

import { mailwomanDataRoot } from "@mailwoman/core/data-root"
import { pathExists, tryStat } from "@mailwoman/core/fs/readers"
import { copyFileTo, makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { spawnProcessSync } from "@mailwoman/core/process"
import { resolvePath } from "path-ts"

import { $public } from "#env/index"
import { derivedStoreServeViolation, derivedWeightsDir, derivedWeightsKey } from "#weights/derived-weights-key"
import {
	type PairIndexInputs,
	readReleaseConfig,
	repoCommittedSoftFeedSources,
	type SoftFeedRecipe,
} from "#weights/weights-recipe"

export interface CopyWeightsOptions {
	/**
	 * The checkout whose `release.config.json` and data root supply every source.
	 */
	repoRoot: string
	/**
	 * Where the weights workspaces are written — the source checkout (the release path), or a #1894 preflight's staging
	 * tree. Sources always resolve against THIS checkout's data root and release.config.json; only destinations move.
	 */
	destRoot?: string
	log: (line: string) => void
}

export interface CopyWeightsReport {
	skipped: boolean
	workspaces: string[]
}

/**
 * Everything one materialization run resolves once and every step reads: paths, the recipe, and the derived store.
 */
interface MaterializationContext {
	repoRoot: string
	dataRoot: string
	/**
	 * The derived-artifact store for THIS checkout's inputs. Computed once — the key is a hash over files that do not
	 * change mid-run.
	 */
	derivedStore: string
	softFeed: SoftFeedRecipe
	/**
	 * The repo-committed soft-feed lexicons (gazetteer #464, country #1104, street-type Option-A), shipped-name →
	 * absolute source. The per-key base-directory rule lives in `weights-recipe.ts`; only the BUILT locality-surface
	 * lexicon resolves against the data root instead.
	 */
	repoCommittedSources: Map<string, string>
	sourceLocalitySurface: string | null
	/**
	 * Per-country pair-index build inputs, keyed by country code — the fully-typed `PairIndexInputs` shape from
	 * `weights-recipe.ts`, whose docstring records why a silently-dropped flag is a shipping defect.
	 */
	pairIndexByCountry: Record<string, PairIndexInputs>
	log: (line: string) => void
}

/**
 * Serve `filename` into `dir` from the derived store, if this checkout's key already has it.
 *
 * Returns true when the file was placed, which tells the caller to skip its CLI spawn. A miss returns false; the caller
 * builds and then calls {@link stashDerived}.
 *
 * Replaces the actions/cache round-trip that carried 76.3 MB at ~1.6 MB/s (48–54s per leg) to a runner that already
 * holds the source model locally. See `derived-weights-key.ts`.
 */
async function serveFromDerivedStore(context: MaterializationContext, dir: string, filename: string): Promise<boolean> {
	const cached = resolvePath(context.derivedStore, filename)

	if (!(await pathExists(cached))) return false

	// A poisoned entry is worse than a miss: it reports HIT while feeding a channel nothing (#1528's
	// empty postcode-gb.bin). Refuse, evict, rebuild.
	const violation = await derivedStoreServeViolation(filename, cached)

	if (violation) {
		context.log(`derived store POISONED entry evicted → ${filename}: ${violation}`)
		await removePathIfPresent(cached)

		return false
	}

	const dest = resolvePath(dir, filename)

	// Unlink first. `fs.copyFile` FOLLOWS a symlink at the destination and writes THROUGH it, leaving
	// the symlink in place — and the registry refuses a tarball containing one (HTTP 415, YN0035).
	// Same discipline as the rest of this module; see AGENTS.md "symlinks in the publish tarball".
	await removePathIfPresent(dest)

	await copyFileTo(cached, dest)
	context.log(`derived store HIT → ${filename}`)

	return true
}

/**
 * Deposit a freshly-built `filename` into the derived store under this checkout's key.
 *
 * Best-effort by design: a store write that fails must never fail a release. The build already succeeded and the
 * workspace already has the artifact — the store is an optimization, not a source of truth, so a failure here costs the
 * next run five minutes and nothing else.
 */
async function stashDerived(context: MaterializationContext, dir: string, filename: string): Promise<void> {
	// Never poison the store: a below-floor build must not become the artifact every future run
	// receives as a HIT. The build-time floors are the primary check; this holds when they are
	// bypassed (a stale-compiled builder predating them was #1528's exact shape).
	const violation = await derivedStoreServeViolation(filename, resolvePath(dir, filename))

	if (violation) {
		context.log(`derived store stash REFUSED for ${filename}: ${violation}`)

		return
	}

	try {
		await makeDirectories(context.derivedStore)
		await copyFileTo(resolvePath(dir, filename), resolvePath(context.derivedStore, filename))
		context.log(`derived store WRITE → ${filename}`)
	} catch (error) {
		context.log(`derived store write skipped for ${filename}: ${String(error)}`)
	}
}

/**
 * Materialize every weights workspace's binaries and evidence artifacts under `destRoot`.
 */
export async function copyWeights({
	repoRoot,
	destRoot = repoRoot,
	log,
}: CopyWeightsOptions): Promise<CopyWeightsReport> {
	// CI release workflow sets MAILWOMAN_SKIP_WEIGHTS_COPY=1 when release_weights
	// input is false (the default). Weights binaries live on the operator's host and
	// aren't fetchable from CI; the workflow excludes the weights workspaces from the
	// publish set in that mode, so skipping the copy is correct.
	if ($public.MAILWOMAN_SKIP_WEIGHTS_COPY) {
		log("copy-weights: MAILWOMAN_SKIP_WEIGHTS_COPY set — skipping.")

		return { skipped: true, workspaces: [] }
	}

	const config = await readReleaseConfig(repoRoot)
	const dataRoot = String(mailwomanDataRoot())
	const softFeed: SoftFeedRecipe = config.softFeed ?? {}

	const context: MaterializationContext = {
		repoRoot,
		dataRoot,
		derivedStore: derivedWeightsDir(await derivedWeightsKey()),
		softFeed,
		repoCommittedSources: repoCommittedSoftFeedSources(repoRoot, softFeed),
		sourceLocalitySurface: softFeed.localitySurfaceLexicon
			? resolvePath(dataRoot, softFeed.localitySurfaceLexicon)
			: null,
		pairIndexByCountry: softFeed.pairIndexByCountry ?? {},
		log,
	}

	/**
	 * Model binary to copy into each weights workspace before packing.
	 */
	const sourceModel = $public.MAILWOMAN_PUBLISH_MODEL ?? resolvePath(dataRoot, config.weights.model)
	/**
	 * Tokenizer binary to copy into each weights workspace before packing.
	 */
	const sourceTokenizer = $public.MAILWOMAN_PUBLISH_TOKENIZER ?? resolvePath(dataRoot, config.weights.tokenizer)

	if (!(await tryStat(sourceModel))) {
		throw new Error(`Missing source model: ${sourceModel}\nSet MAILWOMAN_PUBLISH_MODEL to override.`)
	}

	if (!(await tryStat(sourceTokenizer))) {
		throw new Error(`Missing source tokenizer: ${sourceTokenizer}\nSet MAILWOMAN_PUBLISH_TOKENIZER to override.`)
	}

	/**
	 * Weights workspaces to materialize, derived from the release config's locale list.
	 */
	const targets = config.locales.map((locale: string) => `packages/neural-weights-${locale}`)

	for (const workspace of targets) {
		const dir = resolvePath(destRoot, workspace)
		await makeDirectories(dir)
		const modelDest = resolvePath(dir, "model.onnx")
		const tokenizerDest = resolvePath(dir, "tokenizer.model")
		// Unlink first so a pre-existing symlink (from link-dev-weights.ts) is
		// replaced with a real file. Otherwise copyFile follows the symlink and
		// writes through it, leaving the symlink in place — which yarn refuses
		// to publish (npm registry rejects symlinks with HTTP 415).
		await removePathIfPresent(modelDest)
		await removePathIfPresent(tokenizerDest)
		await copyFileTo(sourceModel, modelDest)
		await copyFileTo(sourceTokenizer, tokenizerDest)
		log(`copied weights → ${workspace}/{model.onnx,tokenizer.model}`)

		await materializeSoftFeed(context, workspace, dir)
		await materializeFST(context, workspace, dir)
		await materializeStreetMorphology(context, workspace, dir)
		await materializePairIndex(context, workspace, dir)
	}

	// Char-path bases (#2164): one graph and one sealed vocabulary per script family, no tokenizer, no soft feed.
	for (const [family, recipe] of Object.entries(config.charWeights ?? {})) {
		const workspace = `packages/neural-weights-${family}`
		const dir = resolvePath(destRoot, workspace)

		await makeDirectories(dir)

		for (const [name, source] of [
			["model.onnx", resolvePath(dataRoot, recipe.model)],
			["char-vocab.json", resolvePath(dataRoot, recipe.charVocab)],
		] as const) {
			if (!(await tryStat(source))) {
				throw new Error(`Missing char-path source for ${family}: ${source}`)
			}

			const dest = resolvePath(dir, name)

			await removePathIfPresent(dest)
			await copyFileTo(source, dest)
		}

		log(`copied char weights → ${workspace}/{model.onnx,char-vocab.json}`)
		targets.push(workspace)
	}

	return { skipped: false, workspaces: targets }
}

/**
 * Materialize the per-locale FST gazetteer binary (#1318 FST-distribution arc) into a weights workspace. The source
 * binary lives at $MAILWOMAN_DATA_ROOT/wof/fst-per-locale/fst-<locale>.bin — a verbatim copy (no build step). En-nz has
 * no FST sibling and is skipped silently (byte-stable).
 */
async function materializeFST(context: MaterializationContext, workspace: string, dir: string) {
	const locale = workspace.replace(/^packages\/neural-weights-/, "")
	const src = resolvePath(context.dataRoot, "wof", "fst-per-locale", `fst-${locale}.bin`)

	if (!(await pathExists(src))) {
		context.log(
			`copy-weights: no FST at ${src} — skipping ${workspace}/fst-${locale}.bin (byte-stable; en-nz has none)`
		)

		return
	}

	const dest = resolvePath(dir, `fst-${locale}.bin`)
	await removePathIfPresent(dest)
	await copyFileTo(src, dest)
	context.log(`copied FST → ${workspace}/fst-${locale}.bin`)
}

/**
 * Materialize the locale-GENERAL street-morphology FST (`fst-street-morphology.bin`, the #1315 street-context check's
 * signal source) into a weights workspace — a verbatim copy of the sealed artifact staged by `mailwoman gazetteer build
 * street-morphology` at $MAILWOMAN_DATA_ROOT/wof/. Shipping it as a weights sibling is what carries it to the
 * per-version R2 asset layout the browser demo fetches — the node runtimes can rebuild from the bundled libpostal
 * dictionaries, the browser cannot. A missing source is skipped with a warning (byte-stable: node consumers fall back
 * to the per-process dictionary build; the demo parses without the street-context check, exactly as before).
 */
async function materializeStreetMorphology(context: MaterializationContext, workspace: string, dir: string) {
	const src = resolvePath(context.dataRoot, "wof", "fst-street-morphology.bin")

	if (!(await pathExists(src))) {
		context.log(
			`copy-weights: no street-morphology FST at ${src} — skipping ${workspace}/fst-street-morphology.bin (byte-stable)`
		)

		return
	}

	const dest = resolvePath(dir, "fst-street-morphology.bin")
	await removePathIfPresent(dest)
	await copyFileTo(src, dest)
	context.log(`copied street-morphology FST → ${workspace}/fst-street-morphology.bin`)
}

/**
 * Materialize the #718 D1 soft-feed artifacts into a weights workspace: the gazetteer-anchor lexicon (a verbatim copy)
 *
 * - The per-country PCB1 postcode-anchor binary (built fresh from the WOF extract). Both `removeIfPresent` first — same
 *   symlink-in-tarball trap the model/tokenizer copy guards against.
 */
async function materializeSoftFeed(context: MaterializationContext, workspace: string, dir: string) {
	// Repo-committed lexicons (gazetteer #464, country #1104, street-type Option-A) — verbatim copies,
	// shipped-name → source from the shared recipe reader (weights-recipe.ts owns the base-dir rule).
	for (const [basename, source] of context.repoCommittedSources) {
		if (!(await tryStat(source))) {
			throw new Error(
				`Missing soft-feed lexicon ${basename}: ${source}\nSet the matching softFeed entry in release.config.json.`
			)
		}

		const dest = resolvePath(dir, basename)
		await removePathIfPresent(dest)
		await copyFileTo(source, dest)
		context.log(`copied soft-feed → ${workspace}/${basename}`)
	}

	// The BUILT locality-surface lexicon (~7 MB, data-root, never in git) — the one that breaks its
	// three neighbours' base-directory pattern.
	if (context.sourceLocalitySurface) {
		if (!(await tryStat(context.sourceLocalitySurface))) {
			throw new Error(
				`Missing evidence lexicon: ${context.sourceLocalitySurface}\nSet softFeed.localitySurfaceLexicon in release.config.json.`
			)
		}

		const dest = resolvePath(dir, "locality-surface-lexicon-v7.json")
		await removePathIfPresent(dest)
		await copyFileTo(context.sourceLocalitySurface, dest)
		context.log(`copied soft-feed → ${workspace}/locality-surface-lexicon-v7.json`)
	}

	// PCB1 postcode-anchor binary (#240) — built from the locale's WOF postcode extract. The locale's
	// region subtag (`en-us` → `us`) names both the binary and the postcodeDBByCountry source entry.
	const country = workspace.replace(/^packages\/neural-weights-[a-z]+-/, "")
	const dbRel = context.softFeed.postcodeDBByCountry?.[country]

	if (!dbRel) {
		context.log(
			`soft-feed: no postcodeDBByCountry entry for "${country}" — skipping ${workspace}/postcode-${country}.bin`
		)

		return
	}

	const db = dbRel.startsWith("/") ? dbRel : resolvePath(context.dataRoot, "wof", dbRel)

	if (!(await pathExists(db))) {
		throw new Error(
			`Missing postcode extract for ${country}: ${db}\nSet MAILWOMAN_DATA_ROOT or softFeed.postcodeDBByCountry.`
		)
	}

	const binDest = resolvePath(dir, `postcode-${country}.bin`)

	if (await serveFromDerivedStore(context, dir, `postcode-${country}.bin`)) return

	await removePathIfPresent(binDest)
	// `.release-it.json` runs `yarn compile` before invoking `gazetteer postcode-binary`,
	// so packages/mailwoman/out/cli.js exists. --out is the workspace dir, so the command writes
	// postcode-<cc>.bin directly where the `files` array expects it.
	const cli = resolvePath(context.repoRoot, "packages/mailwoman/out/cli.js")

	const r = spawnProcessSync(
		process.execPath,
		[cli, "gazetteer", "postcode-binary", "--out", dir, "--locale", `${country.toUpperCase()}:${db}`],
		{ stdio: "inherit" }
	)

	if (r.status !== 0) throw new Error(`gazetteer postcode-binary failed for ${country} (exit ${r.status})`)

	if (!(await pathExists(binDest))) throw new Error(`gazetteer postcode-binary ran but ${binDest} was not produced`)
	await stashDerived(context, dir, `postcode-${country}.bin`)
	context.log(`built soft-feed → ${workspace}/postcode-${country}.bin`)
}

/**
 * Materialize the placetype-pair-prior arc's PIX1 index (`pair-index-<cc>.bin`) into a weights workspace — mirrors
 * {@link materializeSoftFeed}'s postcode-binary block exactly, but keyed off `softFeed.pairIndexByCountry` (a CSV
 * source + a required calibrated `--delta`, not a WOF DB) instead of `postcodeDBByCountry`. COUNTRY-SPECIFIC BY DESIGN,
 * same as the runtime resolver (`neural/weights.ts`'s `resolvePairIndexSibling`): a workspace whose country has no
 * `pairIndexByCountry` entry ships no pair-index sibling and is skipped silently (not every locale gets one).
 */
async function materializePairIndex(context: MaterializationContext, workspace: string, dir: string) {
	const country = workspace.replace(/^packages\/neural-weights-[a-z]+-/, "")
	const entry = context.pairIndexByCountry[country]

	if (!entry) {
		return
	}

	// Inputs resolve against DIFFERENT roots, and conflating them is a real failure mode (it broke CI once):
	// `source` and `boroughDB` are large acquired datasets under the data root, while `pairsJsonl` is a curated file
	// CHECKED INTO THE REPO (`data/gazetteer/london-pairs-v2.jsonl`). `resolvePath` lets an absolute entry pass
	// through untouched either way.
	const source = entry.source ? resolvePath(context.dataRoot, entry.source) : undefined
	const boroughDB = entry.boroughDB ? resolvePath(context.dataRoot, entry.boroughDB) : undefined

	// A COMMA-SEPARATED list since R7 (London + NI): resolve each entry, then rejoin.
	const pairsJsonl = entry.pairsJsonl
		? entry.pairsJsonl
				.split(",")
				.map((path) => resolvePath(context.repoRoot, path.trim()))
				.join(",")
		: undefined

	const banDir = entry.banDir ? resolvePath(context.dataRoot, entry.banDir) : undefined

	for (const path of pairsJsonl ? pairsJsonl.split(",") : []) {
		if (!(await pathExists(path))) {
			throw new Error(`Missing pair-index pairs JSONL for ${country}: ${path}`)
		}
	}

	for (const [label, path] of [
		["source CSV", source],
		["borough DB", boroughDB],

		["BAN dir", banDir],
	] as const) {
		if (path && !(await pathExists(path))) {
			throw new Error(
				`Missing pair-index ${label} for ${country}: ${path}\nSet MAILWOMAN_DATA_ROOT or softFeed.pairIndexByCountry.${country}.`
			)
		}
	}

	const binDest = resolvePath(dir, `pair-index-${country}.bin`)

	if (await serveFromDerivedStore(context, dir, `pair-index-${country}.bin`)) return

	await removePathIfPresent(binDest)
	// `.release-it.json` runs `yarn compile` before invoking `gazetteer pair-index`, so
	// packages/mailwoman/out/cli.js exists (same precondition as postcode-binary above).
	const cli = resolvePath(context.repoRoot, "packages/mailwoman/out/cli.js")

	const r = spawnProcessSync(
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
			...(entry.parentDelta !== undefined ? ["--parent-delta", String(entry.parentDelta)] : []),
			...(boroughDB ? ["--borough-db", boroughDB] : []),
			...(pairsJsonl ? ["--pairs-jsonl", pairsJsonl] : []),
			...(banDir ? ["--ban-dir", banDir] : []),
		],
		{ stdio: "inherit" }
	)

	if (r.status !== 0) throw new Error(`gazetteer pair-index failed for ${country} (exit ${r.status})`)

	if (!(await pathExists(binDest))) throw new Error(`gazetteer pair-index ran but ${binDest} was not produced`)
	await stashDerived(context, dir, `pair-index-${country}.bin`)
	context.log(`built soft-feed → ${workspace}/pair-index-${country}.bin (delta=${entry.delta})`)
}
