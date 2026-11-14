// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Shared utilities for the `wof-admin` / `wof-postalcode` GeoJSON-bundle adapters.
 *
 * They read the per-record bundles published as
 * `github.com/whosonfirst-data/whosonfirst-data-{admin,postalcode}-<cc>` repos:
 * a tree of `data/<3>/<3>/<3>/<wof-id>.geojson` files plus alternate-geometry siblings
 * like `<id>-alt-quattroshapes.geojson`, of which only the canonical record is consumed.
 *
 * `is_current` semantics follow WOF + Pelias: `mz:is_current` ∈ {`1`, `-1`} are live and `0` is superseded.
 * WOF's official postalcode distribution stamps every row `-1` ("unknown but treated as active"),
 * so an `is_current = 1` filter silently emits zero rows from the real corpus.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { tryParsingJSON } from "@mailwoman/core/json"
import { resolveModulePath } from "@mailwoman/core/module/resolvers"
import { agreedHierarchyAncestors } from "@mailwoman/gazetteer/whosonfirst/hierarchy"

/**
 * A WOF GeoJSON feature, as published by the per-record bundles.
 */
export interface WOFFeature {
	type?: string
	id?: number | string
	properties?: Record<string, unknown> | null
}

/**
 * Lightweight in-memory shape both adapters keep per record.
 *
 * Geometry is intentionally dropped because the adapters never consult it.
 */
export interface WOFRecord {
	id: number
	parent_id: number | null
	name: string
	placetype: string
	/**
	 * ISO 3166-1 alpha-2 from `wof:country`, upper-cased on read.
	 *
	 * The standard's codes are upper case.
	 * The publisher's spelling can differ.
	 *
	 * A consumer such as the `--country NL` filter compares the two strings directly.
	 */
	country: string
	/**
	 * Localized name variants from `name:*` properties.
	 *
	 * Keys are the raw `name:eng_x_preferred` form.
	 * A key whose array holds one distinct value maps to that string, and a key with several
	 * maps to all of them in source order: New York City's `name:eng_x_colloquial` lists
	 * Big Apple, Gotham and NYC. {@linkcode nameValues} reads either shape.
	 *
	 * The single-value case stays a string because an admin run holds over 13 million records resident.
	 * This representation avoids allocating an array when a key has one value.
	 *
	 * The canonical `wof:name` isn't included — adapters add a synthetic `"default"` slot for it.
	 */
	nameVariants: Map<string, string | readonly string[]>
	/**
	 * Ancestor ids from `wof:hierarchy`, nearest level first, keeping only the levels on
	 * which every hierarchy the record lists agrees.
	 *
	 * New York City lists five hierarchies, one per county, so its county is left out
	 * and its region and country stay.
	 * Empty when the record lists no hierarchy, in which case the parent chain answers.
	 */
	ancestors: readonly number[]
}

/**
 * `mz:is_current` ∈ {`1`, `-1`} → keep, `0` → drop.
 *
 * Real WOF postalcode distros tag every row `-1` ("unknown but treated as active") and the
 * Pelias importer accepts `-1` alongside `1`; tightening the predicate to `= 1` makes the
 * postalcode distros contribute zero rows to the corpus, silently, with no error to notice it by.
 */
export function isCurrentFeature(props: Record<string, unknown>): boolean {
	const raw = props["mz:is_current"]
	const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : 1

	return n !== 0
}

/**
 * Pull `name:*` localized variants off a WOF feature's properties, keeping every distinct non-blank
 * value of the array WOF stores them in (`["Saint Petersburg"]`), with attestations removed.
 */
export function extractNameVariants(props: Record<string, unknown>): Map<string, string | readonly string[]> {
	const out = new Map<string, string | readonly string[]>()

	for (const [key, value] of Object.entries(props)) {
		if (!key.startsWith("name:")) continue

		const values = nonBlankStrings(value)

		if (values.length === 1) {
			out.set(key, values[0]!)
		} else if (values.length) {
			out.set(key, values)
		}
	}

	return out
}

/**
 * Every value one `name:*` key holds, in source order.
 */
export function nameValues(value: string | readonly string[] | undefined): readonly string[] {
	if (value == null) return []

	return typeof value === "string" ? [value] : value
}

/**
 * The first `name:<language>_x_preferred` value of a record, or `null` when the record has none.
 *
 * `language` is the ISO 639-3 code WOF keys its names by (`jpn`, `kor`).
 */
export function preferredName(record: WOFRecord, language: string): string | null {
	return nameValues(record.nameVariants.get(`name:${language}_x_preferred`))[0] ?? null
}

/**
 * A historical attestation that some Who's On First names append after the name itself.
 *
 * `[a. 1240]` (and `[~ a. 1000]` for an approximate year) records the year a place is first attested.
 * It isn't written in an address, so a corpus row that keeps it teaches the model
 * a locality that ends in a bracketed date.
 */
