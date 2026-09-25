/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import { ogr2ogrGeoJSONSeq } from "@mailwoman/spatial/tools/ogr-stream"
import { createNewlineWriter } from "spliterator"

import {
	buildSubVenueSQL,
	distinctSubVenueTagKeys,
	matchSubVenueTagRule,
	type SubVenueTagRule,
	type SubVenueTier,
	SUBVENUE_LAYERS,
	SUBVENUE_TAG_RULES,
} from "#sdk/extract/subvenue/rules"
import { representativePoint } from "#sdk/representative-point"
import { tagAlias } from "#sdk/tag-columns"

/**
 * This module re-exports the sub-venue tag rules and SQL helpers for callers that customize rules.
 */
export {
	buildSubVenueSQL,
	distinctSubVenueTagKeys,
	matchSubVenueTagRule,
	type SubVenueTagRule,
	SubVenueTier,
	SUBVENUE_TAG_RULES,
} from "#sdk/extract/subvenue/rules"

/**
 * Parses GDAL's `other_tags` hstore text (`"key"=>"value",...`) into a plain object.
 * Missing input yields an empty object.
 *
 * The parser scans quoted strings because OSM values such as names often contain commas.
 */
export function parseOSMHstore(text: string | null | undefined): Record<string, string> {
	const out: Record<string, string> = {}

	if (!text) return out

	let i = 0

	const readQuoted = (): string | null => {
		while (i < text.length && text[i] !== '"') {
			i++
		}

		if (i >= text.length) return null

		i++

		let value = ""

		while (i < text.length) {
			const ch = text[i]!

			if (ch === "\\") {
				if (i + 1 < text.length) {
					value += text[i + 1]
				}

				i += 2

				continue
			}

			if (ch === '"') {
				i++

				return value
			}

			value += ch

			i++
		}

		return value
	}

	while (i < text.length) {
		const key = readQuoted()

		if (key === null) break

		const value = readQuoted()

		if (value === null) break
		out[key] = value
	}

	return out
}

const NON_LANGUAGE_NAME_SUFFIXES = new Set([
	"left",
	"right",
	"prefix",
	"suffix",
	"signed",
	"source",
	"etymology",
	"pronunciation",
	"abbreviation",
	"botanical",
	"carto",
])

const LANGUAGE_SUBTAG = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/

/**
 * Collects the `name:<lang>` tags, keyed by the language subtag as OSM wrote it.
 */
export function harvestLocalizedNames(tags: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const out: Record<string, string> = {}

	for (const [key, value] of Object.entries(tags)) {
		if (!value || !key.startsWith("name:")) continue

		const subtag = key.slice("name:".length)

		if (NON_LANGUAGE_NAME_SUFFIXES.has(subtag) || !LANGUAGE_SUBTAG.test(subtag)) continue
		out[subtag] = value
	}

	return out
}

/**
 * One extracted transport structure, such as a platform or gate.
 */
export interface SubVenueSourceRow {
	/**
	 * The matched rule's designator, such as `terminal`, `gate`, `platform` or `airport`.
	 */
	designatorID: string
	tier: SubVenueTier

	/**
	 * The `name` tag.
	 *
	 * It is `null` for an unnamed feature, which is common for a gate with only a `ref`.
	 */
	name: string | null

	/**
	 * The `ref` tag, such as `A12` in `Gate A12`.
	 * OSM usually keeps this identifier out of `name`.
	 */
	ref: string | null

	/**
	 * The value of each `name:<lang>` tag, keyed by language subtag.
	 */
	localizedNames: Record<string, string>
	latitude: number
	longitude: number

	/**
	 * The matched rule's tag as `key=value`, kept as provenance for the lexicon.
	 */
	matchedTag: string

	/**
	 * The country code.
	 *
	 * The extractor always leaves it empty because a PBF feature does not carry its country.
	 * The caller fills it in.
	 */
	country: string
}

