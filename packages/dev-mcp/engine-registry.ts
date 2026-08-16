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
 *   win — while the socket, the supervisor and the fork protocol are deferred. The costs are real and are paid
 *   explicitly: eviction returns less RSS than killing a worker would, and there is no in-process module reload, which
 *   is why {@link EngineRegistry.acquire} REFUSES on a source edit rather than pretending to reload (see
 *   `tree-fingerprint.ts`). Building the supervisor is the right next step if warmth across agent restarts proves to
 *   matter; it is not needed to test whether a warm engine changes which panel gets measured.
 */

import { createHash } from "node:crypto"

import { mailwomanDataRoot } from "@mailwoman/core/utils"
import { createGeocodeSession, type GeocodeSession, type GeocodeSessionOptions } from "mailwoman/geocode-session"

import { computeTreeFingerprint, staleEngineMessage, type TreeFingerprint } from "./tree-fingerprint.ts"

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
	gazetteer_prior?: boolean
	place_country?: boolean
	place_country_threshold?: number
	postcode_country_coherence?: boolean
	fork_entity?: boolean
	locale_country_prior?: boolean
	postcode_shape_coherence?: boolean
	postcode_containment_coherence?: boolean
	retry_alternate_register?: boolean
	/**
	 * Record the decode-path evidence on every run. OFF by default and left off by the measuring tools: the trace is kept
	 * per run, so it is a per-row cost paid only where the evidence is the answer.
	 */
	trace?: boolean
}

/**
 * The session options a config resolves to, with every default made explicit.
 *
 * Resolving before recording is what makes a confound check possible at all. Two arms whose STATED configs differ in
 * one field can differ in three effective ones — `--country-scope auto` means "scope on FTS, no scope on candidate"
 * (`docs/engineering/reference/resolver-backends.mdx`), so switching backend also switches country scoping. A
 * comparison that reads stated configs cannot see that; one that reads effective configs can.
 */
export function resolveConfig(config: EngineConfig): GeocodeSessionOptions {
	return {
		locale: config.locale ?? "en-US",
		countryScope: config.country_scope ?? "auto",
		dataRoot: config.data_root ?? String(mailwomanDataRoot()),
		localeCountryPrior: config.locale_country_prior ?? false,
		placeCountry: config.place_country ?? true,
		postcodeCountryCoherence: config.postcode_country_coherence ?? true,
		forkEntity: config.fork_entity ?? true,
		postcodeShapeCoherence: config.postcode_shape_coherence ?? true,
		postcodeContainmentCoherence: config.postcode_containment_coherence ?? true,
		placeCountryThreshold: config.place_country_threshold ?? 0.5,
		...(config.gazetteer_prior === undefined ? {} : { gazetteerPrior: config.gazetteer_prior }),
		...(config.retry_alternate_register === undefined
			? {}
			: { retryAlternateRegister: config.retry_alternate_register }),
		...(config.default_country ? { defaultCountry: config.default_country } : {}),
		...(config.bias ? { bias: config.bias } : {}),
		...(config.candidate_db ? { candidateDB: config.candidate_db } : {}),
		...(config.resolve_db ? { resolveDB: config.resolve_db } : {}),
		...(config.trace ? { trace: true } : {}),
	}
}

export function engineID(effective: GeocodeSessionOptions, fingerprint: TreeFingerprint): string {
	const canonical = JSON.stringify(
		Object.fromEntries(
			Object.entries(effective as unknown as Record<string, unknown>).toSorted(([a], [b]) => a.localeCompare(b))
		)
	)

	return createHash("sha256").update(`${canonical}\n${fingerprint.digest}`).digest("hex").slice(0, 16)
}

export interface Engine {
	engineID: string
	session: GeocodeSession
	effective: GeocodeSessionOptions
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
}

/**
 * Resident engines, evicted least-recently-used first.
 *
 * The cap is small on purpose. `geocode-stream.ts:23-28` records the measurement that sets it: on a shared multi-GB WOF
 * SQLite, throughput peaked at 2 workers (~1.4×) and DEGRADED beyond — memory bandwidth and the shared database are the
 * ceiling, not core count. Two resident candidate gazetteers are already several GB before the ONNX sessions, so
 * holding more engines buys nothing and can cost the box.
 */
export class EngineRegistry {
	readonly #engines = new Map<string, Engine>()
	readonly #maxResident: number
	readonly #repoRoot: string

	constructor(repoRoot: string, maxResident = 2) {
		this.#repoRoot = repoRoot
		this.#maxResident = maxResident
	}

	get repoRoot(): string {
		return this.#repoRoot
	}

	fingerprint(): TreeFingerprint {
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
		const current = this.fingerprint()
		const effective = resolveConfig(config)
		const id = engineID(effective, current)
		const existing = this.#engines.get(id)

		if (existing) {
			existing.lastUsed = Date.now()

			existing.uses++

			return existing
		}

		// A resident engine under a DIFFERENT fingerprint means the tree moved since it was built. Its id can never
		// match again, so it would simply leak; refuse loudly instead, and name both fingerprints.
		const stale = [...this.#engines.values()].find((engine) => engine.fingerprint.digest !== current.digest)

		if (stale) throw new Error(staleEngineMessage(stale.fingerprint, current))

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

		engine.session.close()
		this.#engines.delete(id)

		return true
	}

	/**
	 * Close every engine. Named `reload` at the tool surface because that is what a caller wants; what it actually does
	 * is drop the sessions so the next call rebuilds. It cannot re-import source — see the class docstring.
	 */
	closeAll(): number {
		const count = this.#engines.size

		// Close then clear, rather than evicting key by key: deleting from a Map mid-iteration is well defined but
		// subtle, and a shutdown path is the wrong place to make a reader verify that.
		for (const engine of this.#engines.values()) {
			engine.session.close()
		}

		this.#engines.clear()

		return count
	}

	summaries(): EngineSummary[] {
		return [...this.#engines.values()].map((engine) => ({
			engine_id: engine.engineID,
			locale: engine.effective.locale,
			config_effective: engine.effective as unknown as Record<string, unknown>,
			build_ms: engine.buildMs,
			last_used_iso: new Date(engine.lastUsed).toISOString(),
			uses: engine.uses,
			tree_fingerprint: engine.fingerprint.digest,
		}))
	}

	get size(): number {
		return this.#engines.size
	}

	get maxResident(): number {
		return this.#maxResident
	}
}