const ATTESTATION = /\s*\[\s*~?\s*a\.\s*\d{1,4}\s*\]/gu

/**
 * Removes historical attestations from a Who's On First name and trims the result.
 */
export function stripAttestation(name: string): string {
	return name.replaceAll(ATTESTATION, "").trim()
}

function nonBlankStrings(value: unknown): string[] {
	const out: string[] = []

	for (const candidate of Array.isArray(value) ? value : [value]) {
		if (typeof candidate !== "string") continue

		const normalized = stripAttestation(candidate)

		if (normalized && !out.includes(normalized)) {
			out.push(normalized)
		}
	}

	return out
}

/**
 * Turn a `name:*` property key into a hyphen-safe suffix fragment for `source_id`
 * (`"name:eng_x_colloquial"` → `"name-eng-x-colloquial"`); both `:` and `_` become `-`
 * because both collide with the separator vocabulary downstream consumers split on.
 */
export function normalizeNameKey(rawKey: string): string {
	return rawKey.replaceAll(/[:_]/g, "-")
}

const SLOT_KEY = /^name-([a-z]+)(?:-[A-Za-z0-9]+)*?(?:-x-([a-z]+))?(?:-[0-9]+)?$/

/**
 * The kind and language of a WOF name-slot key, the TypeScript twin of {@linkcode wofNameSlotSQL}.
 *
 * `default` reads as kind and language `default`; `name-rus-x-preferred-2` as `preferred`
 * and `rus`; a `name-<language>` key without `-x-` as kind `unmarked`.
 */
export function parseWOFSlotKey(key: string): { kind: string; language: string } {
	const match = SLOT_KEY.exec(key)

	if (!match) return { kind: "default", language: "default" }

	return { kind: match[2] ?? "unmarked", language: match[1]! }
}

/**
 * DuckDB expressions that read a WOF row's name slot back out of its `source_id`.
 *
 * A WOF `source_id` is `<adapter>-<record id>-<slot key>-<variant suffix>`.
 * The slot key is `default` or a {@linkcode normalizeNameKey} form such as
 * `name-rus-x-preferred` or `name-und-x-variant-2`.
 *
 * `kind` is `default` or the part after `-x-` (`preferred`, `variant`, `colloquial`…),
 * and `unmarked` for a `name-<language>` key without one.
 * `language` is `default` or the key's ISO 639 code.
 */
export function wofNameSlotSQL(sourceID = "source_id"): { kind: string; language: string } {
	const named = `regexp_matches(${sourceID}, '-[0-9]+-name-')`

	return {
		kind:
			`CASE WHEN ${named} THEN coalesce(nullif(regexp_extract(${sourceID}, ` +
			`'-[0-9]+-name-[a-z]+(?:-[A-Za-z0-9]+)*?-x-([a-z]+)', 1), ''), 'unmarked') ELSE 'default' END`,
		language: `CASE WHEN ${named} THEN regexp_extract(${sourceID}, '-[0-9]+-name-([a-z]+)', 1) ELSE 'default' END`,
	}
}

/**
 * Parse a single GeoJSON feature; `null` means skip this row for any reason.
 */
export function recordFromFeature(feature: WOFFeature, refutedParents: ReadonlySet<number>): WOFRecord | null {
	if (!feature || feature.type !== "Feature" || !feature.properties) return null
	const props = feature.properties

	const rawID = typeof feature.id === "number" ? feature.id : props["wof:id"]
	const id = typeof rawID === "number" ? rawID : typeof rawID === "string" ? Number(rawID) : Number.NaN

	if (!Number.isFinite(id)) return null

	const rawName = props["wof:name"]
	const name = typeof rawName === "string" ? stripAttestation(rawName) : ""

	if (!name) return null

	const placetype = props["wof:placetype"]

	if (typeof placetype !== "string" || !placetype) return null

	const rawCountry = props["wof:country"]

	if (typeof rawCountry !== "string" || !rawCountry) return null

	const country = rawCountry.toUpperCase()

	if (!isCurrentFeature(props)) return null

	const parentRaw = props["wof:parent_id"]

	const parent_id =
		typeof parentRaw === "number"
			? parentRaw
			: typeof parentRaw === "string" && parentRaw.trim()
				? Number(parentRaw)
				: null

	// A record with no location, or whose point lies in another parent's polygon,
	// keeps its own name and none of its ancestors.
	const placed = !isAtOrigin(props) && !refutedParents.has(id)

	return {
		id,
		parent_id: placed && Number.isFinite(parent_id as number) ? (parent_id as number) : null,
		name,
		placetype,
		country,
		nameVariants: extractNameVariants(props),
		ancestors: placed ? agreedHierarchyAncestors(id, props["wof:hierarchy"]) : [],
	}
}

/**
 * The committed list of WOF records whose point lies over 1 km outside their parent's
 * polygon and inside another polygon of the parent's placetype.
 */
export const REFUTED_PARENTS_PATH = resolveModulePath("@mailwoman/corpus/data/wof-refuted-parents.json")

