/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reference geocoders as a comparison arm — metered, and never a grading truth.
 *
 *   `@mailwoman/geocode-oracle`'s own header is unambiguous about what this is for: *"Not truth, and not a gate …
 *   Nothing here should ever decide whether a build ships."* So an oracle arm always reports `grade: "diff-only"` and a
 *   null verdict, and its purpose is flagging rows for a human to read. That is enforced here rather than left to the
 *   caller, because a billed third-party geocoder quietly becoming an answer key is the exact failure the package was
 *   made private to prevent.
 *
 *   TWO PROVIDERS, TWO POSTURES (spec §7.3).
 *
 *   `census` is free, unauthenticated and US-only. It is allowed with no ceremony.
 *
 *   `google` is BILLED, and the opt-in deliberately does not live on the tool argument. A tool argument is set by
 *   whoever is driving the agent, which for a spend decision is the wrong signature — so it is read from the daemon's
 *   config file plus a per-lifetime call cap that the result reports as it consumes. An agent cannot talk its way into
 *   spending money; the operator has to have written it down first.
 */

import { existsSync, readFileSync } from "node:fs"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { dataRootPath } from "@mailwoman/core/utils"
import {
	createCensusGeocoderClient,
	createGoogleGeocoderClient,
	type OracleGeocodeResult,
} from "@mailwoman/geocode-oracle"

import type { ExternalAnswer } from "./external-arm.ts"

/**
 * Reference geocoders this arm can address.
 */
export const OracleProviderName = {
	/**
	 * US Census Bureau. Free, unauthenticated, US-only.
	 */
	Census: "census",
	/**
	 * Google Geocoding API. Billed per call — see the module docstring for why its opt-in is not a tool argument.
	 */
	Google: "google",
} as const

export type OracleProviderName = (typeof OracleProviderName)[keyof typeof OracleProviderName]

/**
 * Where the daemon reads its oracle opt-in. Under the data root rather than the repo: it names an operator's billing
 * posture on one machine, which is not a fact about the source tree and must never be committed.
 */
export const ORACLE_CONFIG_PATH = String(dataRootPath("dev-mcp", "oracle-config.json"))

/**
 * The shape of that file.
 *
 * ```json
 * { "google": { "enabled": true, "maxCallsPerDaemonLifetime": 500 } }
 * ```
 */
export interface OracleConfig {
	google?: {
		enabled?: boolean
		maxCallsPerDaemonLifetime?: number
	}
}

/**
 * Conservative default cap when the config enables Google without naming one. Chosen to cover one 420-row panel with
 * margin and nothing like a sweep — a cap that silently permits an unbounded run is not a cap.
 */
export const DEFAULT_GOOGLE_CALL_CAP = 500