/**
 * Converts one ogr2ogr GeoJSONSeq feature into a {@link SubVenueSourceRow}.
 *
 * It returns `null` when the feature matches no rule, lacks usable geometry,
 * or has no `name`, `ref` or `name:<lang>` tag.
 */
export function toSubVenueSourceRow(
	feature: { properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } },
	rules: readonly SubVenueTagRule[],
	tagKeys: readonly string[]
): SubVenueSourceRow | null {
	const p = feature.properties ?? {}
	const hstore = parseOSMHstore(typeof p["other_tags"] === "string" ? p["other_tags"] : null)
	const tags: Record<string, string | undefined> = { ...hstore }

	for (const key of tagKeys) {
		const raw = p[tagAlias(key)]

		if (raw != null && raw !== "") {
			tags[key] = String(raw)
		}
	}

	const rule = matchSubVenueTagRule(tags, rules)

	if (!rule) return null

	const pt = representativePoint(feature.geometry)

	if (!pt) return null

	const rawName = p["name"] ?? tags["name"]
	const rawRef = p["ref"] ?? tags["ref"]
	const name = rawName != null && rawName !== "" ? String(rawName) : null
	const ref = rawRef != null && rawRef !== "" ? String(rawRef) : null
	const localizedNames = harvestLocalizedNames(tags)

	if (!name && !ref && !Object.keys(localizedNames).length) return null

	const matched = rule.all.find(([key]) => tags[key] !== undefined) ?? rule.all[0]!

	return {
		designatorID: rule.designatorID,
		tier: rule.tier,
		name,
		ref,
		localizedNames,
		longitude: pt[0],
		latitude: pt[1],
		matchedTag: `${matched[0]}=${matched[1]}`,
		country: "",
	}
}

async function* runSubVenueLayer(
	pbfPath: string,
	layer: string,
	rules: readonly SubVenueTagRule[]
): AsyncGenerator<SubVenueSourceRow> {
	const tagKeys = distinctSubVenueTagKeys(rules)
	const sql = buildSubVenueSQL(layer, rules)
	const args = ["-f", "GeoJSONSeq", "/vsistdout/", "-dialect", "OGRSQL", "-sql", sql, pbfPath]

	for await (const feature of ogr2ogrGeoJSONSeq<{
		properties?: Record<string, unknown>
		geometry?: { type?: string; coordinates?: unknown }
	}>(args, `osm sub-venue (${layer})`)) {
		const row = toSubVenueSourceRow(feature, rules, tagKeys)

		if (row) {
			yield row
		}
	}
}

/**
 * Streams every named transport structure that matches `rules` from the `points`
 * and `multipolygons` layers of a `.osm.pbf` extract.
 *
 * A feature mapped as both a node and an area appears twice with different coordinates.
 * Consumers that need unique features must remove the duplicates.
 */
export async function* extractOSMSubVenues(
	pbfPath: string,
	rules: SubVenueTagRule[] = SUBVENUE_TAG_RULES
): AsyncIterable<SubVenueSourceRow> {
	for (const layer of SUBVENUE_LAYERS) {
		yield* runSubVenueLayer(pbfPath, layer, rules)
	}
}

/**
 * Options for {@link writeSubVenueJSONL}.
 */
export interface WriteSubVenueJSONLOptions {
	pbfPath: string
	outPath: string

	/**
	 * The ISO 3166-1 alpha-2 code written onto every row.
	 * The features do not carry a country.
	 */
	country?: string
	rules?: SubVenueTagRule[]
}

/**
 * Extracts sub-venue rows from one `.osm.pbf` file, writes them as JSONL and returns the row count.
 */
export async function writeSubVenueJSONL(options: WriteSubVenueJSONLOptions): Promise<number> {
	await using out = createNewlineWriter(options.outPath)
	let rows = 0

	for await (const row of extractOSMSubVenues(options.pbfPath, options.rules)) {
		if (options.country) {
			row.country = options.country
		}

		await out.write(stringifyJSON(row))

		rows++
	}

	return rows
}
