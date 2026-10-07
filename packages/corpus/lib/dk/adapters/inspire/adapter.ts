/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * `dk-inspire`: Klimadatastyrelsen's INSPIRE Addresses GeoPackage adapter, street-level over Denmark.
 *
 * Input is a local `ad_inspire.gpkg`, the one member of the `DK_INSPIRE_Addresses.zip` that
 * Denmark's ATOM download service serves. The download belongs to
 * `#dk/tools/fetch/inspire`; this module reads a file that is already on disk, as the CSV adapters do.
 *
 * Denmark serves the Addresses (AD) theme as a GeoPackage rather than as GML, so there is no XML to
 * parse. A GeoPackage is a SQLite database, and this adapter reads it through
 * `@mailwoman/sqlite`'s Kysely client. The file is a published artifact and is opened read-only.
 *
 * The INSPIRE address model is normalized, so one address is a join rather than a row. The `address`
 * table holds the locator designators and a reference per component. The street name and the postcode
 * live in `thoroughfarename` and `postaldescriptor`, reached through `component_thoroughfarename` and
 * `component_postaldescriptor`. An unresolved reference raises
 * {@linkcode UnresolvedAddressComponentError} rather than yielding an address missing its street.
 *
 * The adapter reads `locator_designator_1_designator` as `house_number`. That column already holds
 * any letter (`2A`, `68A`). It reads `thoroughfarename.name_name` as `street`, and
 * `postaldescriptor.postcode` and `postname` as `postcode` and `locality`. Denmark writes a floor
 * and a door after the house number, and the publisher splits them across
 * `locator_designator_2_designator` and `locator_designator_3_designator`. The adapter joins the two
 * into one `unit`, because the Danish address layout places `unit` and leaves `level` unplaced.
 *
 * The file holds no region column that belongs in an address. `component_adminunitname_2` and
 * `_3` name a region and a municipality, neither of which a Danish address line states, so region
 * is left to the wof-postalcode and wof-admin cross-reference at corpus build time, as BAN's is.
 *
 * The address-source register lists this source as `dk-property-building-1`. Its
 * `unchecked-access-free-dk-klimadatastyrelsen` license holds `CC-BY-4.0` in `spdx`, an `elected`
 * state with `train` permitted. The adapter records that license on every row, and the model card
 * must attribute Klimadatastyrelsen.
 *
 * The adapter streams through Kysely's `.stream()`, so the `address` table never sits in memory, and
 * orders by `objectid` so two runs over one file emit the same rows in the same order. It honors
 * `opts.limit` and `opts.signal`. `opts.country` is optional and accepts only `DK`: the file covers
 * Denmark proper, and Greenland and the Faroe Islands are their own jurisdictions and are absent
 * from it.
 *
 * The measured file holds 599,999 `address` rows. That is one short of a round 600,000, while the
 * national register is several times larger, so treat the file as a possible export cap rather than
 * as Denmark's address count.
 */

import { formatAddressRow } from "@mailwoman/codex/address/format"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { UnsupportedCountryError } from "#adapters/errors"
import { stableSourceID } from "#adapters/source-id"
import { composeHouseNumber } from "#adapters/street-line"
import { SourceRegister } from "#registers"
import { AddressRole, type AdapterOptions, type CanonicalRow, type CorpusAdapter, SurfaceOrigin } from "#types"

/**
 * Registry id for this adapter.
 *
 * Stamped into every row it emits, so a corpus record can be traced back to the dataset it came from.
 */
export const DK_INSPIRE_ADAPTER_ID = "dk-inspire"

/**
 * The license the address-source register elects for this source.
 *
 * Read from the `spdx` field of the register's `unchecked-access-free-dk-klimadatastyrelsen` license.
 * The register's `dk-property-building-1` source points to it.
 *
 * The feed's own `<rights>` states the same, but the register is what governs.
 */
export const DK_INSPIRE_DEFAULT_LICENSE = "CC-BY-4.0"

/**
 * Every jurisdiction this adapter emits, checked against a caller's `--country`.
 *
 * Klimadatastyrelsen's INSPIRE obligation covers Denmark proper.
 * Greenland and the Faroe Islands are separate ISO 3166-1 jurisdictions outside the EU,
 * and the file's administrative units name `Danmark` and its five regions only.
 */
export const DK_INSPIRE_COUNTRIES: readonly string[] = ["DK"]

