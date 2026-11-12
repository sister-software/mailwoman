// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Caches geocode sessions by effective configuration and source fingerprint.
 */

import type { VariantAliasExemption } from "@mailwoman/core/geocode"
import { md5File, sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { type ChannelPins, SOFT_CHANNEL_NAMES, type SoftChannelName } from "@mailwoman/core/pipeline"
import {
	type CapitalTier,
	createGeocodeCommandOptions,
	createGeocodeSession,
	GEOCODE_SWITCH_DEFAULTS,
	type GeocodeSession,
	type GeocodeSessionOptions,
} from "mailwoman/geocode"
import { pinnedSwitch, type SwitchPin } from "mailwoman/tools/eval-harness/switch-pin"
import type { PathBuilderLike } from "path-ts"

import { missingWeightsCacheArtifacts } from "#dev-mcp/eval-report"
import { computeTreeFingerprint, staleEngineMessage, type TreeFingerprint } from "#dev-mcp/tree-fingerprint"

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
	gazetteer_prior?: SwitchPin
	/**
	 * Whether the venue-head prior feeds the parse.
	 *
	 * @defaultValue `GEOCODE_SESSION_DEFAULTS.venueHeadPrior`
	 */
	venue_head_prior?: SwitchPin
	/**
	 * Multiplier on the venue-head table's biases.
	 */
	venue_head_bias_scale?: number
	/**
	 * Whether the street-morphology prior biases a street affix on a numbered segment.
	 *
	 * @defaultValue `GEOCODE_SESSION_DEFAULTS.streetMorphologyPrior`
	 */
	street_morphology_prior?: SwitchPin
	place_country?: SwitchPin
	place_country_threshold?: number
	postcode_country_coherence?: SwitchPin
	fork_entity?: SwitchPin
	locale_country_prior?: SwitchPin
	postcode_shape_coherence?: SwitchPin
	postcode_containment_coherence?: SwitchPin
	admin_containment_rerank?: SwitchPin
	/**
	 * Whether a parsed dependent locality resolves inside its parent and answers the coordinate (#2804).
	 *
	 * @defaultValue `GEOCODE_SWITCH_DEFAULTS.dependentLocalityContainment`
	 */
	dependent_locality_containment?: SwitchPin
	/**
	 * Whether `poi.db` entity upgrades reach the venue tier.
	 *
	 * @defaultValue `GEOCODE_SWITCH_DEFAULTS.poiVenueTier`
	 */
	poi_venue_tier?: SwitchPin
	/**
	 * The capital-status ranking tier (`"auto"`, `"required"` or `"off"`).
	 */
	capital_tier?: CapitalTier
	/**
	 * Whether own-name variant aliases are exempt from the cross-country primary-preference penalty.
	 *
	 * The vocabulary matches `GeocodeResult.variant_alias_exemption`.
	 * Unset keeps the production default, `"applied"`.
	 */
	variant_alias_exemption?: VariantAliasExemption
	/**
	 * Records decode-path evidence for each run.
	 */
	trace?: boolean
	/**
	 * Rechecks failed lookups against other administrative bands for diagnosis.
	 */
	diagnose_unreachable?: boolean
	/**
	 * Per-channel feed pins for the classifier's five soft-feature channels.
	 *
	 * A channel pinned `off` is fed zeros in place of its built features, the trained absence state.
	 * Unset feeds every channel as built.
	 */
	channels?: ChannelPins
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
	venue_head_prior: "venueHeadPrior",
	venue_head_bias_scale: "venueHeadBiasScale",
	street_morphology_prior: "streetMorphologyPrior",
	place_country: "placeCountry",
	place_country_threshold: "placeCountryThreshold",
	postcode_country_coherence: "postcodeCountryCoherence",
	fork_entity: "forkEntity",
	locale_country_prior: "localeCountryPrior",
	postcode_shape_coherence: "postcodeShapeCoherence",
	postcode_containment_coherence: "postcodeContainmentCoherence",
	admin_containment_rerank: "adminContainmentRerank",
	dependent_locality_containment: "dependentLocalityContainment",
	poi_venue_tier: "poiVenueTier",
	capital_tier: "capitalTier",
	variant_alias_exemption: "variantAliasExemption",
	trace: "trace",
	diagnose_unreachable: "diagnoseUnreachable",
	channels: "channelPins",
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
		localeCountryPrior: pinnedSwitch(config.locale_country_prior ?? "production", production.localeCountryPrior),
		placeCountry: pinnedSwitch(config.place_country ?? "production", production.placeCountry),
		postcodeCountryCoherence: pinnedSwitch(
			config.postcode_country_coherence ?? "production",
			production.postcodeCountryCoherence
		),
		forkEntity: pinnedSwitch(config.fork_entity ?? "production", production.forkEntity),
		postcodeShapeCoherence: pinnedSwitch(
			config.postcode_shape_coherence ?? "production",
			production.postcodeShapeCoherence
		),
		postcodeContainmentCoherence: pinnedSwitch(
			config.postcode_containment_coherence ?? "production",
			production.postcodeContainmentCoherence
		),
		placeCountryThreshold: config.place_country_threshold ?? production.placeCountryThreshold,
		gazetteerPrior: pinnedSwitch(config.gazetteer_prior ?? "production", production.gazetteerPrior),
		venueHeadPrior: pinnedSwitch(config.venue_head_prior ?? "production", production.venueHeadPrior),
		venueHeadBiasScale: config.venue_head_bias_scale ?? production.venueHeadBiasScale,
		streetMorphologyPrior: pinnedSwitch(
			config.street_morphology_prior ?? "production",
			production.streetMorphologyPrior
		),
		adminContainmentRerank: pinnedSwitch(
			config.admin_containment_rerank ?? "production",
			production.adminContainmentRerank
		),
		dependentLocalityContainment: pinnedSwitch(
			config.dependent_locality_containment ?? "production",
			production.dependentLocalityContainment
		),
		poiVenueTier: pinnedSwitch(config.poi_venue_tier ?? "production", GEOCODE_SWITCH_DEFAULTS.poiVenueTier),
		capitalTier: config.capital_tier ?? production.capitalTier,
		variantAliasExemption: config.variant_alias_exemption ?? production.variantAliasExemption,
		...(config.default_country ? { defaultCountry: config.default_country } : {}),
		...(config.bias ? { bias: config.bias } : {}),
		...(config.candidate_db ? { candidateDB: config.candidate_db } : {}),
		...(config.resolve_db ? { resolveDB: config.resolve_db } : {}),
		...(config.weights_cache ? { weightsCacheRoot: config.weights_cache } : {}),
		...(config.trace ? { trace: true } : {}),
		...(config.diagnose_unreachable ? { diagnoseUnreachable: true } : {}),
		...(config.channels && Object.keys(config.channels).length ? { channelPins: config.channels } : {}),
	}
}

