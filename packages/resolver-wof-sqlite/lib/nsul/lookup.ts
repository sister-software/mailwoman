/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node reader for `nsul.db` — the GB UPRN → unit-postcode register (`nsul/schema.ts`). Two probes,
 *   both synchronous `.prepare()` hits in the `uprn/lookup.ts` style:
 *
 *   - **`postcodeForUPRN(uprn)`**: primary-key hit on the `WITHOUT ROWID` table.
 *   - **`uprnsForPostcode(postcode)`**: the `pcds_compact` index, answering every UPRN the register
 *     assigns to one unit postcode with the point OS publishes for each — the "assigned points and
 *     their bound" the physical-constraint design record names as the prior's soft structure.
 *
 *   ## `null` and `[]` are claims, scoped by coverage
 *
 *   The register designates GB complete (every UPRN in AddressBase with a Code-Point Open postcode),
 *   and the builder writes `layer_coverage` with basis `designated` for every cell the register
 *   touches. Inside a covered cell an empty answer is evidence of absence: no GB UPRN by that number
 *   carries a Code-Point postcode, or no UPRN carries that postcode. Two absences the reader cannot
 *   tell from those are recorded in `nsul_meta` as counts rather than as rows — a UPRN whose `PCDS` is
 *   null (its postcode is not in Code-Point Open) and one Open UPRN publishes no coordinate for — so a
 *   caller building negative evidence reads the coverage table and those counts, not this reader
 *   alone. Outside coverage (Northern Ireland, the Isle of Man, the Channel Islands) the answer is
 *   UNKNOWN, per the meaning-of-zero rule.
 */

import { DatabaseClient } from "@mailwoman/sqlite/client"

import { compactPostcode, type NSULDatabase } from "#nsul/schema"
import { prepareAll, prepareGet } from "#sqlite-utils"

/**
 * The unit postcode the register assigns to a UPRN, in both stored forms.
 */
export interface NSULPostcode {
	/**
	 * As NSUL writes it — `RG40 4HR`.
	 */
	pcds: string
	/**
	 * Space removed — `RG404HR`, Code-Point Open's `spr.name` form.
	 */
	pcdsCompact: string
}

/**
 * One UPRN assigned to a unit postcode, with the point `uprn.db` holds for it.
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

export interface NSULLookupOpts {
	/**
	 * Path to a `nsul.db` built by `mailwoman`'s gazetteer pipeline. Opened read-only.
	 */
	databasePath?: string
	/**
	 * Pre-opened handle (tests / shared connections). Mutually exclusive with `databasePath`.
	 */
	database?: DatabaseClient<NSULDatabase>
}

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
 * Node reader over `nsul.db`. `implements Disposable` so callers can `using lookup = new NSULLookup(...)` — the same
 * precedent as `UPRNLookup`.
 */
export class NSULLookup implements Disposable {
	#db: DatabaseClient<NSULDatabase>
	/**
	 * Resources this instance opened. A connection handed in by a caller is NOT in here, so disposal cannot reach it —
	 * ownership is membership rather than a flag a later branch has to check.
	 */
	readonly #resources = new DisposableStack()

	readonly #postcodeProbe: (uprn: number) => PostcodeRow | undefined
	readonly #pointsProbe: (pcdsCompact: string) => PointRow[]

	constructor(opts: NSULLookupOpts) {
		if (opts.database) {
			this.#db = opts.database
		} else if (opts.databasePath) {
			this.#db = this.#resources.use(new DatabaseClient<NSULDatabase>(opts.databasePath, { readOnly: true }))
		} else {
			throw new Error("NSULLookup needs `databasePath` or `database`")
		}

		this.#postcodeProbe = prepareGet<[number], PostcodeRow, NSULDatabase>(
			this.#db,
			"SELECT pcds, pcds_compact FROM uprn_postcode WHERE uprn = ?"
		)

		this.#pointsProbe = prepareAll<[string], PointRow, NSULDatabase>(
			this.#db,
			"SELECT uprn, lat, lon, h3_cell FROM uprn_postcode WHERE pcds_compact = ? ORDER BY uprn"
		)
	}

	/**
	 * The unit postcode the register assigns to `uprn`, or `null` when the register holds no row for it (see the module
	 * docstring for what that `null` claims).
	 */
	postcodeForUPRN(uprn: number): NSULPostcode | null {
		const row = this.#postcodeProbe(uprn)

		return row ? { pcds: row.pcds, pcdsCompact: row.pcds_compact } : null
	}

	/**
	 * Every UPRN the register assigns to one unit postcode, with its published point, in ascending UPRN order. The key is
	 * compacted through {@link compactPostcode} first, so `PO21 1HR` and `PO211HR` answer identically. An empty array is
	 * the register's answer, scoped as the module docstring says.
	 */
	uprnsForPostcode(postcode: string): NSULAssignedPoint[] {
		return this.#pointsProbe(compactPostcode(postcode)).map((row) => ({
			uprn: row.uprn,
			latitude: row.lat,
			longitude: row.lon,
			h3Cell: row.h3_cell,
		}))
	}

	[Symbol.dispose](): void {
		this.#resources[Symbol.dispose]()
	}
}
