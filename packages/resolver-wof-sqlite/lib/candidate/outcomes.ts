// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Compiles the candidate database's outcome tables from one pinned revision of the definitions.
 *
 *   `outcome_default` holds every placetype default of the spec.
 *   `record_outcome` holds the assertions GeoNames feature codes make beyond a record's defaults.
 *
 *   A record's feature code is read from the GeoNames per-country dumps, through the GeoNames
 *   range id of a place the GeoNames step added, or a record's `gn:id` concordance.
 */

import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { createOutcomeEvidenceTable } from "@mailwoman/core/outcome/evidence"
import type { CompiledOutcomeSpec, OutcomeSpecPin } from "@mailwoman/core/outcome/spec"
import { GEONAMES_ID_BASE, GEONAMES_POSTAL_ID_BASE } from "@mailwoman/core/resolver/synthetic-id-ranges"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolvePath, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import type { PlaceAttrs } from "#candidate/place-attrs"
import { type OutcomeDatabase, writeOutcomeDefaults } from "#outcome/schema"
import type { WOFDatabase } from "#schema"

/**
 * The outcome inputs of a candidate build.
 */
export interface CandidateOutcomeInputs {
	spec: CompiledOutcomeSpec
	pin: OutcomeSpecPin
	/**
	 * The GeoNames per-country dump directory, `<CC>.txt` files.
	 */
	geonamesDir: PathBuilderLike
}

/**
 * Counts from {@link stageCandidateOutcomes}.
 */
export interface CandidateOutcomeResult {
	defaultRows: number
	/**
	 * `record_outcome` rows, one per explicit assertion.
	 */
	recordRows: number
	/**
	 * Records with one `record_outcome` row or more.
	 */
	recordsAsserted: number
	contestedRows: number
	/**
	 * Records whose GeoNames feature code the dumps gave.
	 */
	recordsWithFeatureCode: number
}

function isGeonamesPlaceID(id: number): boolean {
	return id >= GEONAMES_ID_BASE && id < GEONAMES_POSTAL_ID_BASE
}

/**
 * Write the outcome tables into a candidate build in progress.
 *
 * @throws When a place the GeoNames step added has no row in the dumps, because its
 * type field is then unmapped and the build would write an empty set for it.
 */
export async function stageCandidateOutcomes(options: {
	src: DatabaseClient<WOFDatabase>
	out: DatabaseClient<OutcomeDatabase>
	/**
	 * Each candidate place's attributes, by record id.
	 */
	attrs: ReadonlyMap<number, Pick<PlaceAttrs, "ptid">>
	/**
	 * The placetype dictionary, from name to id.
	 */
	ptcodes: ReadonlyMap<string, number>
	inputs: CandidateOutcomeInputs
	progress: (phase: string, message: string) => void
}): Promise<CandidateOutcomeResult> {
	const { src, out, inputs, progress } = options
	const placetypeNames = new Map([...options.ptcodes].map(([placetype, id]) => [id, placetype]))
	const placetypeOf = new Map([...options.attrs].map(([sid, a]) => [sid, placetypeNames.get(a.ptid) ?? ""]))
	const table = createOutcomeEvidenceTable(inputs.spec)

	const defaultRows = await writeOutcomeDefaults(out, inputs.spec, inputs.pin)

	// Each GeoNames number, mapped to the candidate places whose id or concordance holds it.
	const sprOf = new Map<number, number[]>()
	const geonamesPlaces = new Set<number>()

	const link = (geonameid: number, sprID: number) => {
		const ids = sprOf.get(geonameid)

		if (ids) {
			if (!ids.includes(sprID)) {
				ids.push(sprID)
			}
		} else {
			sprOf.set(geonameid, [sprID])
		}
	}

	for (const sprID of placetypeOf.keys()) {
		if (isGeonamesPlaceID(sprID)) {
			geonamesPlaces.add(sprID)
			link(sprID - GEONAMES_ID_BASE, sprID)
		}
	}

	for (const row of src.prepare("SELECT id, other_id FROM concordances WHERE other_source = 'gn:id'").iterate()) {
		const sprID = Number(row.id)
		const geonameid = Number(row.other_id)

		if (placetypeOf.has(sprID) && Number.isSafeInteger(geonameid) && geonameid > 0) {
			link(geonameid, sprID)
		}
	}

	progress("outcomes", `${sprOf.size.toLocaleString()} GeoNames numbers on candidate places; reading feature codes`)

	const assertionsOf = new Map<number, ReturnType<typeof table.assertionsFor>>()
	const coded = new Set<number>()

	for await (const path of Globerator.from("[A-Z][A-Z].txt", {
		cwd: resolvePath(inputs.geonamesDir),
		absolute: true,
	})) {
		for await (const f of readUnquotedTSV(path)) {
			const ids = sprOf.get(Number(f[0]))

			if (!ids) continue

			const assertions = table.assertionsFor("geonames", `${f[6]}.${f[7]}`)

			for (const sprID of ids) {
				coded.add(sprID)

				if (assertions.length) {
					assertionsOf.set(sprID, [...(assertionsOf.get(sprID) ?? []), ...assertions])
				}
			}
		}
	}

	const uncoded = [...geonamesPlaces].filter((id) => !coded.has(id))

	if (uncoded.length) {
		throw new Error(
			`${uncoded.length.toLocaleString()} places the GeoNames step added have no row in ${inputs.geonamesDir.toString()}, ` +
				`so their feature code is unknown; first ${uncoded.slice(0, 5).join(", ")}.`
		)
	}

	const insert = out.prepare("INSERT INTO record_outcome (spr_id, outcome_id, contested) VALUES (?, ?, ?)")
	let recordRows = 0
	let contestedRows = 0
	let recordsAsserted = 0

	out.exec("BEGIN")

	for (const [sprID, assertions] of assertionsOf) {
		const rows = table.recordRows(placetypeOf.get(sprID) ?? null, assertions)

		for (const row of rows) {
			insert.run(sprID, row.outcomeID, row.contested ? 1 : 0)

			if (row.contested) {
				contestedRows++
			}
		}

		recordRows += rows.length

		if (rows.length) {
			recordsAsserted++
		}
	}

	out.exec("COMMIT")

	progress(
		"outcomes",
		`${defaultRows} placetype defaults; ${recordRows.toLocaleString()} assertions on ` +
			`${recordsAsserted.toLocaleString()} records (${contestedRows.toLocaleString()} contested); ` +
			`${coded.size.toLocaleString()} records carry a feature code`
	)

	return { defaultRows, recordRows, recordsAsserted, contestedRows, recordsWithFeatureCode: coded.size }
}