let refutedParentIDs: Promise<ReadonlySet<number>> | undefined

/**
 * The ids in {@linkcode REFUTED_PARENTS_PATH}, read once per process.
 */
export function readRefutedParentIDs(): Promise<ReadonlySet<number>> {
	refutedParentIDs ??= readLocalJSONFile<{ records: Array<{ id: number }> }>(REFUTED_PARENTS_PATH).then(
		(file) => new Set(file.records.map((record) => record.id))
	)

	return refutedParentIDs
}

/**
 * Whether a WOF record's representative point is exactly latitude 0, longitude 0,
 * the value WOF writes for a record that has no geometry.
 *
 * The parent of such a record was not found by location.
 * WOF assigns 347 Spanish postcodes from every province, including Soria's `42002`,
 * to the village of Melgar de Yuso.
 */
export function isAtOrigin(props: Record<string, unknown>): boolean {
	return props["geom:latitude"] === 0 && props["geom:longitude"] === 0
}

/**
 * The record one GeoJSON file holds, or `null` when the file is unreadable, malformed or skipped.
 *
 * The single-record explorer reads its record and ancestors through this.
 */
export async function readFeatureRecord(filePath: string): Promise<WOFRecord | null> {
	let text: string

	try {
		text = await readLocalTextFile(filePath)
	} catch {
		return null
	}

	const parsed = tryParsingJSON<WOFFeature>(text)

	return parsed ? recordFromFeature(parsed, await readRefutedParentIDs()) : null
}

/**
 * The component tags a variant builder looks an ancestor up by.
 *
 * `variantsFor` reads the nearest `locality`, `subregion` (county), `region`
 * and `country` ancestor, with its localized and colloquial names.
 * `postcodeVariantsFor` reads the nearest `locality`, `region` and `country`.
 */
export const ANCESTOR_NAME_TAGS = ["locality", "subregion", "region", "country"] as const

/**
 * The nearest ancestor's `wof:name` per tag in {@linkcode ANCESTOR_NAME_TAGS}.
 *
 * A tag with no ancestor has no key.
 * `ancestry.find(…) === undefined` expresses that state.
 */
export type AncestorNames = Partial<Record<(typeof ANCESTOR_NAME_TAGS)[number], string>>

/**
 * The nearest ancestor record per tag in {@linkcode ANCESTOR_NAME_TAGS}.
 *
 * The admin adapter reads an ancestor's localized names from it.
 * Each value is a record the index already holds, so it copies no name.
 */
export type AncestorRecords = Partial<Record<(typeof ANCESTOR_NAME_TAGS)[number], WOFRecord>>

/**
 * Each ancestor record's `wof:name`, per tag.
 *
 * `wof-postalcode` renders a postcode's hierarchy from these names and reads no other ancestor field.
 */
export function ancestorNamesOf(records: AncestorRecords): AncestorNames {
	const names: AncestorNames = {}

	for (const tag of ANCESTOR_NAME_TAGS) {
		const name = records[tag]?.name

		if (name) {
			names[tag] = name
		}
	}

	return names
}

/**
 * The nearest ancestor record per tag in {@linkcode ANCESTOR_NAME_TAGS} for one record.
 *
 * `lookup` returns a record the reader kept, or `undefined`.
 * `tagOf` maps a WOF placetype to a component tag, or returns a value outside
 * {@linkcode ANCESTOR_NAME_TAGS} for a placetype no builder looks up.
 *
 * It is a parameter because `placetypeToTag` lives with the adapters and this module doesn't import them.
 *
 * The `wof:hierarchy` levels are read first, then the parent chain.
 * The chain stops at the first id `lookup` cannot return, and at any re-visit.
 * Only a corrupt fixture holds a cycle.
 *
 * A record whose ancestors are absent resolves the tags it can reach rather than failing.
 */
export function ancestorRecordsOf(
	rec: WOFRecord,
	lookup: (id: number) => WOFRecord | undefined,
	tagOf: (placetype: string) => string | null | undefined
): AncestorRecords {
	const names: AncestorRecords = {}

	const claim = (ancestor: WOFRecord): void => {
		const tag = tagOf(ancestor.placetype)

		for (const wanted of ANCESTOR_NAME_TAGS) {
			if (tag === wanted && !names[wanted]) {
				names[wanted] = ancestor
			}
		}
	}

	// `wof:hierarchy` names every ancestor level directly, including for a record whose parent is -4.
	for (const ancestorID of rec.ancestors) {
		const ancestor = lookup(ancestorID)

		if (ancestor) {
			claim(ancestor)
		}
	}

	const guard = new Set<number>([rec.id])
	let cur: number | null = rec.parent_id

	while (cur !== null && cur > 0) {
		const parent = lookup(cur)

		if (!parent || guard.has(parent.id)) break
		claim(parent)
		guard.add(parent.id)
		cur = parent.parent_id
	}

	return names
}
