/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Caches geocode sessions by effective configuration and source fingerprint.
 */

import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import {
	createGeocodeCommandOptions,
	createGeocodeSession,
	type GeocodeSession,
	type GeocodeSessionOptions,
} from "mailwoman/geocode"
import type { PathBuilderLike } from "path-ts"

import { missingWeightsCacheArtifacts } from "#eval-report"
import { computeTreeFingerprint, staleEngineMessage, type TreeFingerprint } from "#tree-fingerprint"

/**
 * The engine configuration in CLI snake_case keys.
 *
 * An unset key uses the production default.
 */
export interface EngineConfig {
	locale?: string
	country_scope?: "auto" | "locale" | "none"
	default_country?: string
	bias?: string
	candidate_db?: string
	resolve_db?: string
	data_root?: string
	/**
	 * A candidate weights bundle to load instead of the installed package.
	 */
	weights_cache?: string
	gazetteer_prior?: boolean
	place_country?: boolean
	place_country_threshold?: number
	postcode_country_coherence?: boolean
	fork_entity?: boolean
	locale_country_prior?: boolean
	postcode_shape_coherence?: boolean
	postcode_containment_coherence?: boolean
	admin_containment_rerank?: boolean
	/**
	 * Enables the POI venue tier, which is off by default.
	 */
	poi_venue_tier?: boolean
	/**
	 * Enables capital-status ranking.
	 */
	capital_tier?: boolean
	/**
	 * Exempts own-name variant aliases from the cross-country primary-preference penalty.
	 */
	variant_alias_exemption?: boolean
	/**
	 * Records decode-path evidence for each run.
	 */
	trace?: boolean
	/**
	 * Rechecks failed lookups against other administrative bands for diagnosis.
	 */
	diagnose_unreachable?: boolean
}

/**
 * Maps each CLI key to its session option name, for confound checks.
 */
export const EFFECTIVE_KEY_FOR = {
	locale: "locale",
	country_scope: "countryScope",
	default_country: "defaultCountry",
	bias: "bias",
	candidate_db: "candidateDB",
	resolve_db: "resolveDB",
	data_root: "dataRoot",
	weights_cache: "weightsCacheRoot",
	gazetteer_prior: "gazetteerPrior",
	place_country: "placeCountry",
	place_country_threshold: "placeCountryThreshold",
	postcode_country_coherence: "postcodeCountryCoherence",
	fork_entity: "forkEntity",
	locale_country_prior: "localeCountryPrior",
	postcode_shape_coherence: "postcodeShapeCoherence",
	postcode_containment_coherence: "postcodeContainmentCoherence",
	admin_containment_rerank: "adminContainmentRerank",
	poi_venue_tier: "poiVenueTier",
	capital_tier: "capitalTier",
	variant_alias_exemption: "variantAliasExemption",
	trace: "trace",
	diagnose_unreachable: "diagnoseUnreachable",
} as const satisfies Record<keyof EngineConfig, string>

/**
 * Returns the session option name for a CLI key.
 *
 * An unknown key is returned unchanged, so a comparison can still name another engine's key.
 */
export function effectiveKeyFor(declared: string): string {
	return (EFFECTIVE_KEY_FOR as Record<string, string>)[declared] ?? declared
}

/**
 * The resolved geocode session options.
 */
export type EffectiveConfig = { [Key in keyof GeocodeSessionOptions]: GeocodeSessionOptions[Key] }

/**
 * Resolves an engine configuration to session options.
 *
 * Unset keys take their defaults from the geocode command's option factory.
 */
