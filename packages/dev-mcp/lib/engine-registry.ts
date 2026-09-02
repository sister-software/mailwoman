/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The warm state, and the reason this server exists.
 *
 *   Measured on this box (spec §1.2): ~1.37 s of fixed cost before a cold process answers its first query — of which
 *   ~1.0 s is loading the weights — then ~123 ms per query once warm. Feeding 20 inputs through one warm process took
 *   3.83 s against roughly 30 s spawned per row, 7.8×. That ratio is why the existing benchmark rig spends about ten
 *   minutes of pure process startup per 420-row arm, and it is why a small panel is the rational choice for anyone
 *   paying the cold start each time.
 *
 *   An engine is one {@link GeocodeSession} plus the configuration that produced it, addressed by a content hash of
 *   that configuration. Two flag settings over one model share nothing at construction and are nearly free to compare;
 *   two models or two gazetteers are two resident multi-gigabyte footprints, which is a fact a caller should know
 *   BEFORE it waits.
 *
 *   **Deviation from spec §3.1, stated rather than buried.** The spec puts the registry in a long-lived supervisor
 *   behind a Unix socket, with one forked worker per configuration, so warmth survives agent restarts and an engine can
 *   be evicted by killing a process. This holds the registry IN the MCP server process instead. An MCP stdio server
 *   already lives as long as the agent that spawned it, so warmth spans every tool call in a session — the dominant
 *   win — while the socket, the supervisor and the fork protocol are deferred. The costs are paid
 *   explicitly: eviction returns less RSS than killing a worker would, and there is no in-process module reload, which
 *   is why {@link EngineRegistry.acquire} REFUSES on a source edit rather than pretending to reload (see
 *   `tree-fingerprint.ts`). Building the supervisor is the right next step if warmth across agent restarts proves to
 *   matter; it is not needed to test whether a warm engine changes which panel gets measured.
 */

import { sha256Hex } from "@mailwoman/core/hash"
import {
	createGeocodeCommandOptions,
	createGeocodeSession,
	type GeocodeSession,
	type GeocodeSessionOptions,
} from "mailwoman/geocode"

import { missingWeightsCacheArtifacts } from "#eval-report"
import { computeTreeFingerprint, staleEngineMessage, type TreeFingerprint } from "#tree-fingerprint"

/**
 * Every lever a caller can set, in the CLI's own vocabulary.
 *
 * `undefined` means the PRODUCTION DEFAULT, never "off" — the rule `GauntletResolverLevers` states in `harness.ts:69`:
 * "the library defaults are the thing under test". A tool that coerced undefined to false would grade a configuration
 * nobody ships.
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
	 * Grade a CANDIDATE weights bundle rather than the installed one — the lever that turns a model question into a
	 * comparison. Unset means whatever the resolution ladder finds, which is what production loads.
	 *
	 * Guarded by {@link assertWeightsCacheStaged} at {@link EngineRegistry.acquire} because the ladder's fall-through is
	 * silent: see that function.
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
	 * The opt-in venue tier (#1684's POI half) — default OFF in production; this lever exists so the promotion battery
	 * measures it with the standard tooling.
	 */
	poi_venue_tier?: boolean
	/**
	 * The capital-status ranking axis (#1880) — bounded NATIONAL-capital promotion on the bare-toponym class. Default OFF
	 * (D-rule).
	 */
	capital_tier?: boolean
	/**
	 * #1882 — exempt own-name `variant` aliases from the cross-country primary-preference penalty. Effective only against
	 * an artifact whose `name_role` column carries the stamp. Default OFF (D-rule).
	 */
	variant_alias_exemption?: boolean
	/**
	 * Record the decode-path evidence on every run. OFF by default and left off by the measuring tools: the trace is kept
	 * per run, so it is a per-row cost paid only where the evidence is the answer.
	 */
	trace?: boolean
	/**
	 * Re-probe a resolved-nothing lookup across the other admin bands and record which hold it.
	 *
	 * NOT a lever and deliberately absent from the tool schemas: the answer is byte-identical either way, so declaring it
	 * as a variable in a comparison would be declaring a variable that cannot move an outcome. The measuring tools that
	 * read misses force it on, the same way they force `trace`.
	 */
	diagnose_unreachable?: boolean
}

