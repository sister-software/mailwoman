/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Cache geocoding sessions by effective configuration and source fingerprint. Warm sessions avoid repeated startup.
 *   The registry lives in the MCP server process; source edits invalidate sessions because Node cannot reload modules
 *   in place.
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
 * CLI configuration pins.
 * `undefined` selects the production default.
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
	 * Candidate weights bundle to load instead of the installed package.
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
	 * Opt-in POI venue tier.
	 */
	poi_venue_tier?: boolean
	/**
	 * Opt-in capital-status ranking.
	 */
	capital_tier?: boolean
	/**
	 * Exempt own-name variant aliases from the cross-country primary-preference penalty.
	 */
	variant_alias_exemption?: boolean
	/**
	 * Record decode-path evidence for each run.
	 */
	trace?: boolean
	/**
	 * Recheck failed lookups against other administrative bands for diagnosis.
	 */
	diagnose_unreachable?: boolean
}

/**
 * Map CLI snake_case keys to effective session option names for confound checks.
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
 * Translate a CLI key to its session-option name.
 * Preserve unknown keys for cross-engine comparisons.
 */
export function effectiveKeyFor(declared: string): string {
	return (EFFECTIVE_KEY_FOR as Record<string, string>)[declared] ?? declared
}

/**
 * Geocode session options mapped to a record while preserving each field's type.
 */
export type EffectiveConfig = { [Key in keyof GeocodeSessionOptions]: GeocodeSessionOptions[Key] }

export function resolveConfig(config: EngineConfig): GeocodeSessionOptions {
	// Use the command's option factory so unset pins resolve to production defaults.
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
 * Refuse missing or incomplete candidate bundles before constructing an engine.
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

export function engineID(effective: EffectiveConfig, fingerprint: TreeFingerprint): string {
	const canonical = stringifyJSON(
		Object.fromEntries(Object.entries(effective).toSorted(([a], [b]) => a.localeCompare(b)))
	)

	return sha256Hex(`${canonical}\n${fingerprint.digest}`).slice(0, 16)
}

export interface Engine {
	engineID: string
	session: GeocodeSession
	effective: EffectiveConfig
	fingerprint: TreeFingerprint
	buildMs: number
	lastUsed: number
	uses: number
}

export interface EngineSummary {
	engine_id: string
	locale: string
	config_effective: Record<string, unknown>
	build_ms: number
	last_used_iso: string
	uses: number
	tree_fingerprint: string
	/**
	 * Model artifact actually loaded, including its resolution source.
	 */
	weights: { model_path: string; source: string } | null
}

/**
 * Minimal registry interface used by tools and test doubles.
 */
export interface EngineRegistryLike {
	readonly repoRoot: string
	readonly bootFingerprint: TreeFingerprint
	readonly size: number
	readonly maxResident: number
	/**
	 * Whether source files changed after this process imported modules.
	 */
	sourceMoved(): Promise<boolean>
	/**
	 * The working tree's fingerprint right now — recomputed on every call, never cached.
	 */
	fingerprint(): Promise<TreeFingerprint>
	acquire(config: EngineConfig): Promise<Engine>
	evict(id: string): boolean
	evictAll(): number
	summaries(): EngineSummary[]
}

/**
 * Resident engine cache with least-recently-used eviction.
 */
export class EngineRegistry implements EngineRegistryLike {
	readonly #engines = new Map<string, Engine>()
	readonly #maxResident: number
	readonly #repoRoot: string
	readonly #bootFingerprint: TreeFingerprint

	/**
	 * Capture the imported source fingerprint before constructing the registry.
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
	 * Fingerprint of the source loaded by this process.
	 */
	get bootFingerprint(): TreeFingerprint {
		return this.#bootFingerprint
	}

	/**
	 * Whether source changed since this process imported its modules.
	 */
	async sourceMoved(): Promise<boolean> {
		return (await this.fingerprint()).digest !== this.#bootFingerprint.digest
	}

	fingerprint(): Promise<TreeFingerprint> {
		return computeTreeFingerprint(this.#repoRoot)
	}

	/**
	 * Return a cached engine or build one for this configuration.
	 * Throws if source changed after boot.
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

		// Compare against the boot fingerprint even when no engines are resident.
		if (current.digest !== this.#bootFingerprint.digest) {
			throw new Error(staleEngineMessage(this.#bootFingerprint, current))
		}

		// Validate candidate artifacts before paying the engine construction cost.
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