/**
 * Throws when a candidate weights bundle is missing files.
 *
 * An incomplete bundle makes the loader fall back to other weights or disable channels.
 * The eval would then report those results as the candidate's score.
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
	/**
	 * The lexicon or lookup file behind each fed channel, with its md5, read once when the engine is built.
	 *
	 * Two engines whose channel bytes differ then differ visibly in provenance.
	 * Without this list, a swapped lexicon under an unchanged model would stay hidden.
	 */
	lexicons: LexiconIdentity[]
}

/**
 * One caller's hold on a resident engine: the engine's fields, and a `Symbol.dispose` that releases the hold.
 *
 * Take it with `using`.
 * The registry disposes an evicted engine's session only once every lease on it is released,
 * so a caller never reads a session another call's eviction closed.
 */
export interface EngineLease extends Engine, Disposable {}

/**
 * One cache entry: the engine and the count of leases that hold it.
 */
interface ResidentEngine {
	engine: Engine
	leases: number
	/**
	 * Set when the engine left the cache.
	 * The last lease to be released then disposes its session.
	 */
	evicted: boolean
}

/**
 * One channel's artifact identity.
 */
interface LexiconIdentity {
	channel: SoftChannelName
	path: string
	md5: string
}

/**
 * Reads the identity of each lexicon the session's classifier loaded.
 */
async function lexiconIdentities(session: GeocodeSession): Promise<LexiconIdentity[]> {
	const paths = session.artifacts.lexicons ?? {}
	const identities: LexiconIdentity[] = []

	for (const channel of SOFT_CHANNEL_NAMES) {
		const path = paths[channel]

		if (path) {
			identities.push({ channel, path, md5: await md5File(path) })
		}
	}

	return identities
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
	acquire(config: EngineConfig): Promise<EngineLease>
	evict(id: string): Promise<boolean>
	evictAll(): Promise<number>
	summaries(): EngineSummary[]
}

/**
 * A cache of resident engines with least-recently-used eviction.
 *
 * Node cannot reload modules in place, so the registry refuses to build an engine after the source changes.
 */
export class EngineRegistry implements EngineRegistryLike {
	readonly #engines = new Map<string, ResidentEngine>()
	/**
	 * Builds in progress by engine id, so concurrent acquires of one configuration share one session.
	 */
	readonly #building = new Map<string, Promise<ResidentEngine>>()
	/**
	 * Session disposals that started when a lease was released.
	 * `evictAll` waits for them.
	 */
	readonly #closing = new Set<Promise<void>>()
	readonly #maxResident: number
	readonly #repoRoot: string
	readonly #bootFingerprint: TreeFingerprint
	readonly #createSession: (options: GeocodeSessionOptions) => Promise<GeocodeSession>
	readonly #computeFingerprint: (repoRoot: string) => Promise<TreeFingerprint>

	/**
	 * Creates a registry that records the source fingerprint at boot.
	 */
	static async create(repoRoot: string, maxResident = 2): Promise<EngineRegistry> {
		return new EngineRegistry(repoRoot, maxResident, await computeTreeFingerprint(repoRoot))
	}

