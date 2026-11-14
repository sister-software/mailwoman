// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The FST binary-format constants, shared by the Node serializer/deserializer
 *   (`fst-serialize.ts`) and the browser deserializer (`fst-deserialize-web.ts`).
 *
 *   This module stays platform-free.
 *   It uses no Buffer at module scope.
 *   Both runtimes convert {@link FST_MAGIC_BYTES} themselves.
 */

import type { PlaceEntry, PlacetypeID } from "#fst/types"

/**
 * Format version this tree writes and the maximum either deserializer accepts, published
 * so a freshness guard can call an older artifact format-stale without re-typing the number
 * (mirrors `REQUIRED_PAIR_INDEX_SCHEMA`'s role for PIX1 — see `fst-freshness.ts`).
 *
 * One constant for the writer and both readers, deliberately.
 * The browser reader once kept a separate `MAX_VERSION` from the layout branches.
 *
 * It drifted twice.
 * It stayed at 2 after the v4 wide-state layout shipped and rejected every real artifact.
 *
 * It later stayed at 4 through the v5 two-score split until someone updated it by hand.
 *
 * A check that's the writer's version cannot drift from it.
 */
export const FST_FORMAT_VERSION = 6

/**
 * Fixed header size in bytes.
 *
 * It stores the magic and version, followed by section offsets.
 */
export const HEADER_SIZE = 32

/**
 * Edge-table entry: the transition label and the target state index.
 */
export const EDGE_ENTRY_SIZE = 8

/**
 * Format version that widened the per-state edge and place counters from 16 to 32 bits,
 * growing the state entry from 12 to 16 bytes.
 *
 * Readers branch on it to stay backward-compatible with v2/v3 files.
 */
export const VERSION_WIDE_STATE_COUNTERS = 4

/**
 * State-table entry size in bytes at or above {@link VERSION_WIDE_STATE_COUNTERS}.
 */
export const WIDE_STATE_ENTRY_SIZE = 16

/**
 * State-table entry size in bytes below {@link VERSION_WIDE_STATE_COUNTERS}.
 */
export const NARROW_STATE_ENTRY_SIZE = 12

/**
 * First format version carrying the trailing metadata block.
 * Older files have none.
 */
export const VERSION_WITH_METADATA = 3

/**
 * Format version that split the single `importance` float into `referential` +
 * `encyclopedic` (ROAD_TO_V9 §2 R1), growing the place entry from 56 to 60 bytes
 * and claiming the previously-reserved `pp+7` byte as {@link PLACE_FLAG_HAS_ENCYCLOPEDIC}.
 */
export const VERSION_TWO_SCORE_SPLIT = 5

/**
 * Place-entry size in bytes at or above {@link VERSION_TWO_SCORE_SPLIT}.
 */
const SPLIT_PLACE_ENTRY_SIZE = 60

/**
 * Place-entry size in bytes below {@link VERSION_TWO_SCORE_SPLIT}.
 */
const LEGACY_PLACE_ENTRY_SIZE = 56

/**
 * Format version that moved WOF ids into an id table.
 *
 * A place entry's id and its parent ids are u32 indices into the table.
 * The table follows the place table as a u32 count and one f64 per distinct id in ascending order.
 *
 * The `mailwoman` fork's WOF records take ids from 9,895,000,000, above the u32 maximum of 4,294,967,295.
 *
 * An f64 holds every integer up to 2^53 exactly.
 * Each distinct id is stored once, so a file grows by 8 bytes per distinct id
 * rather than by 36 bytes per place entry.
 */
export const VERSION_ID_TABLE = 6

/**
 * The number of parent-id slots in every place entry.
 */
export const PARENT_CHAIN_SLOTS = 8

/**
 * Where each field of a place entry sits, in bytes from the entry's start, for one format version.
 */
export interface PlaceEntryLayout {
	size: number
	/**
	 * Whether the id fields hold indices into the id table ({@link VERSION_ID_TABLE}) rather than WOF ids.
	 */
	idTable: boolean
	placetype: number
	chainLength: number
	crossCountryBranches: number
	flags: number
	name: number
	referential: number
	latitude: number
	longitude: number
	chain: number
	/**
	 * `null` before {@link VERSION_TWO_SCORE_SPLIT}, which had no encyclopedic score.
	 */
	encyclopedic: number | null
}

/**
 * The place-entry layout of format `version`.
 */