export function readOracleConfig(path: string = ORACLE_CONFIG_PATH): OracleConfig {
	if (!existsSync(path)) return {}

	try {
		return parseJSONStrict<OracleConfig>(readFileSync(path, "utf8"))
	} catch {
		// A malformed config must not read as "enabled". Absence and garbage both mean off.
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
	 * Why, in the caller's terms. Populated on an allow as well as a refusal, so a log of oracle calls records the
	 * posture that was applied rather than only the ones that tripped it.
	 */
	reason: string
}

/**
 * Per-daemon-lifetime spend meter. Deliberately not persisted: a cap that survives a restart is a budget, and a budget
 * is the operator's to keep, not this process's to guess at.
 */
export class OracleMeter {
	#googleCalls = 0
	readonly #config: OracleConfig

	constructor(config: OracleConfig = readOracleConfig()) {
		this.#config = config
	}

	get googleCallsUsed(): number {
		return this.#googleCalls
	}

	get googleCap(): number {
		return this.#config.google?.maxCallsPerDaemonLifetime ?? DEFAULT_GOOGLE_CALL_CAP
	}

	/**
	 * Whether a provider may be called for `rows` more inputs.
	 *
	 * Checked BEFORE the run rather than per row, so a caller learns it cannot afford a 420-row panel before spending
	 * anything on the first 300 of it.
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
	 * Record spend, one per query this arm issued.
	 *
	 * A cache hit still counts. `GoogleGeocoderClient` caches under `$MAILWOMAN_DATA_ROOT/geocode-oracle/` and answers a
	 * repeat for free, but it hands back `OracleGeocodeResult[]` and never says which of those cost a request — the
	 * `cached` flag lives on the axios response inside `APIClient` and does not survive the client's own parsing. So the
	 * meter counts queries and over-counts a warm run. That is the direction to be wrong in: the failure it produces is
	 * refusing a run the cap could have afforded, and the alternative is a cap that undercounts real spend.
	 */
	recordGoogleCalls(count: number): void {
		this.#googleCalls += count
	}
}

/**
 * The grade an oracle arm forces, regardless of what the caller asked for.
 *
 * Not a default — a REFUSAL to grade, and it holds for every input set rather than per set. Two reasons, and the second
 * is why there is no carve-out for the sets it does not apply to:
 *
 * 1. The board's `expectLat`/`expectLon` are pinned by hand by whoever fixed the bug, with these same two geocoders open
 *    as a second opinion — that is the stated purpose of `@mailwoman/geocode-oracle`. Scoring an oracle against those
 *    points is therefore partly scoring it against itself.
 * 2. The package's own header says nothing there should ever decide whether a build ships. A rule with a list of sets it
 *    applies to becomes a rule about which set to pick.
 */
export const ORACLE_GRADE_MODE = "diff-only" as const

/**
 * Carried on every oracle comparison so the refusal to grade travels with the result.
 *
 * A reader who sees differing rows and no verdict, with no sentence saying why, will supply their own — and the one
 * they supply is a score.
 */
export const ORACLE_VERDICT_NOTE =
	"An oracle arm is never a grading truth, so this comparison is diff-only and its verdict is null however the " +
	"caller asked for it to be graded. Read the differing rows; do not read a score."

/**
 * What this module needs from a reference-geocoder client. Narrower than either real one on purpose: it is the
 * transport seam a test replaces, and a seam shaped like the whole client invites a test to assert its own idea of the
 * provider's protocol.
 */
export interface OracleGeocoderLike extends AsyncDisposable {
	geocodeOne(input: string): Promise<OracleGeocodeResult[]>
}

/**
 * Build the real client for a provider.
 *
 * NO PER-ARM NORMALIZATION. Google accepts a `country` hint and the input sets carry one, and it is deliberately not
 * passed: the pre-registered protocol sends the same raw query string to every arm, and a hint given to one side is the
 * per-arm rewriting that protocol exists to forbid. It would also flatter the oracle on exactly the bare-locality rows
 * where mailwoman's country scope is what is under examination.
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
 * HTTP status both clients raise for "this provider holds no match for that address".
 */
const HTTP_NOT_FOUND = 404

/**
 * Top-1 from a reference geocoder, projected onto the shape a cross-engine row is built from.
 *
 * A no-match becomes an answer with a reason rather than a throw, matching what every other arm does: the protocol
 * counts it a miss at every threshold, and it is a different fact from a query that failed. Anything else propagates,
 * so a dead key or an exhausted quota reaches `compare.ts`'s consecutive-failure abort instead of accumulating into a
 * row of misses that reads as an arm that lost.
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
		// The provider's own tier, reported and never thresholded — the same posture as an external engine's `layer` or
		// `addresstype`. These vocabularies were mapped onto ours by `@mailwoman/geocode-oracle`'s parsers, whose
		// judgement calls are exactly what `OracleGeocodeResult.raw` exists to let a human re-read.
		resultType: geocode.tier,
		noResultReason: null,
	}
}

/**
 * Provenance for an oracle arm — what answered, under what posture, and what it cost.
 *
 * `partial_match` and the cap state are here because they are the two things a reader needs before quoting a differing
 * row: Google sets the first when it fell back from the query it was given, and the second says whether the run was
 * complete or stopped at the ceiling.
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
