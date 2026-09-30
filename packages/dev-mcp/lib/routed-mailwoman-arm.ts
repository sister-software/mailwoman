/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * A production-routed mailwoman grading arm. Unlike the warm session, the Gauntlet selects the weights overlay from
 * each case's country. This wrapper makes that routing and its artifact provenance inspectable before a board run.
 */

import { realPath } from "@mailwoman/core/fs/readers"
import { sha256File } from "@mailwoman/core/hash"
import { resolveWeights, type ResolvedWeights } from "@mailwoman/neural/weights"
import {
	buildGauntletDeps,
	runOne,
	type GauntletDeps,
	type GauntletDepsOptions,
	type GauntletResult,
} from "mailwoman/tools/eval-harness/gauntlet/harness"
import { overlayLocale } from "mailwoman/tools/eval-harness/gauntlet/routing"
import { type PathBuilderLike, relative, resolvePath, sep } from "path-ts"

import type { EngineConfig } from "#engine/registry"
import type { ResolvedInput } from "#input-sets"

const SUPPORTED_CONFIG_KEYS = new Set<keyof EngineConfig>([
	"weights_cache",
	"candidate_db",
	"default_country",
	"postcode_country_coherence",
	"gazetteer_prior",
	"admin_containment_rerank",
	"capital_tier",
	"variant_alias_exemption",
	"poi_venue_tier",
])

/**
 * One artifact an arm resolved, with the digest of the bytes it read.
 *
 * `resolveWeights` reports a name, a path and an origin.
 * Two arms can resolve one name from one origin and read different bytes, so a comparison
 * of names alone cannot establish that the arms were fed the same artifact.
 * The digest is what settles it.
 *
 * `digest` is `null` only when the artifact resolved to no path, which states that
 * this arm fed no such artifact rather than that its bytes are unknown.
 */
export interface RoutedArtifactRecord {
	name: string
	path: string | null
	origin: string | null
	digest: string | null
}

export interface RoutedArtifactProvenance {
	locale: string
	source: string
	package_dir: string
	model_path: string
	tokenizer_path: string
	artifacts: RoutedArtifactRecord[]
}

export interface RoutedMailwomanProvenance {
	engine: "mailwoman:gauntlet-routed"
	weights_cache: string | null
	base_model_path: string
	routes: Record<string, string>
	artifacts_by_locale: RoutedArtifactProvenance[]
}

export interface RoutedMailwomanArm extends Disposable {
	provenance: RoutedMailwomanProvenance
	geocode(input: ResolvedInput): Promise<GauntletResult>
}

export interface RoutedMailwomanArmDeps {
	buildDeps(options: GauntletDepsOptions): Promise<GauntletDeps>
	resolveWeights(options: { locale: string; cacheRoot?: string }): Promise<ResolvedWeights>
	realpath(path: PathBuilderLike): Promise<string>
	/**
	 * Reads one artifact's content digest, so a test supplies bytes without writing a file.
	 */
	sha256File(path: PathBuilderLike): Promise<string>
	runOne(
		input: string,
		deps: GauntletDeps,
		options: { defaultCountry?: string; caseCountry?: string; fuzzyCountryScope?: string }
	): Promise<GauntletResult>
}

const DEFAULT_DEPS: RoutedMailwomanArmDeps = {
	buildDeps: buildGauntletDeps,
	resolveWeights,
	realpath: realPath,
	sha256File,
	runOne,
}

function assertSupportedConfig(config: EngineConfig): void {
	const unsupported = Object.keys(config).filter((key) => !SUPPORTED_CONFIG_KEYS.has(key as keyof EngineConfig))

	if (unsupported.length) {
		throw new Error(
			`The routed Gauntlet arm does not support EngineConfig field${unsupported.length === 1 ? "" : "s"} ` +
				`${unsupported.toSorted().join(", ")}. Supported fields: ${[...SUPPORTED_CONFIG_KEYS].join(", ")}.`
		)
	}
}

async function assertInsideCache(
	path: PathBuilderLike,
	cacheRoot: string,
	realpath: (path: PathBuilderLike) => Promise<string>
): Promise<string> {
	const root = await realpath(cacheRoot)
	const target = await realpath(path)
	const fromRoot = relative(root, target)

	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || resolvePath(root, fromRoot) !== target) {
		throw new Error(`Candidate artifact resolved outside weights_cache: ${path} -> ${target}; cache is ${root}.`)
	}

	return target
}

/**
 * Digests every artifact that resolved to a path, resolving each path once.
 *
 * The memo is keyed by the realpath, so a base artifact several locales share is read once per arm.
 */
async function digestArtifacts(
	artifacts: ResolvedWeights["artifacts"],
	memo: Map<string, Promise<string>>,
	deps: RoutedMailwomanArmDeps
): Promise<RoutedArtifactRecord[]> {
	return await Promise.all(
		artifacts.map(async (artifact) => {
			if (!artifact.path) return { name: artifact.name, path: null, origin: artifact.origin, digest: null }

			const path = await deps.realpath(artifact.path)
			const held = memo.get(path) ?? deps.sha256File(path)

			memo.set(path, held)

			return { name: artifact.name, path, origin: artifact.origin, digest: await held }
		})
	)
}

