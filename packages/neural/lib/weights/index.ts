/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
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
 * Returns the npm `--prefix` install directory of a locale's weights package under
 * `cacheRoot`, without checking that it exists.
 */
export function weightsCachePackageDir(cacheRoot: PathBuilderLike, locale?: string): PathBuilder {
	const normalized = PathBuilder.from(cacheRoot)

	return normalized("node_modules", weightsPackageName(locale))
}

/**
 * Options for {@link resolveWeights}.
 *
 * Passing `cacheRoot` confines resolution to that cache, and passing `modelPath` with
 * a tokenizer or char vocabulary bypasses package lookup entirely.
 */
export interface ResolveWeightsOpts {
	/**
	 * The locale tag that selects the weights package, defaulting to `en-us`.
	 */
	locale?: string

	/**
	 * An explicit `model.onnx` path.
	 */
	modelPath?: PathBuilderLike

	/**
	 * An explicit `tokenizer.model` path.
	 */
	tokenizerPath?: PathBuilderLike

	/**
	 * An explicit `char-vocab.json` path for char-encoder models.
	 */
	charVocabPath?: PathBuilderLike

	/**
	 * An explicit `model-card.json` path for an explicit-path run, falling back to a card beside `modelPath`.
	 */
	modelCardPath?: PathBuilderLike

	/**
	 * Not read by {@link resolveWeights}, which finds the base card through the
	 * package's `mailwoman.baseWeights` declaration.
	 */
	baseModelCardPath?: string

	/**
	 * The serving tier, where `pocket` omits every lexicon and keeps only the
	 * postcode anchor; defaults to `server`.
	 */
	tier?: "server" | "pocket"

	/**
	 * A weights cache root that, when set, confines resolution to that cache
	 * and throws if the locale's package is not installed there.
	 */
	cacheRoot?: PathBuilderLike | null

	/**
	 * The data-root overlay directory to probe instead of the default one.
	 */
	overlayRoot?: PathBuilderLike
}

/**
 * Names the kind of directory a resolved weights artifact came from,
 * as reported in {@link WeightsArtifactReport}.
 */
export const WeightsOrigin = {
	Explicit: "explicit",

	Package: "package",

	Base: "base",

	Overlay: "overlay",

	Cache: "cache",
} as const

/**
 * Names the kind of directory a resolved weights artifact came from,
 * as reported in {@link WeightsArtifactReport}.
 */
export type WeightsOrigin = (typeof WeightsOrigin)[keyof typeof WeightsOrigin]

/**
 * One artifact's resolution result.
 */
export interface WeightsArtifactReport {
	name: string
	path: PathBuilderLike | null
	origin: WeightsOrigin | null
}

/**
 * Describes the weights files that {@link resolveWeights} located, with `source` naming
 * the rung that supplied them and `artifacts` recording each file's origin.
 */
export interface ResolvedWeights {
	modelPath: string

	/**
	 * The SentencePiece model path, which a char-encoder model does not use; read `charVocabPath` instead.
	 */
	tokenizerPath: string
	encoder: EncoderDescriptor
	charVocabPath?: string

	/**
	 * The resolved `model-card.json`, which may come from the base package when the locale package has none.
	 */
	modelCardPath?: string

	/**
	 * The base package's `model-card.json`, present only when it exists and differs from `modelCardPath`.
	 */
	baseModelCardPath?: string

	/**
	 * The `crf-transitions.json` beside the model, or `undefined` for a bundle trained without a CRF.
	 */
	crfTransitionsPath?: string

	/**
	 * The `semi-crf-transitions.json` beside the model, when present.
	 */
	semiCRFTransitionsPath?: string

	/**
	 * The postcode-to-anchor source, where `binary` marks a `postcode-<cc>.bin`
	 * rather than an `anchor-lookup.json`.
	 */
	anchorLookupPath?: { path: string; binary: boolean }

	/**
	 * The gazetteer-anchor lexicon, present when it exists and the tier is not `pocket`.
	 */
	gazetteerLexiconPath?: string

	/**
	 * The country-surface lexicon, present when it exists and the tier is not `pocket`.
	 */
	countryLexiconPath?: string

	/**
	 * The street-type evidence lexicon, present when it exists and the tier is not `pocket`.
	 */
	streetTypeLexiconPath?: string