export function resolveConfig(config: EngineConfig): GeocodeSessionOptions {
	const production = createGeocodeCommandOptions()

	return {
		locale: config.locale ?? production.locale,
		countryScope: config.country_scope ?? production.countryScope,
		dataRoot: config.data_root ?? production.dataRoot,
		localeCountryPrior: config.locale_country_prior ?? production.localeCountryPrior,
		placeCountry: config.place_country ?? production.placeCountry,
		postcodeCountryCoherence: config.postcode_country_coherence ?? production.postcodeCountryCoherence,
		forkEntity: config.fork_entity ?? production.forkEntity,
		postcodeShapeCoherence: config.postcode_shape_coherence ?? production.postcodeShapeCoherence,
		postcodeContainmentCoherence: config.postcode_containment_coherence ?? production.postcodeContainmentCoherence,
		placeCountryThreshold: config.place_country_threshold ?? production.placeCountryThreshold,
		gazetteerPrior: config.gazetteer_prior ?? production.gazetteerPrior,
		adminContainmentRerank: config.admin_containment_rerank ?? production.adminContainmentRerank,
		...(config.poi_venue_tier === true ? { poiVenueTier: true } : {}),
		...(config.capital_tier === undefined ? {} : { capitalTier: config.capital_tier }),
		...(config.variant_alias_exemption === undefined ? {} : { variantAliasExemption: config.variant_alias_exemption }),
		...(config.default_country ? { defaultCountry: config.default_country } : {}),
		...(config.bias ? { bias: config.bias } : {}),
		...(config.candidate_db ? { candidateDB: config.candidate_db } : {}),
		...(config.resolve_db ? { resolveDB: config.resolve_db } : {}),
		...(config.weights_cache ? { weightsCacheRoot: config.weights_cache } : {}),
		...(config.trace ? { trace: true } : {}),
		...(config.diagnose_unreachable ? { diagnoseUnreachable: true } : {}),
	}
}

/**
 * Throws when a candidate weights bundle is missing files.
 *
 * Loading an incomplete bundle would silently fall back to other weights or disable channels,
 * and the eval would report that as the candidate's score.
 */
export async function assertWeightsCacheStaged(cacheRoot: PathBuilderLike, locale = "en-us"): Promise<void> {
	const { kind, paths } = await missingWeightsCacheArtifacts(cacheRoot, locale)

	if (kind === "ok") return

	throw new Error(
		kind === "wrong-shape"
			? `weights_cache ${cacheRoot} is not a staged ${locale} bundle — missing ${paths.join(", ")}. ` +
					"Refusing rather than falling through to the installed weights, which would grade the SHIPPED model " +
					"under this candidate's label."
			: `weights_cache ${cacheRoot} declares artifacts it does not ship — missing ${paths.join(", ")}. ` +
					"A bundle short of its own card's files loads with those channels OFF and scores like a model " +
					"regression, so it is refused rather than measured."
	)
}

/**
 * Returns a 16-character ID derived from the sorted configuration and the source fingerprint.
 */
export function engineID(effective: EffectiveConfig, fingerprint: TreeFingerprint): string {
	const canonical = stringifyJSON(
		Object.fromEntries(Object.entries(effective).toSorted(([a], [b]) => a.localeCompare(b)))
	)

	return sha256Hex(`${canonical}\n${fingerprint.digest}`).slice(0, 16)
}

/**
 * A resident geocode session and its usage statistics.
 */
export interface Engine {
	engineID: string
	session: GeocodeSession
	effective: EffectiveConfig
	fingerprint: TreeFingerprint
	buildMs: number
	lastUsed: number
	uses: number
}

/**
 * The JSON summary of one resident engine.
 */
export interface EngineSummary {
	engine_id: string
	locale: string
	config_effective: Record<string, unknown>
	build_ms: number
	last_used_iso: string
	uses: number
	tree_fingerprint: string
	/**
	 * The model file the session loaded and where it was resolved from.
	 */
	weights: { model_path: string; source: string } | null
}

/**
 * The registry interface that tools and test doubles use.
 */
export interface EngineRegistryLike {
	readonly repoRoot: string
	readonly bootFingerprint: TreeFingerprint
	readonly size: number
	readonly maxResident: number
	/**
	 * Resolves true when source files changed after this process imported its modules.
	 */
	sourceMoved(): Promise<boolean>
	/**
	 * Computes the working tree's current fingerprint on every call.
	 */
	fingerprint(): Promise<TreeFingerprint>
	acquire(config: EngineConfig): Promise<Engine>
	evict(id: string): boolean
	evictAll(): number
	summaries(): EngineSummary[]
}

