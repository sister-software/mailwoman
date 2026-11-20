// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Node decoration shared by the resolver walk and its post-walk passes,
 *   in its own module so the coherence passes do not import the walk.
 */

import type { AddressNode } from "@mailwoman/core/decoder"
import { isPresent } from "@mailwoman/core/objects"
import { EMPTY_PLACE_FIELDS, type ResolvedPlace, ScoreUnmeasuredReason } from "@mailwoman/core/resolver"

import type { CoordinateOptionalPlace } from "#postcode/prefix"

/**
 * The widest stored extent, in degrees, that's a single point: about 10 meters, narrower than any place.
 */
const POINT_EXTENT_DEGREES = 0.0001

/**
 * A resolved node has a real coordinate (placeID set + non-zero lat/lon).
 */
export function isResolvedWithCoord(n: AddressNode): boolean {
	return (
		typeof n.placeID === "string" &&
		typeof n.lat === "number" &&
		typeof n.lon === "number" &&
		(n.lat !== 0 || n.lon !== 0)
	)
}

/**
 * The metadata keys that describe the place a node resolved to, or that place's
 * relation to the node's parent.
 *
 * Each value is true of one place only.
 * A pass that replaces the place removes them, because the new place may supply none of them.
 */
export const PICK_METADATA_KEYS = [
	"resolver_score",
	"resolver_score_unmeasured",
	"resolver_name",
	"resolver_prominence",
	"resolver_country",
	"resolver_referential",
	"resolver_encyclopedic",
	"resolver_importance",
	"resolver_matched_alias",
	"resolver_bbox",
	"postcode_city_mismatch",
	"resolution_quality",
	"ancestors",
	"contained_by_parent",
	"admin_containment",
	"parent_fallback",
	"variant_alias_exemption",
	"county_designator_fallback",
] as const

/**
 * The most places {@linkcode decorateNode} keeps on a node's `considered` list.
 *
 * A default lookup retrieves 5 rows and the bare-toponym race adds 2, so 10 holds one
 * re-pick's displaced place and runner-ups beside the probe losers.
 * Passes that re-pick the same node repeatedly drop the oldest entries first.
 */
export const CONSIDERED_LIMIT = 10

/**
 * The place a resolver-decorated node holds, read back from its decoration, or null
 * when the node holds no located place with an identifier.
 *
 * `sourceID` is `<placetype>:<id>` as {@linkcode decorateNode} writes it.
 */
export function placeOfNode(node: AddressNode): ResolvedPlace | null {
	if (node.source !== "resolver" || !node.sourceID || !isResolvedWithCoord(node)) return null

	const separator = node.sourceID.indexOf(":")
	const rawID = node.sourceID.slice(separator + 1)

	if (separator < 1 || !rawID || rawID === "0") return null

	const meta = node.metadata ?? {}
	const number = (key: string): number | null => (typeof meta[key] === "number" ? (meta[key] as number) : null)
	const unmeasured = meta["resolver_score_unmeasured"]

	return {
		...EMPTY_PLACE_FIELDS,
		id: /^\d+$/u.test(rawID) ? Number(rawID) : rawID,
		name: typeof meta["resolver_name"] === "string" ? meta["resolver_name"] : node.value,
		placetype: node.sourceID.slice(0, separator),
		country: typeof meta["resolver_country"] === "string" ? meta["resolver_country"] : null,
		lat: node.lat!,
		lon: node.lon!,
		score: number("resolver_score") ?? 0,
		scoreUnmeasured:
			typeof unmeasured === "string"
				? (unmeasured as ScoreUnmeasuredReason)
				: number("resolver_score") == null
					? ScoreUnmeasuredReason.Unrecorded
					: null,
		prominence: number("resolver_prominence"),
		importance: number("resolver_importance"),
		...(meta["resolver_matched_alias"] ? { matchedAlias: true as const } : {}),
	}
}

/**
 * Stamp a node with resolver-supplied attribution, displacing any prior classifier `source`
 * / `sourceID` into `metadata.classifier_source` / `metadata.classifier_source_id`
 * and surfacing runner-up candidates on `alternatives`.
 *
 * A node the resolver already decorated keeps its classifier stamps as the first decoration wrote them.
 * When the new place differs from the one the node holds, the {@linkcode PICK_METADATA_KEYS}
 * and `alternatives` of the previous place are removed before the new place is written.
 *
 * The previous place and its alternatives move to `considered`, with the `considered`
 * places the caller passes, so the geocode result still reports them.
 * No ranking stage reads `considered`, so moving a place there changes no answer.
 */
