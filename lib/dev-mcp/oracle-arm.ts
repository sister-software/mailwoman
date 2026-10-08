/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reference geocoders provide a metered comparison arm. They never supply grading truth.
 *
 *   An oracle arm always reports `grade: "diff-only"` and a null verdict. It flags rows for a human to read.
 *   The harness enforces this behavior because a billed third-party geocoder must not become an answer key.
 *
 *   `census` is free and unauthenticated. It covers the United States, so callers can use it without extra setup.
 *
 *   `google` incurs a charge. Its opt-in lives in a daemon config file because the key owner controls spending.
 *   The result reports the call cap for that daemon's lifetime. Tool arguments cannot opt in to billed requests.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import {
	createCensusGeocoderClient,
	createGoogleGeocoderClient,
	type OracleGeocodeResult,
} from "@mailwoman/geocode-oracle"
import type { PathBuilderLike } from "path-ts"

import type { ExternalAnswer } from "#dev-mcp/external-arm"

/**
 * Reference geocoders this arm can address.
 */
export const OracleProviderName = {
	/**
	 * Free, unauthenticated, US-only.
	 */
	Census: "census",
	/**
	 * Billed per call.
	 *
	 * Its opt-in lives in the daemon's config file (see the module docstring).
	 */
	Google: "google",
} as const

export type OracleProviderName = (typeof OracleProviderName)[keyof typeof OracleProviderName]

/**
 * The config lives under the data root.
 *
 * It records one machine's billing settings and belongs outside the source tree.
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
 * Chosen to cover one 420-row panel with margin and to come nowhere near a sweep.
 * A cap that silently permits an unbounded run is not a cap.
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
	 * Calls left for this daemon's lifetime, or `null` when the provider is free and uncapped.
	 */
	callsRemaining: number | null
	/**
	 * Populated on an allow as well as a refusal, so a log records the posture applied
	 * rather than only the refusals.
	 */
	reason: string
}

/**
 * The call cap resets when the process restarts.
 *
 * The operator owns the budget.
 * The process does not infer it.
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
	 * A cache hit still counts: the client answers a repeat for free but hands back
	 * `OracleGeocodeResult[]` and never identifies which of those cost a request,
	 * so the meter counts queries and over-counts a warm run — the direction to be wrong in,
	 * because the alternative is a cap that undercounts real spend.
	 */
	recordGoogleCalls(count: number): void {
		this.#googleCalls += count
	}
}

/**
 * The mode refuses grading for every input set.
 *
 * The board's expected coordinates were pinned by hand with these geocoders open as a second opinion.
 * A score over those coordinates would partly score an oracle against itself.
 *
 * A refusal limited to some sets would make set selection part of the rule.
 */
export const ORACLE_GRADE_MODE = "diff-only"

/**
 * A reader may interpret differing rows as a score when the output gives no verdict or explanation.
 */
export const ORACLE_VERDICT_NOTE =
	"An oracle arm is never a grading truth, so this comparison is diff-only and its verdict is null however the " +
	"caller asked for it to be graded. Read the differing rows; do not read a score."

/**
 * This test interface exposes only the transport call that a test replaces.
 *
 * A whole-client injection could lead a test to assert a fabricated version of the provider's protocol.
 */
export interface OracleGeocoderLike extends AsyncDisposable {
	geocodeOne(input: string): Promise<OracleGeocodeResult[]>
}

/**
 * The protocol sends the same raw query string to every arm.
 *
 * Google accepts a `country` hint.
 * Input sets contain one.
 *
 * The call omits the hint so it cannot rewrite one arm's query.
 * The protocol compares the same input, including bare-locality rows where country scope is under test.
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
 * A no-match becomes an answer with a reason rather than a throw, matching every other arm because the
 * protocol counts it a miss at every threshold and it is a different fact from a query that failed.
 *
 * Anything else propagates, so a dead key or exhausted quota reaches `compare.ts`'s
 * consecutive-failure abort instead of reading as an arm that lost.
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
		// The provider's tier-to-vocabulary mapping is its own judgment call.
		// `raw` lets a human inspect the original result.
		resultType: geocode.tier,
		noResultReason: null,
	}
}

/**
 * Provenance for an oracle arm: provider, posture and cost.
 *
 * The record preserves `partial_match` for the consumer to interpret.
 * The cap state shows whether the run was complete or stopped at the ceiling.
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
