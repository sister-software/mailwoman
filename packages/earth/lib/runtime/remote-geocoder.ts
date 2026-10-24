/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The client for the hosted native API. The engine runs the classifier, the gazetteer cascade and the
 *   street tiers. The browser sends the address and renders the answer, so it downloads no model, FST or
 *   gazetteer database.
 */

import type { GeocodeBiasPoint, GeocodeResponse } from "@mailwoman/api/operations/geocode/address"
import { type AddressTree, flattenTreeNodes } from "@mailwoman/core/decoder"
import type { GeocodeCandidate } from "@mailwoman/core/geocode"
import { stringifyJSON, tryParsingJSON } from "@mailwoman/core/json"
import type { EngineStamp } from "@mailwoman/core/license"
import { isPresent } from "@mailwoman/core/objects"
import type { ParseResult, ResolvedPlaceView } from "@mailwoman/core/pipeline/client-result"

/**
 * The progress labels {@link remoteGeocode} reports through `onStage`.
 */
export const REMOTE_PARSE_STAGE_LABELS = ["Sending the address to the geocoder API…", "Reading the response…"]

/**
 * A native API response the client could not use: a non-2xx status or a body that is not JSON.
 */
export class RemoteGeocoderError extends Error {
	readonly status: number

	constructor(route: string, status: number, detail: string) {
		super(`${route} answered ${status}: ${detail}`)
		this.name = "RemoteGeocoderError"
		this.status = status
	}
}

type Stamped<T> = T & { engine?: EngineStamp }

async function postJSON<T>(apiURL: URL, route: string, body: unknown, signal?: AbortSignal): Promise<T> {
	const response = await fetch(new URL(route.replace(/^\//, ""), apiURL), {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: stringifyJSON(body),
		signal,
	})

	const text = await response.text()
	// Every native response body is a JSON object, so `null` means the body did not parse.
	const parsed = tryParsingJSON(text)

	if (parsed == null) {
		throw new RemoteGeocoderError(route, response.status, `unreadable body: ${text.slice(0, 200)}`)
	}

	if (!response.ok) {
		const { error, detail } = parsed as { error?: string; detail?: string | null }

		throw new RemoteGeocoderError(route, response.status, [error, detail].filter(isPresent).join(": ") || text)
	}

	return parsed as T
}

/**
 * The numeric Who's On First ID in a `wof:<id>` place URI, or 0 for any other source.
 *
 * Earth's candidate views use 0 for a place that has no gazetteer record, such as a street-tier pin.
 */
function wofNumber(placeID: string | null): number {
	const match = placeID?.match(/^wof:(\d+)$/)

	return match ? Number(match[1]) : 0
}

/**
 * The tiers whose coordinate comes from a register row or a computed point rather than a gazetteer place.
 */
const NON_GAZETTEER_TIERS = new Set<GeocodeResponse["resolution_tier"]>([
	"address_point",
	"interpolated",
	"venue",
	"plus_code",
])

function candidateView(candidate: GeocodeCandidate): ResolvedPlaceView {
	return {
		id: wofNumber(candidate.placeID),
		name: candidate.name,
		placetype: candidate.tag,
		lat: candidate.lat,
		lon: candidate.lon,
		score: candidate.score,
		bbox: null,
		tier: null,
		uncertaintyM: null,
	}
}

/**
 * Project a native geocode answer onto Earth's candidate list, with the answer's coordinate first.
 *
 * A gazetteer answer keeps its winning candidate's score.
 * A street, venue or plus-code answer is a point the gazetteer did not rank, so it reads `null`.
 */
export function candidatesFromGeocode(response: GeocodeResponse): ResolvedPlaceView[] {
	const ranked = response.candidates.map(candidateView)

	if (response.lat == null || response.lon == null) return ranked

	const tier = response.resolution_tier
	const street = [response.house_number, response.street].filter(isPresent).join(" ")
	const gazetteerAnswer = !NON_GAZETTEER_TIERS.has(tier)
	const top = gazetteerAnswer ? response.candidates[0] : undefined

	const answer: ResolvedPlaceView = {
		id: top ? wofNumber(top.placeID) : 0,
		name: top?.name ?? response.entity?.name ?? (street || response.input),
		placetype: top?.tag ?? tier,
		lat: response.lat,
		lon: response.lon,
		score: top?.score ?? null,
		bbox: null,
		tier: tier === "address_point" || tier === "interpolated" ? tier : null,
		uncertaintyM: response.uncertainty_m,
	}

	return [answer, ...(top ? ranked.slice(1) : ranked)]
}

/**
 * Geocode one address through the hosted native API in one request.
 *
 * The request asks for the decoded tree, so the response holds the spans and confidences
 * the parse view renders beside the coordinate and the candidates.
 * `bias` holds the points the resolver prefers candidates near, such as the
 * viewport center and the device location.
 */
export async function remoteGeocode(
	apiURL: URL,
	input: string,
	bias: readonly GeocodeBiasPoint[],
	hooks: { onStage: (stage: number) => void },
	signal?: AbortSignal
): Promise<{ result: ParseResult; engine: EngineStamp | null }> {
	hooks.onStage(0)

	const response = await postJSON<Stamped<GeocodeResponse>>(
		apiURL,
		"/v1/geocode",
		{ address: input, bias, include_tree: true },
		signal
	)

	hooks.onStage(1)

	if (!response.tree) {
		throw new RemoteGeocoderError("/v1/geocode", 200, "the response omitted the requested tree")
	}

	const tree = response.tree as AddressTree
	const candidates = candidatesFromGeocode(response)

	return {
		result: {
			input,
			tree,
			nodes: flattenTreeNodes(tree).map((node) => ({
				tag: node.tag,
				value: node.value,
				confidence: node.confidence,
				start: node.start,
				end: node.end,
			})),
			kindResult: null,
			timing: null,
			resolved: candidates[0] ?? null,
			candidates,
			fstActive: false,
			fstProvenance: null,
			dualRoles: null,
		},
		engine: response.engine ?? null,
	}
}
