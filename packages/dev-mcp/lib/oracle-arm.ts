/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reference geocoders as a comparison arm — metered, and never a grading truth.
 *
 *   An oracle arm always reports `grade: "diff-only"` and a null verdict, and its purpose is flagging rows for a human to
 *   read. That is enforced here rather than left to the caller, because a billed third-party geocoder quietly becoming an
 *   answer key is the exact failure `@mailwoman/geocode-oracle` was made private to prevent.
 *
 *   `census` is free, unauthenticated and US-only, and allowed with no ceremony.
 *
 *   `google` is billed, and its opt-in deliberately does not live on the tool argument: a spend decision belongs to
 *   whoever owns the key, not to whoever is driving the agent, so it is read from the daemon's config file plus a
 *   per-lifetime call cap that the result reports as it consumes.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import {
	createCensusGeocoderClient,
	createGoogleGeocoderClient,
	type OracleGeocodeResult,
} from "@mailwoman/geocode-oracle"
import type { PathBuilderLike } from "path-ts"

import type { ExternalAnswer } from "#external-arm"

/**
 * Reference geocoders this arm can address.
 */
export const OracleProviderName = {
	/**
	 * Free, unauthenticated, US-only.
	 */
	Census: "census",
	/**
	 * Billed per call; its opt-in is not a tool argument (see the module docstring).
	 */
	Google: "google",
} as const

export type OracleProviderName = (typeof OracleProviderName)[keyof typeof OracleProviderName]

/**
 * Under the data root rather than the repo: it names an operator's billing posture on one
 * machine, which is not a fact about the source tree and must never be committed.
 */
const ORACLE_CONFIG_PATH = dataRootPath("dev-mcp", "oracle-config.json")

/**
 * The shape of that file, e.g. `{ "google": { "enabled": true, "maxCallsPerDaemonLifetime": 500 } }`.
 */
export interface OracleConfig {
	google?: {
		enabled?: boolean
		maxCallsPerDaemonLifetime?: number
	}
}

/**
 * Chosen to cover one 420-row panel with margin and to come nowhere near a sweep;
 * a cap that silently permits an unbounded run is not a cap.
 */
export const DEFAULT_GOOGLE_CALL_CAP = 500

export async function readOracleConfig(path: PathBuilderLike = ORACLE_CONFIG_PATH): Promise<OracleConfig> {
	if (!(await pathExists(path))) return {}

	try {
		return await readLocalJSONFile<OracleConfig>(path)
	} catch {
		// A malformed config must not read as "enabled": absence and garbage both mean off.
		return {}
	}
}

export interface OracleAdmission {
	allowed: boolean
	provider: OracleProviderName
	/**
	 * Remaining calls for this daemon's lifetime, or `null` when the provider is free and uncapped.
	 */
	callsRemaining: number | null
	/**
	 * Populated on an allow as well as a refusal, so a log records the posture applied
	 * rather than only the refusals.
	 */
	reason: string
}

/**
 * Deliberately not persisted: a cap that survives a restart is a budget, and a budget
 * is the operator's to keep rather than this process's to guess at.
 */
export class OracleMeter {
	#googleCalls = 0
	readonly #config: OracleConfig

	constructor(config: OracleConfig) {
		this.#config = config
	}

	/**
	 * The constructor cannot await the config read, so this static factory does it.
	 */
	static async create(config?: OracleConfig): Promise<OracleMeter> {
		return new OracleMeter(config ?? (await readOracleConfig()))
	}

	get googleCallsUsed(): number {
		return this.#googleCalls
	}

	get googleCap(): number {
		return this.#config.google?.maxCallsPerDaemonLifetime ?? DEFAULT_GOOGLE_CALL_CAP
	}

	/**
	 * Checked before the run rather than per row, so a caller learns it cannot afford
	 * a 420-row panel before spending anything on the first 300 of it.
	 */
	admit(provider: OracleProviderName, rows: number): OracleAdmission {
		if (provider === OracleProviderName.Census) {
			return {
				allowed: true,
				provider,
				callsRemaining: null,
				reason: "The Census geocoder is free and unauthenticated. US-only — a non-US row is a miss, not an error.",
			}
		}

		if (!this.#config.google?.enabled) {
			return {
				allowed: false,
				provider,
				callsRemaining: 0,
				reason:
					`The Google oracle is BILLED and is not enabled. Enable it in ${ORACLE_CONFIG_PATH} with ` +
					'`{"google":{"enabled":true}}`. The opt-in is deliberately not a tool argument: a spend decision ' +
					"belongs to whoever owns the key, not to whoever is driving the agent.",
			}
		}

		const remaining = this.googleCap - this.#googleCalls

		if (rows > remaining) {
			return {
				allowed: false,
				provider,
				callsRemaining: remaining,
				reason:
					`This run needs ${rows} Google calls and ${remaining} remain of this daemon's ${this.googleCap}-call ` +
					"cap. Refusing before spending rather than part way through, so a partial arm never gets graded as a whole one.",
			}
		}

		return {
			allowed: true,
			provider,
			callsRemaining: remaining,
			reason: `Google enabled; ${remaining} of ${this.googleCap} calls remain for this daemon's lifetime.`,
		}
	}