	/**
	 * The locality-surface evidence lexicon, present when it exists and the tier is not `pocket`.
	 */
	localitySurfaceLexiconPath?: string

	/**
	 * The per-locale gazetteer FST, when present.
	 */
	fstPath?: string

	/**
	 * The street-morphology FST from the package, falling back to the base package.
	 */
	streetMorphologyPath?: string

	/**
	 * The placetype-pair index for the locale's country, when present.
	 */
	pairIndexPath?: string

	/**
	 * The resolution rung that supplied the weights, such as `package:…`, `overlay:…`,
	 * `cache:…` or `explicit`, with `+base` appended when a base package filled in.
	 */
	source: string

	/**
	 * The package directory that sibling artifacts were resolved against; absent for explicit paths.
	 */
	packageDir?: PathBuilder

	/**
	 * Each probed artifact with its resolved path and origin, including the ones not found.
	 */
	artifacts: WeightsArtifactReport[]
}

function originOf(
	path: PathBuilderLike | null | undefined,
	dirs: Partial<Record<WeightsOrigin, PathBuilderLike | undefined | null>>
): WeightsOrigin | null {
	if (!path) return null

	const parent: string = resolvePath(dirname(path))

	for (const [origin, dir] of Object.entries(dirs)) {
		const candidate: string = resolvePath(dir ?? "")

		if (dir && candidate === parent) {
			return origin as WeightsOrigin
		}
	}

	return null
}

function buildArtifactReport(
	entries: ReadonlyArray<readonly [name: string, path: PathBuilderLike | null | undefined]>,
	dirs: Partial<Record<WeightsOrigin, PathBuilderLike | null | undefined>>
): WeightsArtifactReport[] {
	return entries.map(([name, path]) => ({ name, path: path ?? null, origin: originOf(path, dirs) }))
}

type ExplicitPathOpts = Omit<ResolveWeightsOpts, "modelPath" | "tokenizerPath" | "charVocabPath" | "modelCardPath"> & {
	modelPath?: string
	tokenizerPath?: string
	charVocabPath?: string
	modelCardPath?: string
}

/**
 * Locates the model, tokenizer and companion artifacts for a locale.
 *
 * It tries explicit paths, then the installed package, the data-root overlay,
 * the download cache and finally the locale's script-family base, and it throws with
 * every probed location when none has the model binaries.
 */
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

	const locale = (opts.locale ?? "en-us").toLowerCase()
	const packageName = weightsPackageName(locale)

	const cacheDir = weightsCachePackageDir(opts.cacheRoot ?? weightsCacheDir(), locale)

	const cacheHasBinaries = async () => packageHasBinaries(cacheDir)

	if (opts.cacheRoot) {
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
		if (error instanceof Error && error.message.includes("missing model files")) {
			emptyPackageDir = resolvePackageDirectory(packageName)
		}
	}

	const overlayDir = opts.overlayRoot ? resolvePathBuilder(opts.overlayRoot, locale) : weightsOverlayDir(locale)

	if (await pathExists(overlayDir)) {
		try {
			return await resolveFromPackageDir(overlayDir, locale, opts, `overlay:${locale}`, tried)
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("missing model files")) throw error
		}
	}

	if (await cacheHasBinaries()) {
		return await resolveFromPackageDir(cacheDir, locale, opts, `cache:${packageName}`, tried)
	}

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

