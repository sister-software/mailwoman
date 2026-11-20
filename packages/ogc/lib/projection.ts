// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The projection from a geocode result to `/search` matches.
 *
 *   The result's coordinate is the first match, in the collection its tier names.
 *   The places the resolver weighed for the same part of the input follow,
 *   each in the collection its placetype names.
 */

import { formatAddress } from "@mailwoman/codex/address/format"
import type { ComponentDict } from "@mailwoman/codex/address/render"
import { matchCountry } from "@mailwoman/codex/country"
import type { GeocodeCandidate, GeocodeResult } from "@mailwoman/core/geocode"
import { type Ancestor, ScoreUnmeasuredReason, wofIDFromPlaceID } from "@mailwoman/core/resolver"

import { collectionOfPlacetype, collectionOfTier, OGCCollectionID } from "#collections"
import type { OGCSearchHit } from "#engine"

function hierarchyName(result: GeocodeResult, tag: string): string | null {
	return result.hierarchy.find((entry) => entry.tag === tag)?.name ?? null
}

/**
 * The resolved names, most specific first, with a repeated name dropped
 * and the country appended when the hierarchy doesn't name it.
 */
function hierarchyLabel(result: GeocodeResult): string {
	const names: string[] = []

	for (const { name } of result.hierarchy) {
		if (name && !names.includes(name)) {
			names.push(name)
		}
	}

	const country = matchCountry(result.countryCode)?.canonical

	if (names.length && country && !names.includes(country)) {
		names.push(country)
	}

	return names.join(", ")
}

/**
 * The one-line address of a house-grade or street-grade answer, in the country's own order.
 */
function addressLabel(result: GeocodeResult, withHouseNumber: boolean): string {
	const country = matchCountry(result.countryCode)

	const postcode = result.postcode ?? result.rooftop?.postcode ?? null
	const locality = hierarchyName(result, "locality") ?? result.locality
	const region = hierarchyName(result, "region") ?? result.region

	const components: ComponentDict = {
		...(withHouseNumber && result.house_number ? { house_number: result.house_number } : {}),
		...(result.street ? { street: result.street } : {}),
		...(result.unit && withHouseNumber ? { unit: result.unit } : {}),
		...(postcode ? { postcode } : {}),
		...(locality ? { locality } : {}),
		...(region ? { region } : {}),
		...(country?.canonical ? { country: country.canonical } : {}),
	}

	const formatted = country ? formatAddress(components, country.iso2, { singleLine: true, withRegion: true }) : ""

	// A country with no recorded layout renders an empty string, so the parts join in the order they were read.
	return formatted || Object.values(components).join(", ")
}

/**
 * The candidate the answer's coordinate came from, when the coordinate is a gazetteer place's.
 */
function answeringCandidate(result: GeocodeResult): GeocodeCandidate | null {
	if (result.resolution_tier !== "admin" && result.resolution_tier !== "postcode") return null

	return result.candidates.find((candidate) => candidate.lat === result.lat && candidate.lon === result.lon) ?? null
}

function scoreOf(candidate: GeocodeCandidate | null): Pick<OGCSearchHit, "score" | "scoreUnmeasured"> {
	if (candidate && typeof candidate.score === "number") return { score: candidate.score }

	return { score: null, scoreUnmeasured: candidate?.scoreUnmeasured ?? ScoreUnmeasuredReason.Unrecorded }
}

/**
 * Reads a gazetteer place's ancestors by WOF id, nearest first, as `ResolverBackend.ancestors` does.
 */
export type AncestorsOf = (wofID: number) => readonly Ancestor[]

/**
 * The fields of a gazetteer place its label reads.
 */
export type LabeledPlace = Pick<GeocodeCandidate, "name" | "placeID" | "countryCode">

/**
 * A gazetteer place's label: its name, the ancestors the gazetteer records between it
 * and its country, most specific first, and the country.
 *
 * `/search` labels its place matches with it, and `/collections/{collectionId}/items` its features.
 * A name repeated by an ancestor appears once.
 *
 * Without a WOF place ID or a recorded ancestry the label is the name and the country.
 */
export function placeLabel(candidate: LabeledPlace, ancestorsOf: AncestorsOf | undefined): string {
	const names = [candidate.name]
	const wofID = wofIDFromPlaceID(candidate.placeID)

	if (ancestorsOf && wofID != null) {
		for (const ancestor of ancestorsOf(wofID)) {
			if (ancestor.placetype !== "country" && ancestor.name && !names.includes(ancestor.name)) {
				names.push(ancestor.name)
			}
		}
	}

	const country = matchCountry(candidate.countryCode)?.canonical

	if (country && !names.includes(country)) {
		names.push(country)
	}

	return names.join(", ")
}

/**
 * The gazetteer identity of a place match, so two places that share a label stay apart.
 */
function placeIdentity(candidate: GeocodeCandidate): Pick<OGCSearchHit, "placeID" | "placetype"> {
	return { ...(candidate.placeID ? { placeID: candidate.placeID } : {}), placetype: candidate.placetype }
}

/**
 * The `/search` matches for one geocode result, best first.
 *
 * The answer's own coordinate comes first.
 * Its score is the resolver's score for the gazetteer place it came from.
 *
 * An answer placed by an address point, an interpolation or a street centroid
 * has no measured score, so its score is null.
 *
 * The places the resolver weighed for the same span as its first candidate follow, each with its own score.
 * The result lists at most 10 places for a span, so a call reads at most 10 ancestries.
 *
 * @param ancestorsOf The gazetteer's ancestry reader.
 * The label of each place lists the region and county it returns.
 * Absent, a place's label is its name and its country.
 * @returns An empty array when the result has no coordinate.
 */
export function geocodeSearchHits(result: GeocodeResult, ancestorsOf?: AncestorsOf): OGCSearchHit[] {
	const hits: OGCSearchHit[] = []
	const answering = answeringCandidate(result)
	const collectionID = collectionOfTier(result.resolution_tier)

	if (result.lat != null && result.lon != null && collectionID) {
		const houseGrade = collectionID === OGCCollectionID.Addresses

		if (houseGrade || collectionID === OGCCollectionID.Streets) {
			hits.push({
				collectionID,
				lon: result.lon,
				lat: result.lat,
				displayName: addressLabel(result, houseGrade),
				...scoreOf(answering),
			})
		} else {
			hits.push({
				collectionID,
				lon: result.lon,
				lat: result.lat,
				displayName: answering ? placeLabel(answering, ancestorsOf) : hierarchyLabel(result) || result.input.trim(),
				...scoreOf(answering),
				...(answering ? placeIdentity(answering) : {}),
			})
		}
	}

	const [first] = result.candidates

	if (!first) return hits

	// A place appears once, so the answer's own place and a place listed twice are skipped.
	// Two places at one coordinate stay two matches, because the place ID tells them apart.
	const seen = new Set<string>()
	const placeKey = (candidate: GeocodeCandidate) => candidate.placeID ?? `${candidate.lon},${candidate.lat}`

	if (answering) {
		seen.add(placeKey(answering))
	}

	for (const candidate of result.candidates) {
		if (candidate.tag !== first.tag || candidate.value !== first.value) continue

		const key = placeKey(candidate)

		if (seen.has(key)) continue

		seen.add(key)

		hits.push({
			collectionID: collectionOfPlacetype(candidate.placetype),
			lon: candidate.lon,
			lat: candidate.lat,
			displayName: placeLabel(candidate, ancestorsOf),
			...scoreOf(candidate),
			...placeIdentity(candidate),
		})
	}

	return hits
}