async function preflightLocale(
	locale: string,
	cacheRoot: string,
	deps: RoutedMailwomanArmDeps,
	digests: Map<string, Promise<string>>
): Promise<RoutedArtifactProvenance> {
	const resolved = await deps.resolveWeights({ locale, cacheRoot })

	if (!resolved.packageDir) throw new Error(`Candidate locale ${locale} resolved without a package directory.`)

	const paths = [
		resolved.packageDir,
		resolved.modelPath,
		resolved.tokenizerPath,
		...resolved.artifacts.flatMap((artifact) => (artifact.path ? [artifact.path] : [])),
	]

	for (const path of paths) {
		await assertInsideCache(path, cacheRoot, deps.realpath)
	}

	return {
		locale,
		source: resolved.source,
		package_dir: await deps.realpath(resolved.packageDir),
		model_path: await deps.realpath(resolved.modelPath),
		tokenizer_path: await deps.realpath(resolved.tokenizerPath),
		artifacts: await digestArtifacts(resolved.artifacts, digests, deps),
	}
}

async function resolveLocale(
	locale: string,
	cacheRoot: string | undefined,
	deps: RoutedMailwomanArmDeps,
	digests: Map<string, Promise<string>>
) {
	if (cacheRoot) return await preflightLocale(locale, cacheRoot, deps, digests)

	const resolved = await deps.resolveWeights({ locale })

	if (!resolved.packageDir) throw new Error(`Shipped locale ${locale} resolved without a package directory.`)

	return {
		locale,
		source: resolved.source,
		package_dir: await deps.realpath(resolved.packageDir),
		model_path: await deps.realpath(resolved.modelPath),
		tokenizer_path: await deps.realpath(resolved.tokenizerPath),
		artifacts: await digestArtifacts(resolved.artifacts, digests, deps),
	}
}

/**
 * Build one Gauntlet arm after proving that every route represented by the
 * selected rows is candidate-contained.
 */
export async function buildRoutedMailwomanArm(
	config: EngineConfig,
	inputs: readonly ResolvedInput[],
	deps: RoutedMailwomanArmDeps = DEFAULT_DEPS
): Promise<RoutedMailwomanArm> {
	using resources = new DisposableStack()
	assertSupportedConfig(config)

	const cacheRoot = config.weights_cache

	const routes = Object.fromEntries(
		inputs.flatMap((input) => {
			const country = (input.routeCountry ?? input.country)?.toUpperCase()

			return country ? [[country, overlayLocale(country)]] : []
		})
	)

	const locales = ["en-US", ...Object.values(routes)].filter((locale, index, all) => all.indexOf(locale) === index)
	// One memo per arm, so an artifact several locales share is digested once.
	const digests = new Map<string, Promise<string>>()
	const artifacts = await Promise.all(locales.map(async (locale) => resolveLocale(locale, cacheRoot, deps, digests)))
	const baseModelPath = artifacts[0]!.model_path
	const mismatched = artifacts.filter((artifact) => artifact.model_path !== baseModelPath)

	if (mismatched.length) {
		throw new Error(
			`Candidate overlays must share the en-US model ${baseModelPath}; mismatched: ` +
				mismatched.map((artifact) => `${artifact.locale} -> ${artifact.model_path}`).join(", ")
		)
	}

	const gauntletDeps = resources.use(
		await deps.buildDeps({
			...(cacheRoot ? { weightsCacheRoot: cacheRoot } : {}),
			...(config.candidate_db ? { candidateDB: config.candidate_db } : {}),
			pins: {
				...(config.postcode_country_coherence === undefined
					? {}
					: { postcodeCountryCoherence: config.postcode_country_coherence }),
				...(config.gazetteer_prior === undefined ? {} : { gazetteerPrior: config.gazetteer_prior }),
				...(config.admin_containment_rerank === undefined
					? {}
					: { adminContainmentRerank: config.admin_containment_rerank }),
				...(config.capital_tier === undefined ? {} : { capitalTier: config.capital_tier }),
				...(config.variant_alias_exemption === undefined
					? {}
					: { variantAliasExemption: config.variant_alias_exemption }),
				...(config.poi_venue_tier === undefined ? {} : { poiVenueTier: config.poi_venue_tier }),
			},
		})
	)

	const weightsCache = cacheRoot ? await deps.realpath(cacheRoot) : null

	return Object.assign(resources.move(), {
		provenance: {
			engine: "mailwoman:gauntlet-routed" as const,
			weights_cache: weightsCache,
			base_model_path: baseModelPath,
			routes,
			artifacts_by_locale: artifacts,
		},
		geocode: (input: ResolvedInput) =>
			deps.runOne(input.input, gauntletDeps, {
				...((input.defaultCountry ?? config.default_country)
					? { defaultCountry: input.defaultCountry ?? config.default_country }
					: {}),
				...((input.routeCountry ?? input.country)
					? { caseCountry: (input.routeCountry ?? input.country)!.toUpperCase() }
					: {}),
				...(input.fuzzyCountryScope ? { fuzzyCountryScope: input.fuzzyCountryScope } : {}),
			}),
	})
}
