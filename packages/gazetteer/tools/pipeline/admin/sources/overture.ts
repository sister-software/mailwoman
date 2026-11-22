// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Backfills the admin gazetteer from the Overture `divisions` theme.
 *
 *   The country list lives in `../defaults.ts`.
 *
 *   The gazetteer is a Collective Database, and the Overture Divisions rows are its ODbL-1.0 part.
 *   Every division keeps its own rows in the Overture id range, and the Overture step leaves every WOF
 *   record as the WOF ingest wrote it, without a name, Wikidata id or population from Overture.
 *
 *   A division that matches a WOF record is recorded in `overture_wof_match`,
 *   a table of the Overture part, so a lookup can tell the two rows name one place
 *   without either row carrying the other's data.
 */

import { isOfficialLanguage } from "@mailwoman/codex/country"
import { simpleSHA3 } from "@mailwoman/core/crypto"
import { tryParsingJSON } from "@mailwoman/core/json"
import { OVERTURE_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
// These imports are type-only because the package is an optional peer that callers load lazily.
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite"
import type { OvertureWOFMatchDatabase } from "@mailwoman/resolver-wof-sqlite/overture-match-schema"
import type { DatabaseClient, StatementSync } from "@mailwoman/sqlite/client"
import { sql } from "kysely"

import {
	GAP_SOURCE_TERMS,
	type UnmatchedPlace,
	type WOFMatch,
	type WOFPlaceIndex,
} from "#tools/pipeline/admin/sources/wof-match"

/**
 * Overture division subtypes that map to the resolver's admin placetypes.
 *
 * The list includes `country` so a backfilled country has a country node for
 * reverse geocoding and country scoping.
 */
export const OVERTURE_DIVISION_SUBTYPES = ["country", "locality", "region", "county", "localadmin"]

/**
 * Countries whose Overture `county` divisions are settlements, mapped to the placetype to write instead.
 *
 * No admin tag queries the `county` placetype, because the locality filter group
 * covers only `locality`, `borough`, and `localadmin`.
 * Singapore's planning areas, such as Bedok, arrive as `county`, so the Overture
 * step writes them as `borough` to make them reachable.
 *
 * The list is explicit because a general rule would also admit other countries' `county` rows,
 * such as Kuwait's underscore-joined ASCII names and Qatar's numbered zones.
 */
const COUNTY_IS_SETTLEMENT_TIER: ReadonlyMap<string, string> = new Map([["SG", "borough"]])

/**
 * Returns the placetype to write for a division.
 *
 * This is the Overture subtype unless {@link COUNTY_IS_SETTLEMENT_TIER} maps the
 * country's `county` rows to another placetype.
 */
export function placetypeForSubtype(subtype: string, country: string): string {
	if (subtype !== "county") return subtype

	return COUNTY_IS_SETTLEMENT_TIER.get(country.trim().toUpperCase()) ?? subtype
}

/**
 * The width of the ID range reserved for Overture rows.
 *
 * It runs from `OVERTURE_ID_BASE` up to the base of the GeoNames places' range.
 */
const OVERTURE_ID_SPAN = 1_000_000_000_000

/**
 * Bracket, pipe and delimiter characters that mark an editorial aside in a name field.
 */
const NAME_NOISE = /[()[\]{}<>|/\\_@#$%^*+=~`"]/u

/**
 * The maximum name length.
 * It rejects descriptions that ran into the name field.
 */
const NAME_MAX_LENGTH = 120

/**
 * Returns whether a `names.common` entry is usable as a name.
 *
 * The check accepts any script.
 * For countries whose primary name is Latin, `common` is the only place local-script names appear.
 */
export function isDivisionName(value: string): boolean {
	return value.length <= NAME_MAX_LENGTH && /\p{L}/u.test(value) && !NAME_NOISE.test(value)
}

/**
 * The number of digest bytes drawn per GERS ID.
 *
 * Six bytes (48 bits) exceed {@link OVERTURE_ID_SPAN} and stay exactly representable as a JS number.
 */
const ID_DIGEST_BYTES = 6

/**
 * The radix of {@link simpleSHA3}'s hex digest.
 */
const HEX_RADIX = 16

/**
 * Maps each Overture GERS ID to a synthetic integer ID derived from a hash of the GERS ID.
 *
 * Consumers store these IDs, so an ID must depend on the place and not on the build's scan order.
 * Each ID is `idBase + (hash(gers) mod span)`.
 *
 * On a collision, the later ID probes forward to the next free slot.
 * The input is sorted first so the probing doesn't depend on query order.
 */
export function assignSyntheticIDs(gersIDs: readonly string[], idBase: number = OVERTURE_ID_BASE): Map<string, number> {
	const idmap = new Map<string, number>()
	const taken = new Set<number>()

	for (const gers of gersIDs.toSorted()) {
		if (idmap.has(gers)) continue

		let slot = Number.parseInt(simpleSHA3([gers], ID_DIGEST_BYTES), HEX_RADIX) % OVERTURE_ID_SPAN

		while (taken.has(slot)) {
			slot = (slot + 1) % OVERTURE_ID_SPAN
		}

		taken.add(slot)
		idmap.set(gers, idBase + slot)
	}

	return idmap
}

/**
 * The columns each bulk insert writes, in the order that its positional `run()` call supplies them.
 *
 * The `satisfies` clauses check every name against `WOFDatabase`, so a renamed column fails to compile.
 * The inserts use raw positional statements because this is a high-volume bulk-write path.
 */
const SPR_COLUMNS = [
	"id",
	"parent_id",
	"name",
	"placetype",
	"country",
	"latitude",
	"longitude",
	"min_latitude",
	"min_longitude",
	"max_latitude",
	"max_longitude",
	"is_current",
	"is_deprecated",
	"is_ceased",
	"is_superseded",
	"is_superseding",
	"lastmodified",
] as const satisfies ReadonlyArray<keyof WOFDatabase["spr"]>

const NAMES_COLUMNS = [
	"id",
	"name",
	"placetype",
	"country",
	"language",
	"official",
	"lastmodified",
	"source",
] as const satisfies ReadonlyArray<keyof WOFDatabase["names"]>

const POPULATION_COLUMNS = ["id", "population"] as const satisfies ReadonlyArray<keyof WOFDatabase["place_population"]>

const CONCORDANCE_COLUMNS = [
	"id",
	"other_id",
	"other_source",
	"lastmodified",
	"source",
] as const satisfies ReadonlyArray<keyof WOFDatabase["concordances"]>

/**
 * Compiles a positional insert statement for one of the column tuples above.
 *
 * Kysely's `sql` helper quotes the identifiers and generates one placeholder per column.
 * The result is a plain SQL string for `db.prepare`, so the statement can be
 * prepared once and run for every row.
 */
function compileInsert<DB>(
	kdb: DatabaseClient<DB>,
	table: keyof DB & string,
	columns: readonly string[],
	orReplace = false
): string {
	const conflict = orReplace ? sql`or replace ` : sql``
	const names = sql.join(columns.map((column) => sql.ref(column)))
	const placeholders = sql.join(columns.map(() => sql.raw("?")))

	return sql`insert ${conflict}into ${sql.table(table)} (${names}) values (${placeholders})`.compile(kdb).sql
}

/**
 * Prepares the bulk-write statements against an open unified database.
 *
 * It is exported so a test can run the statements against a real `createUnifiedSchema` database.
 * The `satisfies` checks compare the columns with the `WOFDatabase` interface only.
 * The DDL can drift from that interface.
 */
export function prepareInserts<DB extends WOFDatabase>(
	db: DatabaseClient<DB>
): {
	spr: StatementSync
	names: StatementSync
	population: StatementSync
	concordances: StatementSync
} {
	const kdb = db

	return {
		spr: db.prepare(compileInsert(kdb, "spr", SPR_COLUMNS, true)),
		names: db.prepare(compileInsert(kdb, "names", NAMES_COLUMNS)),
		population: db.prepare(compileInsert(kdb, "place_population", POPULATION_COLUMNS, true)),
		concordances: db.prepare(compileInsert(kdb, "concordances", CONCORDANCE_COLUMNS)),
	}
}

/**
 * Backfills the Overture `divisions` theme into an open unified ingest database.
 *
 * The query runs here, and {@link writeOvertureDivisions} writes the rows it returns.
 * The native `@duckdb/node-api` dependency is imported lazily so the module loads without it.
 *
 * @returns What {@link writeOvertureDivisions} wrote.
 */
export async function ingestOvertureDivisions(
	db: DatabaseClient<WOFDatabase & OvertureWOFMatchDatabase>,
	countries: readonly string[],
	release: string,
	/**
	 * The base of the synthetic ID range. It defaults to {@link OVERTURE_ID_BASE}.
	 */
	idBase: number = OVERTURE_ID_BASE,
	/**
	 * The WOF records to match against. See {@link writeOvertureDivisions}.
	 */
	wof?: { index: WOFPlaceIndex; onGap: (gap: UnmatchedPlace) => void }
): Promise<OvertureDivisionsResult> {
	const inlist = countries.map((c) => `'${c.replaceAll("'", "''")}'`).join(",")
	const subtypes = OVERTURE_DIVISION_SUBTYPES.map((s) => `'${s}'`).join(",")
	const glob = `s3://overturemaps-us-west-2/release/${release}/theme=divisions/type=division/*`
	// The `type=division` row's bbox is only its label point.
	// The query takes the real extent from the matching `type=division_area` rows
	// and falls back to the point bbox when a division has no area.
	// The extent also covers the stored point, because an area need not contain its division's point.
	const areaGlob = `s3://overturemaps-us-west-2/release/${release}/theme=divisions/type=division_area/*`

	const { DuckDBInstance } = await import("@duckdb/node-api")
	const instance = await DuckDBInstance.create()
	const con = await instance.connect()

	await con.run(
		/* sql */ `install httpfs; load httpfs; install spatial; load spatial; install json; load json; SET s3_region='us-west-2';`
	)

	await con.run(/* sql */ `SET memory_limit='4GB'; SET threads=4;`)

	console.error(`  Overture divisions: querying ${countries.join(",")} @ release ${release}...`)

	// The Overture step writes rows and lists gaps in row order, and DuckDB returns rows in
	// an order that varies with its 4 threads, so the query fixes the order by division id.
	const result = await con.runAndReadAll(/*sql*/ `
		WITH area AS (
			SELECT division_id,
				MIN(bbox.ymin) AS ymin, MAX(bbox.ymax) AS ymax, MIN(bbox.xmin) AS xmin, MAX(bbox.xmax) AS xmax
			FROM read_parquet('${areaGlob}')
			WHERE country IN (${inlist})
			GROUP BY division_id
		)
		SELECT d.id AS id,
			d.names.primary AS name,
			to_json(d.names.common) AS common_json,
			d.subtype AS subtype,
			d.country AS country,
			ST_Y(ST_Centroid(d.geometry)) AS lat,
			ST_X(ST_Centroid(d.geometry)) AS lon,
			LEAST(COALESCE(a.ymin, d.bbox.ymin), ST_Y(ST_Centroid(d.geometry))) AS min_lat,
			GREATEST(COALESCE(a.ymax, d.bbox.ymax), ST_Y(ST_Centroid(d.geometry))) AS max_lat,
			LEAST(COALESCE(a.xmin, d.bbox.xmin), ST_X(ST_Centroid(d.geometry))) AS min_lon,
			GREATEST(COALESCE(a.xmax, d.bbox.xmax), ST_X(ST_Centroid(d.geometry))) AS max_lon,
			d.parent_division_id AS parent_division_id,
			d.population AS population,
			d.wikidata AS wikidata
		FROM read_parquet('${glob}') d
		LEFT JOIN area a ON a.division_id = d.id
		WHERE d.country IN (${inlist}) AND d.subtype IN (${subtypes})
			AND d.names.primary IS NOT NULL AND d.geometry IS NOT NULL
		ORDER BY d.id
	`)

	const rows = result.getRowObjects() as Array<Record<string, unknown>>

	console.error(`  Overture divisions: ${rows.length.toLocaleString()} pulled`)

	return writeOvertureDivisions(db, rows.map(readDivisionRow), idBase, wof)
}

/**
 * One division as the Overture query returns it.
 */
export interface OvertureDivisionRow {
	/**
	 * The GERS id.
	 */
	id: string
	name: string
	/**
	 * `names.common`, a language to that language's standard name, as JSON, or null.
	 */
	commonJSON: string | null
	subtype: string
	country: string
	latitude: number
	longitude: number
	minLatitude: number
	minLongitude: number
	maxLatitude: number
	maxLongitude: number
	parentDivisionID: string | null
	population: number
	wikidata: string | null
}

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0)

function readDivisionRow(r: Record<string, unknown>): OvertureDivisionRow {
	return {
		id: String(r.id),
		name: String(r.name),
		commonJSON: r.common_json ? String(r.common_json) : null,
		subtype: String(r.subtype),
		country: String(r.country ?? ""),
		latitude: num(r.lat),
		longitude: num(r.lon),
		minLatitude: num(r.min_lat),
		minLongitude: num(r.min_lon),
		maxLatitude: num(r.max_lat),
		maxLongitude: num(r.max_lon),
		parentDivisionID: r.parent_division_id == null ? null : String(r.parent_division_id),
		population: num(r.population),
		wikidata: typeof r.wikidata === "string" ? r.wikidata : null,
	}
}

/**
 * What one run of the Overture step wrote.
 */
export interface OvertureDivisionsResult {
	/**
	 * Divisions written, each as its own row in the Overture id range.
	 */
	written: number
	/**
	 * Of those, the divisions that matched a WOF record and were recorded in `overture_wof_match`.
	 */
	matched: number
	/**
	 * Divisions whose parent is a WOF record, through their parent division's match.
	 */
	wofParents: number
	/**
	 * Divisions written with a Wikidata concordance on their own row.
	 */
	wikidata: number
}

/**
 * Writes divisions into an open unified ingest database as the gazetteer's Overture Divisions part.
 *
 * Every division gets its own `spr` row with a synthetic id from {@link assignSyntheticIDs},
 * and its own `names`, `concordances` and `place_population` rows, all tagged `overture`.
 * No WOF row is read for writing or changed: a division never adds a name,
 * a Wikidata id or a population to a WOF record, because that would make the WOF rows
 * a Derivative Database of Overture Divisions under ODbL 4.4.
 *
 * Given a WOF index:
 *
 * - A division that matches a WOF record still writes its own row, and the pair is
 *   written to `overture_wof_match`, a table of the Overture part.
 * - A division that matches none is reported to `onGap`.
 * - A division whose parent division matched a WOF record takes that record as its `parent_id`.
 *
 * That parent link stays because it is a reference from an Overture row to a WOF id.
 * It is stored on the Overture row, and the WOF row's own columns, names and ancestry are the
 * same as in a build without the Overture step, so the WOF part keeps its unmodified form.
 *
 * It is what lets a division sit inside WOF's hierarchy, so region scoping and containment answer for it.
 *
 * A division whose parent was not ingested gets parent id -1.
 */
export async function writeOvertureDivisions(
	db: DatabaseClient<WOFDatabase & OvertureWOFMatchDatabase>,
	rows: readonly OvertureDivisionRow[],
	idBase: number = OVERTURE_ID_BASE,
	wof?: { index: WOFPlaceIndex; onGap: (gap: UnmatchedPlace) => void }
): Promise<OvertureDivisionsResult> {
	const { createOvertureWOFMatchTable, OVERTURE_WOF_MATCH_TABLE } =
		await import("@mailwoman/resolver-wof-sqlite/overture-match-schema")

	await createOvertureWOFMatchTable(db)

	const idmap = assignSyntheticIDs(
		rows.map((r) => r.id),
		idBase
	)

	const {
		spr: sprInsert,
		names: namesInsert,
		population: populationInsert,
		concordances: concordancesInsert,
	} = prepareInserts(db)

	const matchInsert = db.prepare(compileInsert(db, OVERTURE_WOF_MATCH_TABLE, ["overture_id", "wof_id", "match_by"]))

	const candidateOf = (r: OvertureDivisionRow) => {
		const country = r.country.toUpperCase()

		return {
			name: r.name,
			placetype: placetypeForSubtype(r.subtype, country),
			country,
			latitude: r.latitude,
			longitude: r.longitude,
			wikidata: r.wikidata,
		}
	}

	// Every division is matched before any is written, so a child's parent can be the WOF record its parent matched.
	const matches = new Map<string, WOFMatch>()

	if (wof) {
		for (const r of rows) {
			const match = wof.index.match(candidateOf(r))

			if (match) {
				matches.set(r.id, match)
			}
		}
	}

	db.exec("BEGIN")

	const result: OvertureDivisionsResult = { written: 0, matched: 0, wofParents: 0, wikidata: 0 }

	for (const r of rows) {
		const gers = r.id
		const { name, placetype, country, latitude, longitude, wikidata } = candidateOf(r)
		const nid = idmap.get(gers)!
		const matched = matches.get(gers)
		const pgers = r.parentDivisionID
		const wofParent = pgers ? matches.get(pgers)?.id : undefined
		const pid = wofParent ?? ((pgers && idmap.get(pgers)) || -1)

		if (typeof wofParent === "number") {
			result.wofParents++
		}

		if (matched) {
			matchInsert.run(nid, matched.id, matched.by)

			result.matched++
		} else {
			wof?.onGap({
				source: "overture",
				...GAP_SOURCE_TERMS.overture,
				sourceID: gers,
				id: nid,
				name,
				placetype,
				country,
				latitude,
				longitude,
				wikidata,
			})
		}

		// The argument order must match SPR_COLUMNS.
		sprInsert.run(
			nid,
			pid,
			name,
			placetype,
			country,
			latitude,
			longitude,
			r.minLatitude,
			r.minLongitude,
			r.maxLatitude,
			r.maxLongitude,
			1,
			0,
			0,
			0,
			0,
			0
		)

		namesInsert.run(nid, name, placetype, country, "", 0, 0, "overture")

		// `names.common` maps a language to that language's standard name.
		// Each one becomes an alias.
		// An alias is official when its language is an official language of the country.
		// A malformed map parses to null, and the row keeps only its primary name.
		const common = r.commonJSON ? tryParsingJSON<Record<string, string>>(r.commonJSON) : null

		if (common) {
			const seen = new Set([name])

			for (const [lang, alias] of Object.entries(common)) {
				if (typeof alias === "string" && !seen.has(alias) && isDivisionName(alias)) {
					seen.add(alias)

					namesInsert.run(
						nid,
						alias,
						placetype,
						country,
						lang,
						isOfficialLanguage(country, lang) ? 1 : 0,
						0,
						"overture"
					)
				}
			}
		}

		// The Wikidata ID uses the same `wd:id` source as the WOF ingest,
		// so `gazetteer importance` can join Overture rows the same way.
		if (wikidata?.startsWith("Q")) {
			concordancesInsert.run(nid, wikidata, "wd:id", 0, "overture")

			result.wikidata++
		}

		if (r.population > 0) {
			populationInsert.run(nid, r.population)
		}

		result.written++
	}

	db.exec("COMMIT")

	console.error(
		`  Overture divisions: ${result.written.toLocaleString()} written as their own rows, ` +
			`${result.wikidata.toLocaleString()} with a Wikidata concordance`
	)

	if (wof) {
		console.error(
			`  Overture divisions: ${result.matched.toLocaleString()} matched a WOF record (recorded in ` +
				`${OVERTURE_WOF_MATCH_TABLE}); ${result.wofParents.toLocaleString()} take a WOF record as parent`
		)
	}

	return result
}
