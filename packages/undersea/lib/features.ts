// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The browser asset the layer build writes for Earth, and the name index Earth searches it with.
 *
 *   The asset is one GeoJSON feature collection with one feature per gazetteer record.
 *   A line record keeps its line, so a map label can follow a trench.
 *
 *   A point or polygon record is reduced to its label point, and its bounding
 *   box is stored in the properties.
 *   The module reads no file and no network, so it runs in the browser and in Node alike.
 */

import { foldCaseWhitespace, stripCombiningMarks } from "@mailwoman/normalize/fold"

import type { UnderseaGeometryKind } from "#vocabulary"

/**
 * `[west, south, east, north]` in degrees.
 */
export type UnderseaBBox = [west: number, south: number, east: number, north: number]

/**
 * Which depth stands for a feature: the deepest sample for a depression such as a deep
 * or trench, the shallowest for a rise such as a seamount or bank.
 */
export type UnderseaDepthKind = "deepest" | "shallowest"

/**
 * The properties of one feature in the browser asset.
 */
export interface UnderseaFeatureProperties {
	/**
	 * The gazetteer's `FEATURE_ID`.
	 *
	 * A record can appear in more than one service layer under the same id, once per geometry kind.
	 */
	featureID: number
	/**
	 * The specific name, `NAME`.
	 */
	name: string
	/**
	 * The generic term, `TYPE`, such as `Trench` or `Seamount`.
	 */
	genericTerm: string
	/**
	 * The name and generic term joined, such as `Challenger Deep`.
	 */
	displayName: string
	/**
	 * The geometry kind the gazetteer published the record under.
	 */
	kind: UnderseaGeometryKind
	/**
	 * The label point, `[lon, lat]`.
	 *
	 * A line's point is its middle vertex, and a polygon's is a point inside its largest ring.
	 */
	labelPoint: [lon: number, lat: number]
	bbox: UnderseaBBox
	/**
	 * The feature's depth as a negative elevation in meters, read from the ETOPO1 grid in the terrain tiles.
	 *
	 * `null` when the generic term has no single depth, such as a fracture zone,
	 * or no sample lies below sea level.
	 */
	depthM: number | null
	/**
	 * Which extreme {@link UnderseaFeatureProperties.depthM} reports, or `null` alongside a `null` depth.
	 */
	depthKind: UnderseaDepthKind | null
}

/**
 * One feature in the browser asset.
 */
export interface UnderseaAssetFeature {
	type: "Feature"
	id: number
	geometry:
		| { type: "Point"; coordinates: [number, number] }
		| { type: "LineString"; coordinates: Array<[number, number]> }
	properties: UnderseaFeatureProperties
}

/**
 * The browser asset.
 */
export interface UnderseaAsset {
	type: "FeatureCollection"
	/**
	 * The citation GEBCO asks for.
	 */
	attribution: string
	/**
	 * The date the build read the service, `YYYY-MM-DD`.
	 */
	sourceVintage: string
	features: UnderseaAssetFeature[]
}

/**
 * A name's match key: diacritics removed, case and whitespace folded.
 */
export function underseaNameKey(name: string): string {
	return foldCaseWhitespace(stripCombiningMarks(name.normalize("NFD")))
}

/**
 * The order in which a record's geometry kinds stand for it when the gazetteer publishes more than one.
 *
 * A line or polygon records the feature's extent.
 * A point records only a position.
 */
const KIND_PREFERENCE: Record<UnderseaGeometryKind, number> = { line: 0, polygon: 1, point: 2 }

/**
 * Exact-name and prefix lookups over the browser asset.
 */
export class UnderseaIndex {
	readonly #byKey = new Map<string, UnderseaFeatureProperties[]>()
	readonly #keys: string[]

	constructor(asset: UnderseaAsset) {
		const seen = new Map<number, UnderseaFeatureProperties>()

		// One entry per gazetteer id, taken from the geometry kind that best records its extent.
		for (const feature of asset.features) {
			const held = seen.get(feature.properties.featureID)

			if (!held || KIND_PREFERENCE[feature.properties.kind] < KIND_PREFERENCE[held.kind]) {
				seen.set(feature.properties.featureID, feature.properties)
			}
		}

		for (const properties of seen.values()) {
			const key = underseaNameKey(properties.displayName)
			const entries = this.#byKey.get(key) ?? []

			entries.push(properties)
			this.#byKey.set(key, entries)
		}

		this.#keys = [...this.#byKey.keys()].toSorted()
	}

	/**
	 * The number of distinct display names.
	 */
	get size(): number {
		return this.#keys.length
	}

	/**
	 * Every feature whose display name equals the query after folding, ordered by gazetteer id.
	 *
	 * Two features can share a name, such as a canyon and a seamount in different oceans.
	 */
	match(query: string): UnderseaFeatureProperties[] {
		const entries = this.#byKey.get(underseaNameKey(query)) ?? []

		return entries.toSorted((left, right) => left.featureID - right.featureID)
	}

	/**
	 * Features whose display name starts with the query after folding, in name order.
	 *
	 * A query shorter than `minLength` characters returns no suggestions,
	 * because a two-letter prefix matches hundreds of seamounts.
	 */
	suggest(query: string, limit: number, minLength = 3): UnderseaFeatureProperties[] {
		const prefix = underseaNameKey(query)

		if (prefix.length < minLength) return []

		const results: UnderseaFeatureProperties[] = []

		for (let index = lowerBound(this.#keys, prefix); index < this.#keys.length; index++) {
			const key = this.#keys[index]!

			if (!key.startsWith(prefix)) break

			results.push(...this.#byKey.get(key)!)

			if (results.length >= limit) break
		}

		return results.slice(0, limit)
	}
}

/**
 * The first index whose key sorts at or after `target`.
 */
function lowerBound(keys: readonly string[], target: string): number {
	let low = 0
	let high = keys.length

	while (low < high) {
		const middle = (low + high) >>> 1

		if (keys[middle]! < target) {
			low = middle + 1
		} else {
			high = middle
		}
	}

	return low
}