/**
 * The session options a config resolves to, with every default made explicit.
 *
 * Resolving before recording is what makes a confound check possible at all. Two arms whose STATED configs differ in
 * one field can differ in three effective ones — `--country-scope auto` means "scope on FTS, no scope on candidate"
 * (`docs/engineering/reference/resolver-backends.mdx`), so switching backend also switches country scoping. A
 * comparison that reads stated configs cannot see that; one that reads effective configs can.
 */
/**
 * Which `GeocodeSessionOptions` key each `EngineConfig` key becomes.
 *
 * The two vocabularies differ by design — a caller writes the CLI's snake_case, a session reads camelCase — and
 * {@link resolveConfig} performs the translation inline, where it is invisible to anyone else who needs it. This map is
 * the same translation, named, because `confound.ts` compares a caller's DECLARED keys against the keys that actually
 * differ between two resolved configs. Without it, declaring `["place_country"]` and having `placeCountry` move reads
 * as two separate facts — one lever declared and unmoved, one moved and undeclared — and every correctly-declared
 * comparison grades itself ambiguous.
 *
 * `configKeyMapping.test.ts` asserts this stays in step with `resolveConfig`, which is the only thing that can: a lever
 * added to one and not the other is a silent regression to exactly the behaviour above.
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
 * Translate a caller's declared key into the effective key it becomes, or return it unchanged.
 *
 * Unchanged rather than rejected: a caller may legitimately declare something that is not an `EngineConfig` key at all
 * — `["engine"]` across two geocoders is the common one — and turning that into an error would refuse the correct
 * declaration for the one comparison where no config key can express the variable.
 */
export function effectiveKeyFor(declared: string): string {
	return (EFFECTIVE_KEY_FOR as Record<string, string>)[declared] ?? declared
}

/**
 * {@link GeocodeSessionOptions} in a form a JSON record accepts.
 *
 * Structurally the same type, field for field. It exists because TypeScript withholds an implicit index signature from
 * an INTERFACE — declaration merging could add a member later — so an interface value is not assignable to
 * `Record<string, unknown>` however it is one. The mapping is checked property by property and keeps each field's own
 * type, which a cast through `unknown` would discard.
 */
export type EffectiveConfig = { [Key in keyof GeocodeSessionOptions]: GeocodeSessionOptions[Key] }