export function placeEntryLayout(version: number): PlaceEntryLayout {
	return {
		size: version >= VERSION_TWO_SCORE_SPLIT ? SPLIT_PLACE_ENTRY_SIZE : LEGACY_PLACE_ENTRY_SIZE,
		idTable: version >= VERSION_ID_TABLE,
		placetype: 4,
		chainLength: 5,
		crossCountryBranches: 6,
		flags: 7,
		name: 8,
		referential: 12,
		latitude: 16,
		longitude: 20,
		chain: 24,
		encyclopedic: version >= VERSION_TWO_SCORE_SPLIT ? 24 + PARENT_CHAIN_SLOTS * 4 : null,
	}
}

/**
 * The byte offset of the id table.
 * The table starts where the place table ends.
 */
export function idTableOffset(placeTableStart: number, placeCount: number, layout: PlaceEntryLayout): number {
	return placeTableStart + placeCount * layout.size
}

/**
 * The WOF ids an id-table file stores, in table order, or `null` for a file
 * before {@link VERSION_ID_TABLE}.
 */
export function loadIDTable(view: DataView, offset: number, layout: PlaceEntryLayout): Float64Array | null {
	if (!layout.idTable) return null
	const count = view.getUint32(offset, true)
	const ids = new Float64Array(count)

	for (let index = 0; index < count; index++) {
		ids[index] = view.getFloat64(offset + 4 + index * 8, true)
	}

	return ids
}

/**
 * Decodes the place entry at byte `entry` of a format-`version` file.
 *
 * Both deserializers call this, so a layout change reaches the Node and the browser readers together.
 * `string` resolves a string-table index.
 *
 * `ids` is the file's id table, `null` before {@link VERSION_ID_TABLE}.
 * `hasAmbiguity` is the header's flag bit 0.
 */
export function decodePlaceEntry(
	view: DataView,
	entry: number,
	version: number,
	layout: PlaceEntryLayout,
	hasAmbiguity: boolean,
	string: (index: number) => string,
	ids: Float64Array | null
): PlaceEntry {
	const readID = (offset: number) => {
		const value = view.getUint32(entry + offset, true)

		return ids ? ids[value]! : value
	}

	const chainLength = view.getUint8(entry + layout.chainLength)
	const parentChain: number[] = new Array(chainLength)

	for (let index = 0; index < chainLength; index++) {
		parentChain[index] = readID(layout.chain + index * 4)
	}

	// Version 1 stored a raw population u32 where later versions store the referential score.
	// It maps through the `referentialFromPopulation` curve.
	const referential =
		version >= 2
			? view.getFloat32(entry + layout.referential, true)
			: Math.min(1, Math.log2(1 + view.getUint32(entry + layout.referential, true) / 1000) / 14)

	// Files before version 5 have no encyclopedic score, so their reserved flag byte isn't read.
	const hasEncyclopedic =
		layout.encyclopedic !== null &&
		(view.getUint8(entry + layout.flags) & PLACE_FLAG_HAS_ENCYCLOPEDIC) === PLACE_FLAG_HAS_ENCYCLOPEDIC

	return {
		wofID: readID(0),
		placetype: PLACETYPE_ORDER[view.getUint8(entry + layout.placetype)] ?? "locality",
		name: string(view.getUint32(entry + layout.name, true)),
		referential,
		lat: view.getFloat32(entry + layout.latitude, true),
		lon: view.getFloat32(entry + layout.longitude, true),
		parentChain,
		crossCountryBranches: hasAmbiguity ? view.getUint8(entry + layout.crossCountryBranches) : null,
		encyclopedic: hasEncyclopedic ? view.getFloat32(entry + layout.encyclopedic!, true) : null,
	}
}

/**
 * `placeFlags` bit 0 (byte `pp+7`, v5+): this place has an encyclopedic score.
 *
 * Per-place rather than per-file because absence is the common case — roughly 89% of
 * the 2026-08-05 gazetteer has no Wikipedia article — and a file-level flag would
 * force every one of those rows to claim a 0 it never had.
 */
export const PLACE_FLAG_HAS_ENCYCLOPEDIC = 1

/**
 * File magic, "FST\0" as bytes.
 *
 * A reader rejects anything not starting with these four bytes before parsing further.
 */
export const FST_MAGIC_BYTES: readonly number[] = [0x46, 0x53, 0x54, 0x00]

/**
 * Placetypes in hierarchy order, largest first.
 *
 * The writer stores each placetype's index in a place entry.
 * A different array order invalidates every existing file.
 * Append entries and bump the version.
 */
export const PLACETYPE_ORDER: readonly PlacetypeID[] = [
	"country",
	"region",
	"county",
	"locality",
	"localadmin",
	"borough",
	"neighbourhood",
	"postalcode",
	"campus",
	"dependency",
	"street_affix",
]