	/**
	 * A cache hit still counts: the client answers a repeat for free but hands
	 * back `OracleGeocodeResult[]` and never says which of those cost a request,
	 * so the meter counts queries and over-counts a warm run — the direction to be wrong in,
	 * because the alternative is a cap that undercounts real spend.
	 */
	recordGoogleCalls(count: number): void {
		this.#googleCalls += count
	}
}

/**
 * Not a default but a refusal to grade, holding for every input set rather than per set:
 * the board's `expectLat`/ `expectLon` are pinned by hand with these same geocoders open as
 * a second opinion, so scoring against them is partly scoring the oracle against itself,
 * and a rule with a list of sets it applies to becomes a rule about which set to pick.
 */
export const ORACLE_GRADE_MODE = "diff-only"

/**
 * A reader who sees differing rows and no verdict, with no sentence saying why,
 * will supply their own, and the one they supply is a score.
 */
export const ORACLE_VERDICT_NOTE =
	"An oracle arm is never a grading truth, so this comparison is diff-only and its verdict is null however the " +
	"caller asked for it to be graded. Read the differing rows; do not read a score."

/**
 * Narrower than either real client on purpose: it is the transport interface a
 * test replaces, and an injection point shaped like the whole client invites a
 * test to assert its own idea of the provider's protocol.
 */
export interface OracleGeocoderLike extends AsyncDisposable {
	geocodeOne(input: string): Promise<OracleGeocodeResult[]>
}

/**
 * No per-arm normalization: Google accepts a `country` hint and the input sets carry one,
 * but the pre-registered protocol sends the same raw query string to every arm, and a hint
 * given to one side is the per-arm rewriting that protocol forbids — flattering the oracle
 * on exactly the bare-locality rows where mailwoman's country scope is under examination.
 */
export function createOracleClient(provider: OracleProviderName): OracleGeocoderLike {
	if (provider === OracleProviderName.Census) {
		const client = createCensusGeocoderClient()

		return {
			geocodeOne: (input) => client.lookupAddress(input),
			[Symbol.asyncDispose]: () => client[Symbol.asyncDispose](),
		}
	}

	const client = createGoogleGeocoderClient()

	return {
		geocodeOne: (input) => client.geocodeAddress(input),
		[Symbol.asyncDispose]: () => client[Symbol.asyncDispose](),
	}
}

/**
 * Http status both clients raise for "this provider holds no match for that address".
 */
const HTTP_NOT_FOUND = 404

/**
 * A no-match becomes an answer with a reason rather than a throw, matching every other arm
 * because the protocol counts it a miss at every threshold and it is a different fact from
 * a query that failed; anything else propagates, so a dead key or exhausted quota reaches
 * `compare.ts`'s consecutive-failure abort instead of reading as an arm that lost.
 */
export async function answerFromOracle(client: OracleGeocoderLike, input: string): Promise<ExternalAnswer> {
	let results: OracleGeocodeResult[]

	try {
		results = await client.geocodeOne(input)
	} catch (error) {
		if ((error as { status?: unknown }).status === HTTP_NOT_FOUND) {
			return {
				lat: null,
				lon: null,
				label: null,
				resultType: null,
				noResultReason: `the provider holds no match: ${(error as Error).message}`,
			}
		}

		throw error
	}

	const top = results[0]
	const geocode = top?.address.geocode

	if (!top || !geocode) {
		return { lat: null, lon: null, label: null, resultType: null, noResultReason: "the provider returned no match" }
	}

	return {
		lat: geocode.coordinate.latitude,
		lon: geocode.coordinate.longitude,
		label: top.address.formatted ?? null,
		// The provider's own tier, reported and never thresholded — the same posture
		// as an external engine's `layer` or `addresstype`.
		// The mapping onto our vocabulary is `@mailwoman/geocode-oracle`'s judgement call,
		// which `OracleGeocodeResult.raw` exists to let a human re-read.
		resultType: geocode.tier,
		noResultReason: null,
	}
}

/**
 * Provenance for an oracle arm — what answered, under what posture, and what it cost;
 * `partial_match` and the cap state say whether the run was complete or stopped at the ceiling.
 */
export interface OracleArmIdentity {
	arm: "oracle"
	provider: OracleProviderName
	grade_mode: typeof ORACLE_GRADE_MODE
	calls_admitted: number
	calls_remaining: number | null
	admission_reason: string
	warnings: string[]
}