	/**
	 * @param deps The session builder and the tree fingerprint, `createGeocodeSession`
	 * and `computeTreeFingerprint` by default.
	 * A test passes its own, because the root Vitest config shares modules between files
	 * and a module mock then applies only when its file loads the registry first.
	 */
	constructor(
		repoRoot: string,
		maxResident: number,
		bootFingerprint: TreeFingerprint,
		deps: {
			createSession?: (options: GeocodeSessionOptions) => Promise<GeocodeSession>
			computeFingerprint?: (repoRoot: string) => Promise<TreeFingerprint>
		} = {}
	) {
		this.#repoRoot = repoRoot
		this.#maxResident = maxResident
		this.#bootFingerprint = bootFingerprint
		this.#createSession = deps.createSession ?? createGeocodeSession
		this.#computeFingerprint = deps.computeFingerprint ?? computeTreeFingerprint
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
		return this.#computeFingerprint(this.#repoRoot)
	}

	/**
	 * Returns a lease on the cached engine for this configuration, building the engine when none is resident.
	 *
	 * Concurrent calls for one configuration share one build.
	 *
	 * @throws When the source changed after boot.
	 */
	async acquire(config: EngineConfig): Promise<EngineLease> {
		const current = await this.fingerprint()
		const effective = resolveConfig(config)
		const id = engineID(effective, current)
		const existing = this.#engines.get(id)

		if (existing) return this.#lease(existing)

		let building = this.#building.get(id)

		if (!building) {
			if (current.digest !== this.#bootFingerprint.digest) {
				throw new Error(staleEngineMessage(this.#bootFingerprint, current))
			}

			building = this.#build(id, effective, current)
			this.#building.set(id, building)
			// A failed build leaves no entry, so the next acquire builds again.
			void building.finally(() => this.#building.delete(id)).catch(() => {})
		}

		return this.#lease(await building)
	}

	async #build(id: string, effective: EffectiveConfig, current: TreeFingerprint): Promise<ResidentEngine> {
		if (effective.weightsCacheRoot) {
			await assertWeightsCacheStaged(effective.weightsCacheRoot, effective.locale)
		}

		const startedAt = Date.now()
		const session = await this.#createSession(effective)
		const lexicons = await lexiconIdentities(session)

		const resident: ResidentEngine = {
			engine: {
				engineID: id,
				session,
				effective,
				fingerprint: current,
				buildMs: Date.now() - startedAt,
				lastUsed: Date.now(),
				uses: 0,
				lexicons,
			},
			leases: 0,
			evicted: false,
		}

		this.#engines.set(id, resident)
		await this.#evictToCap(id)

		return resident
	}

	/**
	 * A lease on `resident`, counted until the holder releases it.
	 */
	#lease(resident: ResidentEngine): EngineLease {
		resident.leases++

		resident.engine.uses++
		resident.engine.lastUsed = Date.now()

		let released = false

		return {
			...resident.engine,
			[Symbol.dispose]: () => {
				if (released) return

				released = true

				resident.leases--

				if (resident.evicted && resident.leases === 0) {
					this.#close(resident)
				}
			},
		}
	}

	#close(resident: ResidentEngine): void {
		const closing = resident.engine.session[Symbol.asyncDispose]()

		this.#closing.add(closing)
		void closing.finally(() => this.#closing.delete(closing)).catch(() => {})
	}

	/**
	 * Evicts the least recently used engines until the cache fits, keeping `keep`,
	 * the engine this build made.
	 */
	async #evictToCap(keep: string): Promise<void> {
		while (this.#engines.size > this.#maxResident) {
			const oldest = [...this.#engines.values()]
				.filter((resident) => resident.engine.engineID !== keep)
				.toSorted((a, b) => a.engine.lastUsed - b.engine.lastUsed)[0]

			if (!oldest) return

			await this.evict(oldest.engine.engineID)
		}
	}

	/**
	 * Drops the engine from the cache, and closes its session once no lease holds it.
	 *
	 * The engine leaves the cache first, so a concurrent acquire builds a fresh one.
	 * A session with leases outstanding closes when the last of them is released.
	 */
	async evict(id: string): Promise<boolean> {
		const resident = this.#engines.get(id)

		if (!resident) return false

		this.#engines.delete(id)
		resident.evicted = true

		if (resident.leases === 0) {
			await resident.engine.session[Symbol.asyncDispose]()
		}

		return true
	}

	/**
	 * Evicts every engine, closes each session even when a lease still holds it,
	 * and waits for every close to finish.
	 *
	 * The process calls it on shutdown, when no request is left to finish.
	 */
	async evictAll(): Promise<number> {
		const residents = [...this.#engines.values()]

		for (const resident of residents) {
			this.#engines.delete(resident.engine.engineID)
			resident.evicted = true
			await resident.engine.session[Symbol.asyncDispose]()
		}

		await Promise.all(this.#closing)

		return residents.length
	}

	summaries(): EngineSummary[] {
		return [...this.#engines.values()].map(({ engine }) => ({
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