/**
 * A cache of resident engines with least-recently-used eviction.
 *
 * Node cannot reload modules in place, so the registry refuses to build an engine after the source changes.
 */
export class EngineRegistry implements EngineRegistryLike {
	readonly #engines = new Map<string, Engine>()
	readonly #maxResident: number
	readonly #repoRoot: string
	readonly #bootFingerprint: TreeFingerprint

	/**
	 * Creates a registry that records the source fingerprint at boot.
	 */
	static async create(repoRoot: string, maxResident = 2): Promise<EngineRegistry> {
		return new EngineRegistry(repoRoot, maxResident, await computeTreeFingerprint(repoRoot))
	}

	constructor(repoRoot: string, maxResident: number, bootFingerprint: TreeFingerprint) {
		this.#repoRoot = repoRoot
		this.#maxResident = maxResident
		this.#bootFingerprint = bootFingerprint
	}

	get repoRoot(): string {
		return this.#repoRoot
	}

	/**
	 * The fingerprint of the source this process loaded.
	 */
	get bootFingerprint(): TreeFingerprint {
		return this.#bootFingerprint
	}

	async sourceMoved(): Promise<boolean> {
		return (await this.fingerprint()).digest !== this.#bootFingerprint.digest
	}

	fingerprint(): Promise<TreeFingerprint> {
		return computeTreeFingerprint(this.#repoRoot)
	}

	/**
	 * Returns the cached engine for this configuration, or builds one.
	 *
	 * @throws When the source changed after boot.
	 */
	async acquire(config: EngineConfig): Promise<Engine> {
		const current = await this.fingerprint()
		const effective = resolveConfig(config)
		const id = engineID(effective, current)
		const existing = this.#engines.get(id)

		if (existing) {
			existing.lastUsed = Date.now()

			existing.uses++

			return existing
		}

		if (current.digest !== this.#bootFingerprint.digest) {
			throw new Error(staleEngineMessage(this.#bootFingerprint, current))
		}

		if (effective.weightsCacheRoot) {
			await assertWeightsCacheStaged(effective.weightsCacheRoot, effective.locale)
		}

		const startedAt = Date.now()
		const session = await createGeocodeSession(effective)

		const engine: Engine = {
			engineID: id,
			session,
			effective,
			fingerprint: current,
			buildMs: Date.now() - startedAt,
			lastUsed: Date.now(),
			uses: 1,
		}

		this.#engines.set(id, engine)
		this.#evictToCap()

		return engine
	}

	#evictToCap(): void {
		while (this.#engines.size > this.#maxResident) {
			const oldest = [...this.#engines.values()].toSorted((a, b) => a.lastUsed - b.lastUsed)[0]

			if (!oldest) return

			this.evict(oldest.engineID)
		}
	}

	evict(id: string): boolean {
		const engine = this.#engines.get(id)

		if (!engine) return false

		engine.session[Symbol.dispose]()
		this.#engines.delete(id)

		return true
	}

	evictAll(): number {
		const ids = [...this.#engines.keys()]

		for (const id of ids) {
			this.evict(id)
		}

		return ids.length
	}

	summaries(): EngineSummary[] {
		return [...this.#engines.values()].map((engine) => ({
			engine_id: engine.engineID,
			locale: engine.effective.locale,
			config_effective: engine.effective,
			build_ms: engine.buildMs,
			last_used_iso: new Date(engine.lastUsed).toISOString(),
			uses: engine.uses,
			tree_fingerprint: engine.fingerprint.digest,
			weights: engine.session.artifacts.weights
				? {
						model_path: engine.session.artifacts.weights.modelPath,
						source: engine.session.artifacts.weights.source,
					}
				: null,
		}))
	}

	get maxResident(): number {
		return this.#maxResident
	}

	get size(): number {
		return this.#engines.size
	}
}