async function resolveFromPackageDir(
	packageDir: PathBuilder,
	locale: Intl.UnicodeBCP47LocaleIdentifier,
	opts: ExplicitPathOpts,
	source: string,
	tried: PathBuilderLike[]
): Promise<ResolvedWeights> {
	let modelPath = opts.modelPath ?? resolvePath(packageDir, "model.onnx")
	let tokenizerPath = opts.tokenizerPath ?? resolvePath(packageDir, "tokenizer.model")

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

	const modelCardPath = (await pathExists(modelCardCandidate))
		? modelCardCandidate
		: baseModelCardCandidate && (await pathExists(baseModelCardCandidate))
			? baseModelCardCandidate
			: undefined

	if (!(await pathExists(modelCardCandidate)) && modelCardPath && !source.endsWith("+base")) {
		source = `${source}+base`
	}

	const resolvedBaseModelCardPath =
		baseModelCardCandidate && (await pathExists(baseModelCardCandidate)) && baseModelCardCandidate !== modelCardPath
			? baseModelCardCandidate
			: undefined

	const crfCandidate = resolvePath(packageDir, "crf-transitions.json")
	const crfTransitionsPath = (await pathExists(crfCandidate)) ? crfCandidate : undefined

	const semiCrfCandidate = resolvePath(packageDir, "semi-crf-transitions.json")
	const semiCRFTransitionsPath = (await pathExists(semiCrfCandidate)) ? semiCrfCandidate : undefined

	const country = locale.split("-")[1] ?? ""
	const anchorLookupPath = await resolveAnchorLookupSibling(packageDir, country)

	const gazetteerCandidate = resolvePath(packageDir, "anchor-lexicon-v1.json")

	const gazetteerLexiconPath =
		opts.tier === "pocket" ? undefined : (await pathExists(gazetteerCandidate)) ? gazetteerCandidate : undefined

	const countryCandidate = resolvePath(packageDir, "country-surface-lexicon-v1.json")

	const countryLexiconPath =
		opts.tier === "pocket" ? undefined : (await pathExists(countryCandidate)) ? countryCandidate : undefined

	const streetTypeLexiconPath =
		opts.tier === "pocket" ? undefined : await resolveEvidenceLexicon("street_type", packageDir, modelCardPath)

	const localitySurfaceLexiconPath =
		opts.tier === "pocket" ? undefined : await resolveEvidenceLexicon("locality_surface", packageDir, modelCardPath)

	const pairIndexPath = await resolvePairIndexSibling(packageDir, country)

	const fstCandidate = resolvePath(packageDir, `fst-${locale}.bin`)
	const fstPath = (await pathExists(fstCandidate)) ? fstCandidate : undefined

	const morphologyCandidate = resolvePath(packageDir, "fst-street-morphology.bin")
	const baseMorphologyCandidate = baseDir ? resolvePath(baseDir, "fst-street-morphology.bin") : undefined

	const streetMorphologyPath = (await pathExists(morphologyCandidate))
		? morphologyCandidate
		: baseMorphologyCandidate && (await pathExists(baseMorphologyCandidate))
			? baseMorphologyCandidate
			: undefined

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

async function resolvePairIndexSibling(packageDir: PathBuilder, country: string): Promise<string | null> {
	if (!country) return null

	const candidate = resolvePath(packageDir, `pair-index-${country}.bin`)

	return (await pathExists(candidate)) ? candidate : null
}

/**
 * Returns the build-local `placetype-census-<cc>.bin` path under the data root
 * for `country`, or `null` when it is absent.
 */
export async function resolvePlacetypeCensusPath(country: string): Promise<PathBuilder | null> {
	if (!country) return null

	const candidate = databaseRootPath(dataRootPath())("wof", `placetype-census-${country.toLowerCase()}.bin`)

	return (await pathExists(candidate)) ? candidate : null
}

/**
 * Loads the placetype census for `country`, returning `null` when the file is absent,
 * unreadable, or built for a different country.
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

async function resolveBaseWeightsDir(
	packageDir: PathBuilderLike,
	locale?: Intl.UnicodeBCP47LocaleIdentifier,
	cacheRootIsExplicit = false
): Promise<PathBuilder | null> {
	try {
		const declarationDir = (await pathExists(resolvePath(packageDir, "package.json")))
			? packageDir
			: locale
				? tryResolvePackageDirectory(weightsPackageName(locale))
				: undefined

		if (!declarationDir) return null

		const { mailwoman } = await readPackageJSON(resolvePath(declarationDir, "package.json"))
		const base = mailwoman?.baseWeights

		if (typeof base !== "string" || !base) return null

		const siblingBaseDir = resolvePathBuilder(dirname(packageDir), base.split("/").at(-1)!)

		if (await pathExists(resolvePath(siblingBaseDir, "package.json"))) return siblingBaseDir

		if (cacheRootIsExplicit) return null

		const basePackageDir = tryResolvePackageDirectory(base)

		const baseLocale = base.replace("@mailwoman/neural-weights-", "")
		const baseOverlay = weightsOverlayDir(baseLocale)

		if (packageDir !== declarationDir && (await pathExists(resolvePath(baseOverlay, "model.onnx")))) return baseOverlay

		return basePackageDir
	} catch {
		return null
	}
}
