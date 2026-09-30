/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node reader for `nsul.db` — the GB uprn → unit-postcode register (`nsul/schema.ts`). Two probes,
 *   both synchronous `.prepare()` hits in the `uprn/lookup.ts` style:
 *
 *   - **`postcodeForUPRN(uprn)`**: primary-key hit on the `without rowid` table.
 *   - **`uprnsForPostcode(postcode)`**: the `pcds_compact` index, answering every uprn the register
 *     assigns to one unit postcode with the point OS publishes for each — the "assigned points and
 *     their bound" the physical-constraint design record names as the prior's soft structure.
 *
 *   ## `null` and `[]` are claims, scoped by coverage
 *
 *   The register designates GB complete (every uprn in AddressBase with a Code-Point Open postcode),
 *   and the builder writes `layer_coverage` with basis `designated` for every cell the register
 *   touches. Inside a covered cell an empty answer is evidence of absence: no GB uprn by that number
 *   has a Code-Point postcode, or no UPRN has that postcode. Two absences the reader cannot
 *   tell from those are recorded in `nsul_meta` as counts rather than as rows. A uprn whose `pcds` is
 *   null (its postcode is not in Code-Point Open) and one Open uprn publishes no coordinate for — so a
 *   caller building negative evidence reads the coverage table and those counts rather than this reader
 *   by itself. Outside coverage (Northern Ireland, the Isle of Man, the Channel Islands) the answer is
 *   unknown, per the meaning-of-zero rule.
 */

import { SQLiteLookup, type SQLiteLookupOptions } from "@mailwoman/sqlite/lookup"

import { compactPostcode, type NSULDatabase } from "#nsul/schema"
import { prepareAll, prepareGet } from "#sqlite-utils"

/**
 * The unit postcode the register assigns to a uprn, in both stored forms.
 */
export interface NSULPostcode {
	/**
	 * As nsul writes it — `RG40 4HR`.
	 */
	pcds: string
	/**
	 * Space removed — `RG404HR`, Code-Point Open's `spr.name` form.
	 */
	pcdsCompact: string
}

/**
 * One uprn assigned to a unit postcode, with the point `uprn.db` holds for it.
 */
export interface NSULAssignedPoint {
	uprn: number
	latitude: number
	longitude: number
	/**
	 * 48-bit short res-9 H3 cell, as `uprn.db` stores it.
	 */
	h3Cell: number
}

/**
 * Where an {@link NSULLookup} reads from.
 *
 * The source is a `nsul.db` built by `mailwoman`'s gazetteer pipeline, opened read-only,
 * or a connection the caller already holds.
 */
export type NSULLookupOpts = SQLiteLookupOptions<NSULDatabase>

interface PostcodeRow {
	pcds: string
	pcds_compact: string
}

interface PointRow {
	uprn: number
	lat: number
	lon: number
	h3_cell: number
}

/**
 * Node reader over `nsul.db`.
 *
 * Disposable, so callers can `using lookup = new NSULLookup(...)`.
 */
export class NSULLookup extends SQLiteLookup<NSULDatabase> {
	readonly #postcodeProbe: (uprn: number) => PostcodeRow | undefined
	readonly #pointsProbe: (pcdsCompact: string) => PointRow[]

	constructor(opts: NSULLookupOpts) {
		super(opts)

		this.#postcodeProbe = prepareGet<[number], PostcodeRow, NSULDatabase>(
			this.database,
			"SELECT pcds, pcds_compact FROM uprn_postcode WHERE uprn = ?"
		)

		this.#pointsProbe = prepareAll<[string], PointRow, NSULDatabase>(
			this.database,
			"SELECT uprn, lat, lon, h3_cell FROM uprn_postcode WHERE pcds_compact = ? ORDER BY uprn"
		)
	}

	/**
	 * The unit postcode the register assigns to `uprn`, or `null` when the register holds
	 * no row for it (see the module docstring for what that `null` claims).
	 */
	postcodeForUPRN(uprn: number): NSULPostcode | null {
		const row = this.#postcodeProbe(uprn)

		return row ? { pcds: row.pcds, pcdsCompact: row.pcds_compact } : null
	}

	/**
	 * Every uprn the register assigns to one unit postcode, with its published point, in ascending uprn order.
	 *
	 * The key is compacted through {@link compactPostcode} first, so `PO21 1HR`
	 * and `PO211HR` answer identically.
	 * An empty array is the register's answer, scoped as the module docstring describes.
	 */
	uprnsForPostcode(postcode: string): NSULAssignedPoint[] {
		return this.#pointsProbe(compactPostcode(postcode)).map((row) => ({
			uprn: row.uprn,
			latitude: row.lat,
			longitude: row.lon,
			h3Cell: row.h3_cell,
		}))
	}
}