export function resolveConfig(config: EngineConfig): GeocodeSessionOptions {
	// THE production defaults, from the geocode command's own factory — never re-typed here (#1732).
	// The hand-copied table this replaces drifted on three values (postcodeShapeCoherence,
	// postcodeContainmentCoherence, placeCountryThreshold: true/true/0.5 vs the shipped
	// false/false/0.9), so every unset-lever measurement graded a configuration production does not
	// ship. Comparisons where both arms shared the drift stayed internally valid; absolute numbers
	// did not. `resolve-config.test.ts` pins this function against the factory field by field.
	const production = createGeocodeCommandOptions()

	return {
		locale: config.locale ?? production.locale,
		countryScope: config.country_scope ?? production.countryScope,
		dataRoot: config.data_root ?? String(production.dataRoot),
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
 * Refuse a candidate weights root that would not actually be loaded.
 *
 * `resolveWeights` honours an explicit `cacheRoot` only when that directory holds `model.onnx` and `tokenizer.model`,
 * and otherwise walks on to the installed workspace package — which in this repo always resolves. So the failure mode
 * of a mis-typed or half-staged candidate is not an error: it is a full run of the SHIPPED model, reported under the
 * candidate's label, with every number plausible. `promotion-eval.ts` refuses the same way and for the same reason;
 * this is that guard on the warm path, sharing its check rather than re-deriving the layout.
 *
 * Runs BEFORE the session build, so a bad path costs a `stat` rather than the ~1.4 s construction.
 *
 * @throws When the root is wrong-shaped (no binaries) or under-staged (binaries present, but siblings its own card
 *   declares are missing — the #1516 shape, which degrades a channel silently and reads as a model regression).
 */
export async function assertWeightsCacheStaged(cacheRoot: string, locale = "en-us"): Promise<void> {
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
	const canonical = JSON.stringify(
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
	 * The model this engine actually loaded, and the ladder rung that produced it.
	 *
	 * Reported beside the config rather than derived from it, because the two can disagree in the one direction that
	 * matters: `weights_cache` names what was ASKED FOR, and only this says what answered.
	 */
	weights: { model_path: string; source: string } | null
}

/**
 * Resident engines, evicted least-recently-used first.
 *
 * The cap is small on purpose. `geocode-stream.ts:23-28` records the measurement that sets it: on a shared multi-GB WOF
 * SQLite, throughput peaked at 2 workers (~1.4×) and DEGRADED beyond — memory bandwidth and the shared database are the
 * ceiling, not core count. Two resident candidate gazetteers are already several GB before the ONNX sessions, so
 * holding more engines buys nothing and can cost the box.
 */
/**
 * What a tool needs from the engine registry.
 *
 * The tools take THIS, not {@linkcode EngineRegistry}, for one reason a test finds immediately: the class carries
 * private fields, so no object literal can ever be assignable to it, and every stub in this package's tests had to
 * assert through `unknown` — which then keeps compiling after a method is renamed or its signature changes, and the
 * stub silently stops standing for the thing it doubles. `OracleGeocoderLike` in `oracle-arm.ts` is the same idea,
 * arrived at earlier.
 */
export interface EngineRegistryLike {
	readonly repoRoot: string
	readonly bootFingerprint: TreeFingerprint
	readonly size: number
	readonly maxResident: number
	/**
	 * Whether the working tree has moved since this process imported its modules.
	 */
	sourceMoved(): Promise<boolean>
	/**
	 * The working tree's fingerprint RIGHT NOW — recomputed on every call, never cached.
	 */
	fingerprint(): Promise<TreeFingerprint>
	acquire(config: EngineConfig): Promise<Engine>
	evict(id: string): boolean
	evictAll(): number
	summaries(): EngineSummary[]
}

export class EngineRegistry implements EngineRegistryLike {
	readonly #engines = new Map<string, Engine>()
	readonly #maxResident: number
	readonly #repoRoot: string
	readonly #bootFingerprint: TreeFingerprint

	/**
	 * Compute the boot fingerprint, then construct. The boot fingerprint is the tree the PROCESS imported — not the tree
	 * any individual engine was built from. Those differ after a reload, and the difference is required: a registry with
	 * no resident engine has nothing stale to compare against, so without this the first call after a reload builds and
	 * stamps the NEW fingerprint onto answers produced by the OLD modules.
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
	 * The tree this process imported its modules from. Equality with {@link fingerprint} is the only condition under which
	 * any answer from this registry describes the source on disk.
	 */
	get bootFingerprint(): TreeFingerprint {
		return this.#bootFingerprint
	}

	/**
	 * Whether the working tree has moved since this process imported its modules. When true, every engine — resident or
	 * not yet built — can only serve the old code, and no in-process action can change that.
	 */
	async sourceMoved(): Promise<boolean> {
		return (await this.fingerprint()).digest !== this.#bootFingerprint.digest
	}

	fingerprint(): Promise<TreeFingerprint> {
		return computeTreeFingerprint(this.#repoRoot)
	}

	/**
	 * Get or build the engine for a configuration.
	 *
	 * @throws When a resident engine was built against different source. The refusal is the honest answer: Node cannot
	 *   evict an imported module, so "reloaded" would be a lie and serving the old code silently is the failure this
	 *   whole surface exists to prevent.
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

		// Refuse against the BOOT fingerprint, not merely against whatever is resident. A resident engine under a
		// different digest is one symptom of a moved tree; an EMPTY registry under a moved tree is the other, and it
		// is the dangerous one, because there is nothing stale left to notice. Both are the same fact — this process
		// cannot import the new source — so both refuse here.
		if (current.digest !== this.#bootFingerprint.digest) {
			throw new Error(staleEngineMessage(this.#bootFingerprint, current))
		}

		// After the stale-tree refusal (a moved tree invalidates every answer, candidate or not) and before the build,
		// so a mis-staged candidate costs a stat rather than a construction.
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
