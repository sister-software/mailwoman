/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, tryStat } from "@mailwoman/core/fs/readers"
import { copyFileTo, makeDirectories, removePathIfPresent } from "@mailwoman/core/fs/writers"
import { spawnProcessSync } from "@mailwoman/core/process"
import {
	type PairIndexInputs,
	readReleaseConfig,
	repoCommittedSoftFeedSources,
	type SoftFeedRecipe,
} from "@mailwoman/core/release-config"
import { wofDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import { resolvePath } from "path-ts"

import { $public } from "#env/index"
import { derivedStoreServeViolation, derivedWeightsDir, derivedWeightsKey } from "#weights/derived-weights-key"

/**
 * Options for {@linkcode copyWeights}.
 */
export interface CopyWeightsOptions {
	/**
	 * The checkout whose `release.config.json` and committed files supply the sources.
	 * Data-root sources come from the configured data root.
	 */
	repoRoot: string

	/**
	 * The directory that receives the weights workspaces, such as a preflight staging tree.
	 *
	 * It defaults to `repoRoot` and changes only the destinations.
	 */
	destRoot?: string
	log: (line: string) => void
}

/**
 * The weights workspaces that {@linkcode copyWeights} materialized.
 *
 * `skipped` is true when `MAILWOMAN_SKIP_WEIGHTS_COPY` is set.
 */
export interface CopyWeightsReport {
	skipped: boolean
	workspaces: string[]
}

interface MaterializationContext {
	repoRoot: string
	dataRoot: string

	derivedStore: string
	softFeed: SoftFeedRecipe

	repoCommittedSources: Map<string, string>
	sourceLocalitySurface: string | null

	pairIndexByCountry: Record<string, PairIndexInputs>
	log: (line: string) => void
}

async function serveFromDerivedStore(context: MaterializationContext, dir: string, filename: string): Promise<boolean> {
	const cached = resolvePath(context.derivedStore, filename)

	if (!(await pathExists(cached))) return false

	const violation = await derivedStoreServeViolation(filename, cached)

	if (violation) {
		context.log(`derived store POISONED entry evicted → ${filename}: ${violation}`)
		await removePathIfPresent(cached)

		return false
	}

	const dest = resolvePath(dir, filename)

	await removePathIfPresent(dest)

	await copyFileTo(cached, dest)
	context.log(`derived store HIT → ${filename}`)

	return true
}

async function stashDerived(context: MaterializationContext, dir: string, filename: string): Promise<void> {
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
 * Copies or builds the binaries and evidence artifacts of every weights workspace under `destRoot`.
 */
export async function copyWeights({
	repoRoot,
	destRoot = repoRoot,
	log,
}: CopyWeightsOptions): Promise<CopyWeightsReport> {
	if ($public.MAILWOMAN_SKIP_WEIGHTS_COPY) {
		log("copy-weights: MAILWOMAN_SKIP_WEIGHTS_COPY set — skipping.")

		return { skipped: true, workspaces: [] }
	}

	const config = await readReleaseConfig(repoRoot)
	const dataRoot = dataRootPath().toString()
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

	const sourceModel = $public.MAILWOMAN_PUBLISH_MODEL ?? resolvePath(dataRoot, config.weights.model)

	const sourceTokenizer = $public.MAILWOMAN_PUBLISH_TOKENIZER ?? resolvePath(dataRoot, config.weights.tokenizer)

	if (!(await tryStat(sourceModel))) {
		throw new Error(`Missing source model: ${sourceModel}\nSet MAILWOMAN_PUBLISH_MODEL to override.`)
	}

	if (!(await tryStat(sourceTokenizer))) {
		throw new Error(`Missing source tokenizer: ${sourceTokenizer}\nSet MAILWOMAN_PUBLISH_TOKENIZER to override.`)
	}

	const targets = config.locales.map((locale: string) => `packages/neural-weights-${locale}`)

	for (const workspace of targets) {
		const dir = resolvePath(destRoot, workspace)
		await makeDirectories(dir)
		const modelDest = resolvePath(dir, "model.onnx")
		const tokenizerDest = resolvePath(dir, "tokenizer.model")

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

		for (const overlay of recipe.overlays ?? []) {
			const overlayWorkspace = `packages/neural-weights-${overlay}`
			const overlayDir = resolvePath(destRoot, overlayWorkspace)

			await makeDirectories(overlayDir)
			await materializeFST(context, overlayWorkspace, overlayDir)
			targets.push(overlayWorkspace)
		}
	}

	return { skipped: false, workspaces: targets }
}

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

async function materializeSoftFeed(context: MaterializationContext, workspace: string, dir: string) {
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

	const country = workspace.replace(/^packages\/neural-weights-[a-z]+-/, "")
	const dbRel = context.softFeed.postcodeDBByCountry?.[country]

	if (!dbRel) {
		context.log(
			`soft-feed: no postcodeDBByCountry entry for "${country}" — skipping ${workspace}/postcode-${country}.bin`
		)

		return
	}

	const db = dbRel.startsWith("/") ? dbRel : wofDatabaseRoot(context.dataRoot)(dbRel)

	if (!(await pathExists(db))) {
		throw new Error(
			`Missing postcode extract for ${country}: ${db}\nSet MAILWOMAN_DATA_ROOT or softFeed.postcodeDBByCountry.`
		)
	}

	const binDest = resolvePath(dir, `postcode-${country}.bin`)

	if (await serveFromDerivedStore(context, dir, `postcode-${country}.bin`)) return

	await removePathIfPresent(binDest)

	const cli = resolvePath(context.repoRoot, "packages/mailwoman/out/cli/index.js")

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

async function materializePairIndex(context: MaterializationContext, workspace: string, dir: string) {
	const country = workspace.replace(/^packages\/neural-weights-[a-z]+-/, "")
	const entry = context.pairIndexByCountry[country]

	if (!entry) {
		return
	}

	const source = entry.source ? resolvePath(context.dataRoot, entry.source) : undefined

	const boroughDB = entry.boroughDB ? resolvePath(wofDatabaseRoot(context.dataRoot), entry.boroughDB) : undefined

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

	const cli = resolvePath(context.repoRoot, "packages/mailwoman/out/cli/index.js")

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
