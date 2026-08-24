/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * A production-routed mailwoman grading arm. Unlike the warm session, the Gauntlet selects the weights overlay from
 * each case's country. This wrapper makes that routing and its artifact provenance inspectable before a board run.
 */

import { realpathSync } from "node:fs"
import { relative, resolve, sep } from "node:path"

import { resolveWeights, type ResolvedWeights } from "@mailwoman/neural/weights"
import {
	buildGauntletDeps,
	runOne,
	type GauntletDeps,
	type GauntletDepsOptions,
	type GauntletResult,
} from "mailwoman/eval-harness/gauntlet/harness"
import { overlayLocale } from "mailwoman/eval-harness/gauntlet/routing"

import type { EngineConfig } from "./engine-registry.ts"
import type { ResolvedInput } from "./input-sets.ts"

const SUPPORTED_CONFIG_KEYS = new Set<keyof EngineConfig>([
	"weights_cache",
	"candidate_db",
	"default_country",
	"postcode_country_coherence",
	"gazetteer_prior",
	"admin_containment_rerank",
	"capital_tier",
	"variant_alias_exemption",
])

export interface RoutedArtifactProvenance {
	locale: string
	source: string
	package_dir: string
	model_path: string
	tokenizer_path: string
	artifacts: ResolvedWeights["artifacts"]
}

export interface RoutedMailwomanProvenance {
	engine: "mailwoman:gauntlet-routed"
	weights_cache: string | null
	base_model_path: string
	routes: Record<string, string>
	artifacts_by_locale: RoutedArtifactProvenance[]
}

export interface RoutedMailwomanArm {
	provenance: RoutedMailwomanProvenance
	geocode(input: ResolvedInput): Promise<GauntletResult>
	close(): void
}

export interface RoutedMailwomanArmDeps {
	buildDeps(options: GauntletDepsOptions): Promise<GauntletDeps>
	resolveWeights(options: { locale: string; cacheRoot?: string }): ResolvedWeights
	realpath(path: string): string
	runOne(
		input: string,
		deps: GauntletDeps,
		options: { defaultCountry?: string; caseCountry?: string; fuzzyCountryScope?: string }
	): Promise<GauntletResult>
}

const DEFAULT_DEPS: RoutedMailwomanArmDeps = {
	buildDeps: buildGauntletDeps,
	resolveWeights,
	realpath: realpathSync,
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

function assertInsideCache(path: string, cacheRoot: string, realpath: (path: string) => string): string {
	const root = realpath(cacheRoot)
	const target = realpath(path)
	const fromRoot = relative(root, target)

	if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || resolve(root, fromRoot) !== target) {
		throw new Error(`Candidate artifact resolved outside weights_cache: ${path} -> ${target}; cache is ${root}.`)
	}

	return target
}

function preflightLocale(locale: string, cacheRoot: string, deps: RoutedMailwomanArmDeps): RoutedArtifactProvenance {
	const resolved = deps.resolveWeights({ locale, cacheRoot })

	if (!resolved.packageDir) throw new Error(`Candidate locale ${locale} resolved without a package directory.`)

	const paths = [
		resolved.packageDir,
		resolved.modelPath,
		resolved.tokenizerPath,
		...resolved.artifacts.flatMap((artifact) => (artifact.path ? [artifact.path] : [])),
	]

	for (const path of paths) {
		assertInsideCache(path, cacheRoot, deps.realpath)
	}

	return {
		locale,
		source: resolved.source,
		package_dir: deps.realpath(resolved.packageDir),
		model_path: deps.realpath(resolved.modelPath),
		tokenizer_path: deps.realpath(resolved.tokenizerPath),
		artifacts: resolved.artifacts,
	}
}

function resolveLocale(locale: string, cacheRoot: string | undefined, deps: RoutedMailwomanArmDeps) {
	if (cacheRoot) return preflightLocale(locale, cacheRoot, deps)

	const resolved = deps.resolveWeights({ locale })

	if (!resolved.packageDir) throw new Error(`Shipped locale ${locale} resolved without a package directory.`)

	return {
		locale,
		source: resolved.source,
		package_dir: deps.realpath(resolved.packageDir),
		model_path: deps.realpath(resolved.modelPath),
		tokenizer_path: deps.realpath(resolved.tokenizerPath),
		artifacts: resolved.artifacts,
	}
}

/**
 * Build one Gauntlet arm after proving that every route represented by the selected rows is candidate-contained.
 */
export async function buildRoutedMailwomanArm(
	config: EngineConfig,
	inputs: readonly ResolvedInput[],
	deps: RoutedMailwomanArmDeps = DEFAULT_DEPS
): Promise<RoutedMailwomanArm> {
	assertSupportedConfig(config)

	const cacheRoot = config.weights_cache

	const routes = Object.fromEntries(
		inputs.flatMap((input) => {
			const country = (input.routeCountry ?? input.country)?.toUpperCase()

			return country ? [[country, overlayLocale(country)]] : []
		})
	)

	const locales = ["en-US", ...Object.values(routes)].filter((locale, index, all) => all.indexOf(locale) === index)
	const artifacts = locales.map((locale) => resolveLocale(locale, cacheRoot, deps))
	const baseModelPath = artifacts[0]!.model_path
	const mismatched = artifacts.filter((artifact) => artifact.model_path !== baseModelPath)

	if (mismatched.length) {
		throw new Error(
			`Candidate overlays must share the en-US model ${baseModelPath}; mismatched: ` +
				mismatched.map((artifact) => `${artifact.locale} -> ${artifact.model_path}`).join(", ")
		)
	}

	const gauntletDeps = await deps.buildDeps({
		...(cacheRoot ? { weightsCacheRoot: cacheRoot } : {}),
		levers: {
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
		},
	})

	return {
		provenance: {
			engine: "mailwoman:gauntlet-routed",
			weights_cache: cacheRoot ? deps.realpath(cacheRoot) : null,
			base_model_path: baseModelPath,
			routes,
			artifacts_by_locale: artifacts,
		},
		geocode: (input) =>
			deps.runOne(input.input, gauntletDeps, {
				...((input.defaultCountry ?? config.default_country)
					? { defaultCountry: input.defaultCountry ?? config.default_country }
					: {}),
				...((input.routeCountry ?? input.country)
					? { caseCountry: (input.routeCountry ?? input.country)!.toUpperCase() }
					: {}),
				...(input.fuzzyCountryScope ? { fuzzyCountryScope: input.fuzzyCountryScope } : {}),
			}),
		close: () => gauntletDeps.close(),
	}
}