export function decorateNode(
	node: AddressNode,
	resolved: CoordinateOptionalPlace,
	alternatives: ResolvedPlace[],
	considered: readonly ResolvedPlace[] = []
): void {
	let displaced: readonly unknown[] = []

	if (node.source === "resolver") {
		// A pass can decorate a node again with the place it already holds, and that place's stamps stay true.
		if (node.placeID !== `wof:${resolved.id}`) {
			displaced = [placeOfNode(node), ...(node.alternatives ?? [])].filter(isPresent)

			const meta = { ...node.metadata }

			for (const key of PICK_METADATA_KEYS) {
				// oxlint-disable-next-line typescript/no-dynamic-delete -- removing the listed keys from a copied plain record
				delete meta[key]
			}

			node.metadata = meta
			delete node.alternatives
		}
	} else if (node.source || node.sourceID) {
		const meta = { ...node.metadata }

		if (node.source) {
			meta["classifier_source"] = node.source
		}

		if (node.sourceID) {
			meta["classifier_source_id"] = node.sourceID
		}

		node.metadata = meta
	}

	node.source = "resolver"
	node.sourceID = `${resolved.placetype}:${resolved.id}`

	// `0,0` is the gazetteer's unlocated sentinel, so an unlocated place gets both coordinates
	// cleared rather than a coordinate that satisfies every `lat != null` guard downstream.
	const located = resolved.lat != null && resolved.lon != null && (resolved.lat !== 0 || resolved.lon !== 0)

	if (located) {
		node.lat = resolved.lat
		node.lon = resolved.lon
	} else {
		delete node.lat
		delete node.lon
	}

	node.placeID = `wof:${resolved.id}` // v1: only WOF resolvers. the URI scheme stays this simple
	node.metadata = { ...node.metadata, resolver_score: resolved.score, resolver_name: resolved.name }

	// Additive metadata only.
	// No part of the resolve reads it back.
	if (resolved.prominence != null) {
		node.metadata["resolver_prominence"] = resolved.prominence
	}

	// `resolver_score` keeps the ranking key the passes compare.
	// This stamp records that the key is unmeasured.
	if (resolved.scoreUnmeasured) {
		node.metadata["resolver_score_unmeasured"] = resolved.scoreUnmeasured
	}

	if (resolved.country) {
		node.metadata["resolver_country"] = resolved.country
	}

	// Written only when the backend supplies a value, because `resolver_*: 0`
	// would assert an unmeasured value.
	if (resolved.referential != null) {
		node.metadata["resolver_referential"] = resolved.referential
	}

	if (resolved.encyclopedic != null) {
		node.metadata["resolver_encyclopedic"] = resolved.encyclopedic
	}

	if (resolved.importance != null) {
		node.metadata["resolver_importance"] = resolved.importance
	}

	if (resolved.matchedAlias) {
		node.metadata["resolver_matched_alias"] = true
	}

	// A point-only row stores its coordinate as both corners, and a row stored
	// in single precision can hold them a few millionths of a degree apart,
	// so only an extent wider than that measures the place's size.
	const bbox = resolved.bbox

	if (bbox && (bbox.maxLat - bbox.minLat > POINT_EXTENT_DEGREES || bbox.maxLon - bbox.minLon > POINT_EXTENT_DEGREES)) {
		node.metadata["resolver_bbox"] = bbox
	}

	// The postcode pointed to a geographically different place than the parsed city name,
	// surfaced so callers can warn rather than silently trust the resolved point.
	if (resolved.mismatch) {
		node.metadata["postcode_city_mismatch"] = true
	}

	// A broader admin tier stood in for the true region/county because no exact-type candidate existed.
	// Additive annotation only.
	if (resolved.resolutionQuality) {
		node.metadata["resolution_quality"] = resolved.resolutionQuality
	}

	if (alternatives.length) {
		node.alternatives = alternatives
	}

	const kept = consideredPlaces([...considered, ...displaced, ...(node.considered ?? [])], resolved.id, alternatives)

	if (kept.length) {
		node.considered = kept
	} else {
		delete node.considered
	}
}

/**
 * The places of `candidates` that aren't the node's pick or one of its alternatives,
 * first occurrence of each identifier kept, at most {@linkcode CONSIDERED_LIMIT}.
 */
function consideredPlaces(
	candidates: readonly unknown[],
	pickID: number | string,
	alternatives: readonly ResolvedPlace[]
): unknown[] {
	const seen = new Set([String(pickID), ...alternatives.map((a) => String(a.id))])
	const kept: unknown[] = []

	for (const candidate of candidates) {
		const id = (candidate as Partial<ResolvedPlace> | null)?.id

		if (id == null || seen.has(String(id))) continue

		seen.add(String(id))
		kept.push(candidate)

		if (kept.length === CONSIDERED_LIMIT) break
	}

	return kept
}