/**
 * The tables the adapter reads.
 * It requires `gpkg_contents` to declare them.
 *
 * The GeoPackage declares five.
 * `addressareaname` holds a supplementary locality that a Danish address line does
 * not state, and `adminunitname` holds the region and municipality the adapter
 * leaves to cross-reference, so neither is read.
 */
export const DK_INSPIRE_REQUIRED_TABLES: readonly string[] = ["address", "postaldescriptor", "thoroughfarename"]

/**
 * How many rows Kysely buffers per chunk while streaming the join.
 */
const STREAM_CHUNK_ROWS = 2000

/**
 * Raised when the input is not a GeoPackage this adapter can read.
 *
 * The message lists the tables that were declared, so a caller reads which file it opened
 * rather than receiving zero rows from a database with a different schema.
 */
export class AddressGeoPackageSchemaError extends Error {
	constructor(inputPath: string, declared: readonly string[], missing: readonly string[]) {
		super(
			`${DK_INSPIRE_ADAPTER_ID} adapter: ${inputPath} declares no ${missing.join(", ")} in gpkg_contents. ` +
				`It declares ${declared.length ? declared.join(", ") : "no tables"}.`
		)

		this.name = "AddressGeoPackageSchemaError"
	}
}

/**
 * Raised when an address row's component reference resolves to no row of the referenced table.
 *
 * An unresolved reference means the database is incomplete.
 * The adapter reports it rather than converting it into an address missing its street.
 */
export class UnresolvedAddressComponentError extends Error {
	constructor(inspireID: string, column: string, reference: string | null) {
		super(
			`${DK_INSPIRE_ADAPTER_ID} adapter: address ${inspireID} carries ${column}=` +
				`${reference === null ? "NULL" : `"${reference}"`}, which resolves to no row.`
		)

		this.name = "UnresolvedAddressComponentError"
	}
}

/**
 * The GeoPackage tables and columns the adapter reads.
 *
 * The explicit shape catches a column rename upstream.
 * Every text column is nullable in the publisher's own DDL except the ones marked
 * `NOT NULL` there, and an absent value is SQL `NULL` rather than an empty string:
 * the measured file holds no empty string in any column read here.
 */
export interface AddressGeoPackageDatabase {
	gpkg_contents: {
		table_name: string
		data_type: string
	}
	address: {
		objectid: number
		inspireid: string
		locator_designator_1_designator: string | null
		locator_designator_2_designator: string | null
		locator_designator_3_designator: string | null
		component_postaldescriptor: string | null
		component_thoroughfarename: string | null
	}
	thoroughfarename: {
		inspireid: string | null
		name_name: string
	}
	postaldescriptor: {
		inspireid: string | null
		postcode: string | null
		postname: string | null
	}
}

/**
 * Joins Denmark's floor and door designators into the one `unit` value an address line states.
 *
 * Klimadatastyrelsen writes the floor in `locator_designator_2_designator`
 * (`st` for `stuen`, the ground floor, or a storey number) and the door in
 * `locator_designator_3_designator` (`tv` for `til venstre`, or a number).
 * Danish writes the floor first, so the two join in that order.
 *
 * {@linkcode composeHouseNumber} answers the empty string when its first argument is absent.
 * That suits the house-number columns it was written for, and it would drop every
 * door here: 967 measured rows have a door and no floor.
 * The door is therefore the value when the floor is absent.
 *
 * @returns The joined designator, or the empty string when the publisher states neither.
 */
export function composeUnitDesignator(floor: string | null, door: string | null): string {
	const trimmedFloor = (floor ?? "").trim()
	const trimmedDoor = (door ?? "").trim()

	if (!trimmedFloor) return trimmedDoor

	return composeHouseNumber(trimmedFloor, trimmedDoor, " ")
}

