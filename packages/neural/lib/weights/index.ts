/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Resolve neural weight-package artifacts.
 *
 * Weights packages ship `model.onnx` + `tokenizer.model` next to `package.json`.
 * In dev, package dirs can be metadata-only, so callers can use explicit paths
 * or link local binaries into the weights package.
 */

import { cacheRootPathBuilder, databaseRootPath, dataRootPath, weightsOverlayPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { resolvePackageDirectory, tryResolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { basename, dirname, PathBuilder, type PathBuilderLike, resolvePath, resolvePathBuilder } from "path-ts"

import { scriptFamilyBase } from "#char-encoder"
import { PlacetypeCensusResolver } from "#placetype/census"
import {
	type EncoderDescriptor,
	packageHasBinaries,
	readEncoderFromModelCard,
	resolveCharVocab,
} from "#weights/channels"
import { resolveEvidenceLexicon } from "#weights/lexicon"

/**
 * User-level cache root used by `mailwoman parse --download-weights`.
 */
export const weightsCacheDir = cacheRootPathBuilder("weights")

/**
 * Data-root overlay root: `$MAILWOMAN_DATA_ROOT/weights`.
 */
export function weightsOverlayRoot(): PathBuilder {
	return dataRootPath("weights")
}

/**
 * Overlay directory for one locale.
 */
export function weightsOverlayDir(locale: Intl.UnicodeBCP47LocaleIdentifier): PathBuilder {
	return weightsOverlayPath(locale)
}

/**
 * The weights package for a locale tag, normalized to the all-lowercase BCP-47 package convention.
 */
export function weightsPackageName(locale?: Intl.UnicodeBCP47LocaleIdentifier): string {
	return `@mailwoman/neural-weights-${(locale ?? "en-us").toLowerCase()}`
}

/**
 * Build `<cacheRoot>/node_modules/@mailwoman/neural-weights-<locale>`.
 *
 * This helper defines the npm `--prefix` cache layout in one place
 * and does not existence-check the directory.
 */
export function weightsCachePackageDir(cacheRoot: PathBuilderLike, locale?: string): PathBuilder {
	const normalized = PathBuilder.from(cacheRoot)

	return normalized("node_modules", weightsPackageName(locale))
}

export interface ResolveWeightsOpts {
	/**
	 * Locale tag used to pick the weights package.
	 */
	locale?: string
	/**
	 * Explicit `model.onnx` path.
	 */
	modelPath?: PathBuilderLike
	/**
	 * Explicit `tokenizer.model` path.
	 */
	tokenizerPath?: PathBuilderLike
	/**
	 * Explicit `char-vocab.json` for char-encoder models.
	 */
	charVocabPath?: PathBuilderLike
	/**
	 * Explicit `model-card.json` path for explicit model/tokenizer runs.
	 * Falls back to a card beside `modelPath`.
	 */
	modelCardPath?: PathBuilderLike
	/**
	 * Base package `model-card.json` when using `mailwoman.baseWeights`.
	 */
	baseModelCardPath?: string
	/**
	 * Serving tier: `server` (default) or `pocket` (anchor-only).
	 */
	tier?: "server" | "pocket"
	/**
	 * Optional override for the probed weights cache root.
	 */
	cacheRoot?: PathBuilderLike | null
	/**
	 * Optional override for the probed data-root overlay root.
	 */
	overlayRoot?: string
}

/**
 * Source directory class for a resolved artifact.
 */
export const WeightsOrigin = {
	/**
	 * A path the caller supplied outright.
	 */
	Explicit: "explicit",
	/**
	 * The resolved weights package's own directory.
	 */
	Package: "package",
	/**
	 * Base package reached through `mailwoman.baseWeights`.
	 */
	Base: "base",
	/**
	 * The data-root overlay ({@link weightsOverlayRoot}).
	 * A dev checkout whose package carries no binaries.
	 */
	Overlay: "overlay",
	/**
	 * The user-level weights cache written by `mailwoman parse --download-weights`.
	 */
	Cache: "cache",
} as const

export type WeightsOrigin = (typeof WeightsOrigin)[keyof typeof WeightsOrigin]

/**
 * One artifact's resolution result.
 */
export interface WeightsArtifactReport {
	name: string
	path: PathBuilderLike | null
	origin: WeightsOrigin | null
}

export interface ResolvedWeights {
	modelPath: string
	/**
	 * SentencePiece model path.
	 * For char encoders, use `charVocabPath` instead.
	 */
	tokenizerPath: string
	encoder: EncoderDescriptor
	charVocabPath?: string
	/**
	 * Resolved `model-card.json` path, if present.
	 */
	modelCardPath?: string
	/**
	 * Base package `model-card.json` path, if present and distinct.
	 */
	baseModelCardPath?: string
	/**
	 * Path to `crf-transitions.json` alongside the resolved model.
	 *
	 * `undefined` when the file doesn't exist (pre-v0.6.0 bundles or CE-only training).
	 */
	crfTransitionsPath?: string
	/**
	 * Path to `semi-crf-transitions.json`, if present.
	 */
	semiCRFTransitionsPath?: string
	/**
	 * Postcode→anchor source path and format hint.
	 */
	anchorLookupPath?: { path: string; binary: boolean }
	/**
	 * Gazetteer-anchor lexicon path, if enabled and present.
	 */
	gazetteerLexiconPath?: string
	/**
	 * Country-surface lexicon path, if enabled and present.
	 */
	countryLexiconPath?: string
	/**
	 * Street-type evidence lexicon path, if enabled and present.
	 */
	streetTypeLexiconPath?: string
	/**
	 * Locality-surface evidence lexicon path, if enabled and present.
	 */
	localitySurfaceLexiconPath?: string
	/**
	 * Per-locale gazetteer FST path, if present.
	 */
	fstPath?: string
	/**
	 * Street-morphology FST path, with base fallback.
	 */
	streetMorphologyPath?: string
	/**
	 * Country-specific placetype-pair index path, if present.
	 */
	pairIndexPath?: string
	/**
	 * Resolution source label.
	 */
	source: string
	/**
	 * Package directory used for sibling artifact resolution.
	 */
	packageDir?: PathBuilder
	/**
	 * Fixed report of all known artifacts and their origins.
	 */
	artifacts: WeightsArtifactReport[]
}

/**
 * Classify a resolved artifact by parent directory match.
 */
function originOf(
	path: PathBuilderLike | null | undefined,
	dirs: Partial<Record<WeightsOrigin, PathBuilderLike | undefined | null>>
): WeightsOrigin | null {
	if (!path) return null

	// Compare runtime-normalized parent directories.
	const parent: string = resolvePath(dirname(path))

	for (const [origin, dir] of Object.entries(dirs)) {
		const candidate: string = resolvePath(dir ?? "")

		if (dir && candidate === parent) {
			return origin as WeightsOrigin
		}
	}

	// Unknown origin.
	return null
}

/**
 * Build an artifact report from resolved paths.
 */
function buildArtifactReport(
	entries: ReadonlyArray<readonly [name: string, path: PathBuilderLike | null | undefined]>,
	dirs: Partial<Record<WeightsOrigin, PathBuilderLike | null | undefined>>
): WeightsArtifactReport[] {
	return entries.map(([name, path]) => ({ name, path: path ?? null, origin: originOf(path, dirs) }))
}

/**
 * {@link ResolveWeightsOpts} with the explicit paths in the string form {@link ResolvedWeights} reports.
 */
type ExplicitPathOpts = Omit<ResolveWeightsOpts, "modelPath" | "tokenizerPath" | "charVocabPath" | "modelCardPath"> & {
	modelPath?: string
	tokenizerPath?: string
	charVocabPath?: string
	modelCardPath?: string
}

export async function resolveWeights(input: ResolveWeightsOpts): Promise<ResolvedWeights> {
	const opts: ExplicitPathOpts = {
		...input,
		modelPath: input.modelPath?.toString(),
		tokenizerPath: input.tokenizerPath?.toString(),
		charVocabPath: input.charVocabPath?.toString(),
		modelCardPath: input.modelCardPath?.toString(),
	}

	const tried: PathBuilder[] = []

	if (opts.modelPath && (opts.tokenizerPath || opts.charVocabPath)) {
		if (!(await pathExists(opts.modelPath))) {
			throw new Error(`Explicit modelPath does not exist: ${opts.modelPath}`)
		}

		if (opts.tokenizerPath && !(await pathExists(opts.tokenizerPath))) {
			throw new Error(`Explicit tokenizerPath does not exist: ${opts.tokenizerPath}`)
		}

		if (opts.charVocabPath && !(await pathExists(opts.charVocabPath))) {
			throw new Error(`Explicit charVocabPath does not exist: ${opts.charVocabPath}`)
		}

		// Prefer explicit model card, then a co-located card.
		const coLocatedCard = resolvePath(dirname(opts.modelPath), "model-card.json")
		const modelCardPath = opts.modelCardPath ?? ((await pathExists(coLocatedCard)) ? coLocatedCard : undefined)
		const encoder = await readEncoderFromModelCard(modelCardPath)

		if (encoder.kind === "char" ? !opts.charVocabPath : !opts.tokenizerPath) {
			throw new Error(
				`The card at ${modelCardPath ?? "(none)"} ${encoder.kind === "char" ? "declares a char encoder; pass charVocabPath" : "declares no char encoder; pass tokenizerPath"} beside modelPath`
			)
		}

		return {
			modelPath: opts.modelPath,
			tokenizerPath: opts.tokenizerPath ?? resolvePath(dirname(opts.modelPath), "tokenizer.model"),
			encoder,
			...(opts.charVocabPath ? { charVocabPath: opts.charVocabPath } : {}),
			modelCardPath,
			source: "explicit",
			artifacts: buildArtifactReport(
				[
					["model.onnx", opts.modelPath],
					encoder.kind === "char" ? ["char-vocab.json", opts.charVocabPath] : ["tokenizer.model", opts.tokenizerPath],
					["model-card.json", modelCardPath],
				],
				{
					[WeightsOrigin.Explicit]: dirname(opts.modelPath),
					...(modelCardPath ? { [WeightsOrigin.Package]: dirname(modelCardPath) } : {}),
				}
			),
		}
	}

	// Package names use lowercase BCP-47 tags.
	const locale = (opts.locale ?? "en-us").toLowerCase()
	const packageName = weightsPackageName(locale)

	const cacheDir = weightsCachePackageDir(opts.cacheRoot ?? weightsCacheDir(), locale)

	const cacheHasBinaries = async () => packageHasBinaries(cacheDir)

	// 0. Explicit cacheRoot is authoritative and never falls back.
	if (opts.cacheRoot) {
		// Missing package install in explicit cache gets a specific error.
		if (!(await pathExists(cacheDir))) {
			tried.push(cacheDir)

			throw new Error(
				`Could not resolve ${packageName} from the explicit weights cache.\n` +
					`The cache carries no ${packageName} install at ${cacheDir}, and an explicit cache is an ` +
					`isolation boundary — resolution never falls back to installed or workspace packages.\n` +
					`Install into the cache (npm --prefix layout, e.g. \`mailwoman parse --download-weights\`), ` +
					`or drop the explicit cache root.`
			)
		}

		return await resolveFromPackageDir(cacheDir, locale, opts, `cache:${packageName}`, tried)
	}

	// 1. Installed package (workspace or node_modules).
	let emptyPackageDir: PathBuilder | undefined

	try {
		return await resolveFromPackageDir(
			resolvePackageDirectory(packageName),
			locale,
			opts,
			`package:${packageName}`,
			tried
		)
	} catch (error) {
		// Empty-but-resolvable package falls through to overlay/cache probes.
		if (error instanceof Error && error.message.includes("missing model files")) {
			emptyPackageDir = resolvePackageDirectory(packageName)
		}
	}

	// 2. Data-root overlay.
	const overlayDir = opts.overlayRoot
		? PathBuilder.from(resolvePath(opts.overlayRoot, locale))
		: weightsOverlayDir(locale)

	// Probe overlays by directory existence.
	// The base fallback is handled downstream.
	if (await pathExists(overlayDir)) {
		try {
			return await resolveFromPackageDir(overlayDir, locale, opts, `overlay:${locale}`, tried)
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("missing model files")) throw error
		}
	}

	// 3. User-level weights cache (requires binaries).
	if (await cacheHasBinaries()) {
		return await resolveFromPackageDir(cacheDir, locale, opts, `cache:${packageName}`, tried)
	}

	// CJK locales can fall back to script-family base locales.
	const familyBase = scriptFamilyBase(locale)

	if (familyBase && familyBase !== locale) {
		const resolved = await resolveWeights({ ...opts, locale: familyBase })

		return { ...resolved, source: `${resolved.source} (script-family base for ${locale})` }
	}

	throw new Error(
		`Could not resolve ${packageName}.\n` +
			(emptyPackageDir
				? `The package IS installed at ${emptyPackageDir} but ships no model.onnx/tokenizer.model — the ` +
					"ordinary state of a dev checkout, where the binaries are not in git.\n"
				: `Install it via: npm install ${packageName}\n`) +
			`Also probed the data-root overlay: ${overlayDir}\n` +
			`Also probed the weights cache: ${cacheDir}\n` +
			`Or run \`mailwoman parse --download-weights\`, or pass --model + --tokenizer with explicit paths.`
	)
}

/**
 * Resolve all known artifacts from a weights package directory.
 *
 * @throws When the model files themselves are missing.
 */
async function resolveFromPackageDir(
	packageDir: PathBuilder,
	locale: Intl.UnicodeBCP47LocaleIdentifier,
	opts: ExplicitPathOpts,
	source: string,
	tried: PathBuilderLike[]
): Promise<ResolvedWeights> {
	let modelPath = opts.modelPath ?? resolvePath(packageDir, "model.onnx")
	let tokenizerPath = opts.tokenizerPath ?? resolvePath(packageDir, "tokenizer.model")

	// Base-overlay dedup: allow overlay packages to reuse base model/tokenizer.
	const baseDir = await resolveBaseWeightsDir(packageDir, locale, opts.cacheRoot !== undefined)

	if (!opts.modelPath) {
		const baseModel = baseDir ? resolvePath(baseDir, "model.onnx") : undefined

		if (baseDir && baseModel && (await pathExists(baseModel))) {
			modelPath = baseModel

			if (!opts.tokenizerPath) {
				tokenizerPath = resolvePath(baseDir, "tokenizer.model")
			}

			source = `${source}+base`
		}
	}

	const modelCardCandidate = resolvePath(packageDir, "model-card.json")
	const baseModelCardCandidate = baseDir ? resolvePath(baseDir, "model-card.json") : undefined

	// The card determines tokenizer vs char-vocab expectations.
	const encoder = await readEncoderFromModelCard(
		(await pathExists(modelCardCandidate)) ? modelCardCandidate : baseModelCardCandidate
	)

	const charVocabPath =
		encoder.kind === "char" ? await resolveCharVocab(packageDir, baseDir ?? undefined, encoder.charVocab) : undefined

	tried.push(modelPath, charVocabPath ?? tokenizerPath)

	if (!(await pathExists(modelPath)) || !(await pathExists(charVocabPath ?? tokenizerPath))) {
		throw new Error(
			`Weights package resolved at ${packageDir} but is missing model files.\n` +
				`Tried:\n  ${tried.join("\n  ")}\n` +
				`Run the package's own \`link-dev-weights.ts\` to symlink dev weights, ` +
				`or pass --model + --tokenizer (or --char-vocab) with explicit paths.`
		)
	}

	// Fallback to base model-card when overlay has none.
	const modelCardPath = (await pathExists(modelCardCandidate))
		? modelCardCandidate
		: baseModelCardCandidate && (await pathExists(baseModelCardCandidate))
			? baseModelCardCandidate
			: undefined

	if (!(await pathExists(modelCardCandidate)) && modelCardPath && !source.endsWith("+base")) {
		source = `${source}+base`
	}

	// Keep base card separately for model-field fallback use.
	const resolvedBaseModelCardPath =
		baseModelCardCandidate && (await pathExists(baseModelCardCandidate)) && baseModelCardCandidate !== modelCardPath
			? baseModelCardCandidate
			: undefined

	const crfCandidate = resolvePath(packageDir, "crf-transitions.json")
	const crfTransitionsPath = (await pathExists(crfCandidate)) ? crfCandidate : undefined

	const semiCrfCandidate = resolvePath(packageDir, "semi-crf-transitions.json")
	const semiCRFTransitionsPath = (await pathExists(semiCrfCandidate)) ? semiCrfCandidate : undefined

	// Soft-feature siblings.
	const country = locale.split("-")[1] ?? ""
	const anchorLookupPath = await resolveAnchorLookupSibling(packageDir, country)
	// Pocket tier is anchor-only.
	const gazetteerCandidate = resolvePath(packageDir, "anchor-lexicon-v1.json")

	const gazetteerLexiconPath =
		opts.tier === "pocket" ? undefined : (await pathExists(gazetteerCandidate)) ? gazetteerCandidate : undefined

	// Country lexicon sibling.
	const countryCandidate = resolvePath(packageDir, "country-surface-lexicon-v1.json")

	const countryLexiconPath =
		opts.tier === "pocket" ? undefined : (await pathExists(countryCandidate)) ? countryCandidate : undefined

	// Evidence-bundle lexicon siblings (server tier).
	const streetTypeLexiconPath =
		opts.tier === "pocket" ? undefined : await resolveEvidenceLexicon("street_type", packageDir, modelCardPath)

	const localitySurfaceLexiconPath =
		opts.tier === "pocket" ? undefined : await resolveEvidenceLexicon("locality_surface", packageDir, modelCardPath)

	// Placetype-pair index sibling (local-only, no base fallback).
	const pairIndexPath = await resolvePairIndexSibling(packageDir, country)

	// Per-locale FST gazetteer sibling.
	const fstCandidate = resolvePath(packageDir, `fst-${locale}.bin`)
	const fstPath = (await pathExists(fstCandidate)) ? fstCandidate : undefined

	// Street-morphology FST sibling with base fallback.
	const morphologyCandidate = resolvePath(packageDir, "fst-street-morphology.bin")
	const baseMorphologyCandidate = baseDir ? resolvePath(baseDir, "fst-street-morphology.bin") : undefined

	const streetMorphologyPath = (await pathExists(morphologyCandidate))
		? morphologyCandidate
		: baseMorphologyCandidate && (await pathExists(baseMorphologyCandidate))
			? baseMorphologyCandidate
			: undefined

	// Infer artifact origin from the source rung.
	const rungOrigin: WeightsOrigin = source.startsWith("overlay")
		? WeightsOrigin.Overlay
		: source.startsWith("cache")
			? WeightsOrigin.Cache
			: WeightsOrigin.Package

	const artifacts = buildArtifactReport(
		[
			["model.onnx", modelPath],
			encoder.kind === "char" ? ["char-vocab.json", charVocabPath] : ["tokenizer.model", tokenizerPath],
			["model-card.json", modelCardPath],
			["crf-transitions.json", crfTransitionsPath],
			["semi-crf-transitions.json", semiCRFTransitionsPath],
			[anchorLookupPath ? basename(anchorLookupPath.path) : `postcode-${country}.bin`, anchorLookupPath?.path],
			["anchor-lexicon-v1.json", gazetteerLexiconPath],
			["country-surface-lexicon-v1.json", countryLexiconPath],
			[streetTypeLexiconPath ? basename(streetTypeLexiconPath) : "street-type-lexicon.json", streetTypeLexiconPath],
			[
				localitySurfaceLexiconPath ? basename(localitySurfaceLexiconPath) : "locality-surface-lexicon.json",
				localitySurfaceLexiconPath,
			],
			[`pair-index-${country}.bin`, pairIndexPath],
			[`fst-${locale}.bin`, fstPath],
			["fst-street-morphology.bin", streetMorphologyPath],
		],
		{ [rungOrigin]: packageDir, [WeightsOrigin.Base]: baseDir }
	)

	return {
		modelPath,
		tokenizerPath,
		encoder,
		...(charVocabPath ? { charVocabPath } : {}),
		modelCardPath,
		packageDir,
		artifacts,
		...(resolvedBaseModelCardPath ? { baseModelCardPath: resolvedBaseModelCardPath } : {}),
		crfTransitionsPath,
		...(semiCRFTransitionsPath ? { semiCRFTransitionsPath } : {}),
		...(anchorLookupPath ? { anchorLookupPath } : {}),
		...(gazetteerLexiconPath ? { gazetteerLexiconPath } : {}),
		...(countryLexiconPath ? { countryLexiconPath } : {}),
		...(pairIndexPath ? { pairIndexPath } : {}),
		...(fstPath ? { fstPath } : {}),
		...(streetMorphologyPath ? { streetMorphologyPath } : {}),
		...(streetTypeLexiconPath ? { streetTypeLexiconPath } : {}),
		...(localitySurfaceLexiconPath ? { localitySurfaceLexiconPath } : {}),
		source,
	}
}

/**
 * Resolve postcode→anchor source, preferring PCB1 binary over JSON.
 *
 * @returns Path + binary flag, or `undefined` when absent.
 */
async function resolveAnchorLookupSibling(
	packageDir: PathBuilderLike,
	country: string
): Promise<{ path: string; binary: boolean } | undefined> {
	if (country) {
		const binary = resolvePath(packageDir, `postcode-${country}.bin`)

		if (await pathExists(binary)) return { path: binary, binary: true }
	}

	const json = resolvePath(packageDir, "anchor-lookup.json")

	if (await pathExists(json)) return { path: json, binary: false }

	return undefined
}

/**
 * Resolve country-specific `pair-index-<cc>.bin` from `packageDir` only.
 */
async function resolvePairIndexSibling(packageDir: PathBuilder, country: string): Promise<string | null> {
	if (!country) return null

	const candidate = resolvePath(packageDir, `pair-index-${country}.bin`)

	return (await pathExists(candidate)) ? candidate : null
}

/**
 * Resolve build-local placetype census (`placetype-census-<cc>.bin`) from data root.
 * Returns `null` when absent.
 */
export async function resolvePlacetypeCensusPath(country: string): Promise<PathBuilder | null> {
	if (!country) return null

	const candidate = databaseRootPath(dataRootPath())("wof", `placetype-census-${country.toLowerCase()}.bin`)

	return (await pathExists(candidate)) ? candidate : null
}

/**
 * Load placetype census for `country`.
 * Returns `null` when absent or invalid.
 */
export async function loadPlacetypeCensus(
	country: string,
	explicitPath?: PathBuilderLike
): Promise<PlacetypeCensusResolver | null> {
	const path = explicitPath ?? (await resolvePlacetypeCensusPath(country))

	if (!path) return null

	try {
		const census = new PlacetypeCensusResolver(new Uint8Array(await readLocalBuffer(path)))

		if (census.country === country) return census

		console.warn(
			`[mailwoman/neural] placetype-census country "${census.country}" (${path}) does not match the resolved ` +
				`locale's country "${country}" — skipping the census observability probe.`
		)
	} catch (error) {
		console.error(`[mailwoman/neural] failed to parse ${path}: ${(error as Error).message}`)
	}

	return null
}

/**
 * Resolve a locale package's `mailwoman.baseWeights` directory, if any.
 */
async function resolveBaseWeightsDir(
	packageDir: PathBuilderLike,
	locale?: Intl.UnicodeBCP47LocaleIdentifier,
	cacheRootIsExplicit = false
): Promise<PathBuilder | null> {
	try {
		// Overlays have no package.json, so read declaration from workspace package.
		const declarationDir = (await pathExists(resolvePath(packageDir, "package.json")))
			? packageDir
			: locale
				? tryResolvePackageDirectory(weightsPackageName(locale))
				: undefined

		if (!declarationDir) return null

		const { mailwoman } = await readPackageJSON(resolvePath(declarationDir, "package.json"))
		const base = mailwoman?.baseWeights

		if (typeof base !== "string" || !base) return null

		// Prefer cache-local sibling base package before global resolution.
		const siblingBaseDir = resolvePathBuilder(dirname(packageDir), base.split("/").at(-1)!)

		if (await pathExists(resolvePath(siblingBaseDir, "package.json"))) return siblingBaseDir

		if (cacheRootIsExplicit) return null

		const basePackageDir = tryResolvePackageDirectory(base)

		// If resolving from overlay, prefer base overlay with linked binaries.
		const baseLocale = base.replace("@mailwoman/neural-weights-", "")
		const baseOverlay = weightsOverlayDir(baseLocale)

		if (packageDir !== declarationDir && (await pathExists(resolvePath(baseOverlay, "model.onnx")))) return baseOverlay

		return basePackageDir
	} catch {
		return null
	}
}
