/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The FST binary-format constants, shared by the Node serializer/deserializer (`fst-serialize.ts`)
 *   and the browser deserializer (`fst-deserialize-web.ts`). Platform-free by design — no Buffer at
 *   module scope; both runtimes convert {@link FST_MAGIC_BYTES} themselves.
 */

import type { PlacetypeID } from "#fst/types"

/**
 * Format version this tree WRITES and the maximum either deserializer accepts, published so a freshness guard can call
 * an older artifact format-stale without re-typing the number (mirrors `REQUIRED_PAIR_INDEX_SCHEMA`'s role for PIX1 —
 * see `fst-freshness.ts`).
 *
 * ONE constant for the writer and both readers, deliberately. The browser reader's acceptance gate was a SEPARATE
 * `MAX_VERSION` number from the layout branches, and it drifted twice: left stale at 2 when the v4 wide-state layout
 * shipped (rejecting every real artifact), and stale again at 4 through the v5 two-score split until the line moved by
 * hand. A gate that is the writer's version cannot drift from it.
 */
export const FST_FORMAT_VERSION = 5

/**
 * Fixed header size in bytes: magic, version, and the section offsets that follow it.
 */
export const HEADER_SIZE = 32

/**
 * Edge-table entry: the transition label and the target state index.
 */
export const EDGE_ENTRY_SIZE = 8

/**
 * Format version that widened the per-state edge and place counters from 16 to 32 bits, growing the state entry from 12
 * to 16 bytes. Readers branch on it to stay backward-compatible with v2/v3 files.
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
 * First format version carrying the trailing metadata block; older files simply have none.
 */
export const VERSION_WITH_METADATA = 3

/**
 * Format version that split the single `importance` float into `referential` + `encyclopedic` (ROAD_TO_V9 §2 R1),
 * growing the place entry from 56 to 60 bytes and claiming the previously-reserved `pp+7` byte as
 * {@link PLACE_FLAG_HAS_ENCYCLOPEDIC}.
 */
export const VERSION_TWO_SCORE_SPLIT = 5

/**
 * Place-entry size in bytes at or above {@link VERSION_TWO_SCORE_SPLIT}.
 */
export const SPLIT_PLACE_ENTRY_SIZE = 60

/**
 * Place-entry size in bytes below {@link VERSION_TWO_SCORE_SPLIT}.
 */
export const LEGACY_PLACE_ENTRY_SIZE = 56

/**
 * Byte offset of the encyclopedic float inside a v5 place entry — immediately after the 8-slot parent chain.
 */
export const ENCYCLOPEDIC_OFFSET = 56

/**
 * `placeFlags` bit 0 (byte `pp+7`, v5+): this place carries an encyclopedic score. Per-PLACE rather than per-file
 * because absence is the common case — roughly 89% of the 2026-08-05 gazetteer has no Wikipedia article — and a
 * file-level flag would force every one of those rows to claim a 0 it never had.
 */
export const PLACE_FLAG_HAS_ENCYCLOPEDIC = 1

/**
 * File magic, "FST\0" as bytes. A reader rejects anything not starting with these four bytes before parsing further.
 */
export const FST_MAGIC_BYTES: readonly number[] = [0x46, 0x53, 0x54, 0x00]

/**
 * Placetypes in hierarchy order, largest first. The index into this array is what gets written into a place entry, so
 * REORDERING IT BREAKS EVERY EXISTING FILE — append instead, and bump the version.
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