export function createDKInspireAdapter(): CorpusAdapter {
	return {
		id: DK_INSPIRE_ADAPTER_ID,
		defaultLicense: DK_INSPIRE_DEFAULT_LICENSE,
		addressRole: AddressRole.Premise,
		register: SourceRegister.DKInspireAddresses,
		surface: SurfaceOrigin.Rendered,
		description:
			"DK INSPIRE Addresses (Klimadatastyrelsen): house-number-level street addresses for Denmark, " +
			"read from the published GeoPackage.",

		async *rows(opts: AdapterOptions): AsyncIterable<CanonicalRow> {
			if (opts.country && !DK_INSPIRE_COUNTRIES.includes(opts.country)) {
				throw new UnsupportedCountryError(DK_INSPIRE_ADAPTER_ID, DK_INSPIRE_COUNTRIES, opts.country)
			}

			const inputPath = opts.inputPath.toString()

			// A published database is read-only, and `DatabaseClient`'s teardown is synchronous,
			// so the handle is taken with `using` rather than `await using`.
			using db = new DatabaseClient<AddressGeoPackageDatabase>(inputPath, { readOnly: true })

			const declared = (await db.selectFrom("gpkg_contents").select("table_name").execute()).map(
				(row) => row.table_name
			)

			const missing = DK_INSPIRE_REQUIRED_TABLES.filter((table) => !declared.includes(table))

			// A database that declares none of these tables is a different file
			// rather than an empty one, and saying so names what was opened.
			if (missing.length) {
				throw new AddressGeoPackageSchemaError(inputPath, declared, missing)
			}

			// Left joins, deliberately: an inner join would drop an address whose
			// component reference does not resolve.
			// That absence has to be reported rather than applied.
			const stream = db
				.selectFrom("address as a")
				.leftJoin("thoroughfarename as t", "t.inspireid", "a.component_thoroughfarename")
				.leftJoin("postaldescriptor as p", "p.inspireid", "a.component_postaldescriptor")
				.select([
					"a.inspireid as inspireid",
					"a.locator_designator_1_designator as house",
					"a.locator_designator_2_designator as floor",
					"a.locator_designator_3_designator as door",
					"a.component_thoroughfarename as thoroughfareReference",
					"a.component_postaldescriptor as postalReference",
					"t.name_name as street",
					"p.postcode as postcode",
					"p.postname as postname",
				])
				// The order is the emission order, so two runs over one file agree byte for byte.
				.orderBy("a.objectid")
				.stream(STREAM_CHUNK_ROWS)

			let emitted = 0
			let unaligned = 0

			try {
				for await (const record of stream) {
					if (opts.signal?.aborted) break

					if (opts.limit !== undefined && emitted >= opts.limit) break

					// The street is the one component every address needs and every row
					// of the measured file resolves.
					// An unresolved reference is reported, never read as a missing street.
					if (record.street === null) {
						throw new UnresolvedAddressComponentError(
							record.inspireid,
							"component_thoroughfarename",
							record.thoroughfareReference
						)
					}

					if (record.postcode === null && record.postname === null) {
						throw new UnresolvedAddressComponentError(
							record.inspireid,
							"component_postaldescriptor",
							record.postalReference
						)
					}

					const house = (record.house ?? "").trim()
					const street = record.street.trim()
					const unit = composeUnitDesignator(record.floor, record.door)
					const postcode = (record.postcode ?? "").trim()
					const locality = (record.postname ?? "").trim()

					const components: CanonicalRow["components"] = {}

					if (house) {
						components.house_number = house
					}

					components.street = street

					if (unit) {
						components.unit = unit
					}

					if (postcode) {
						components.postcode = postcode
					}

					if (locality) {
						components.locality = locality
					}

					const rendered = formatAddressRow(components, "DK", { singleLine: true })

					if (!rendered) {
						unaligned += 1

						continue
					}

					const { raw, components: aligned } = rendered
					const seed = record.inspireid.trim()

					const sourceID = seed ? `${DK_INSPIRE_ADAPTER_ID}-${seed}` : stableSourceID(DK_INSPIRE_ADAPTER_ID, aligned)

					yield {
						raw,
						components: aligned,
						country: "DK",
						// Danish is the language of every address in the file, and the file
						// covers one jurisdiction, so the locale is constant.
						locale: "da-DK",
						source: DK_INSPIRE_ADAPTER_ID,
						source_id: sourceID,
						corpus_version: "",
						license: DK_INSPIRE_DEFAULT_LICENSE,
					}

					emitted++
				}
			} finally {
				// A row the layout could not render is a drop, so the count is stated
				// rather than left to be read off a smaller total.
				if (unaligned > 0) {
					process.stderr.write(
						`  ${DK_INSPIRE_ADAPTER_ID}: ${unaligned} rows did not align against the Danish layout and were dropped, ${emitted} kept\n`
					)
				}
			}
		},
	}
}

/**
 * The configured adapter instance registered with the corpus builder.
 */
export const dkInspireAdapter = createDKInspireAdapter()
