// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds the former administrative divisions table and prints its per-country census.
 *
 *   Inputs: the GeoNames `<CC>.txt` dumps (`mailwoman corpus fetch geonames-dump`),
 *   GeoNames' `hierarchy.txt` (`mailwoman corpus fetch geonames-hierarchy`),
 *   the WOF record store over the clones, and the admin database's `gn:id` concordances.
 *   `pipeline/admin/former-divisions.ts` states the linking rule.
 *
 *   Run:
 *
 *       node packages/gazetteer/tools/former-divisions.run.ts
 *       node packages/gazetteer/tools/former-divisions.run.ts --refresh-store --census <path>
 */

import { ISO2_TO_NAME } from "@mailwoman/codex/country/country"
import { currentSourcePath, dataRootPath } from "@mailwoman/core/data-root"
import { readUnquotedTSV } from "@mailwoman/core/fs/delimited"
import { sortedGlob } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256File } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { GEONAMES_POSTAL_COLUMNS } from "@mailwoman/corpus/adapters/geonames/postal/adapter"
import { COUNTRY_DISPLAY_NAME } from "@mailwoman/corpus/adapters/wof/json-rows"
import { POSTCODE_CONVENTIONS } from "@mailwoman/corpus/tools/postcode/triples"
import {
	type FormerDivisionRecord,
	type FormerDivisionsTable,
	formerDivisionNameKey,
} from "@mailwoman/resolver-wof-sqlite/former-divisions"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { basename, PathBuilder } from "path-ts"

import {
	AdminCodeState,
	adminCodeStates,
	buildFormerDivisions,
	type CeasedWOFDivision,
	ceasedWOFDivision,
	type CoveredSettlement,
	planFormerDivisionTuples,
	FORMER_DIVISION_PLACETYPES,
	type FormerDivisionCensusRow,
	type GeonamesHistoricalDivision,
	readGeonamesDivisions,
	readHierarchyChildren,
	readRowsCarryingCodes,
	wofPlacesOfGeonamesIDs,
} from "#tools/pipeline/admin/former-divisions"
import {
	refreshWOFRecordStore,
	storedWOFRecords,
	type WOFRecordStoreDatabase,
	wofRecordStorePathFor,
} from "#whosonfirst/record-store"

const { values } = parseArguments({
	options: {
		geonames: { type: "string" },
		hierarchy: { type: "string" },
		"wof-root": { type: "string" },
		admin: { type: "string" },
		out: { type: "string" },
		census: { type: "string" },
		tuples: { type: "string" },
		"per-country": { type: "string", default: "1500" },
		"per-division": { type: "string", default: "300" },
		"refresh-store": { type: "boolean", default: false },
	},
})

/**
 * The placetypes a recipe row writes as the locality, and those it writes as a dependent locality.
 */
const SETTLEMENT_PLACETYPES = ["locality", "localadmin"]
const DEPENDENT_PLACETYPES = ["borough", "macrohood", "neighbourhood"]

/**
 * The sub-localities kept for each locality, and the postcodes kept for each place name.
 *
 * A recipe row draws one of them, so a handful gives the rows variety without reading whole lists.
 */
const KEPT_PER_PLACE = 5

/**
 * The shortest country form a row writes, as the prominent-places recipe holds it:
 * a two-letter code reads as a region abbreviation.
 */
const COUNTRY_FORM_MIN_LENGTH = 3

const geonamesDir = PathBuilder.from(values.geonames ?? dataRootPath("geonames"))
const hierarchyPath = PathBuilder.from(values.hierarchy ?? currentSourcePath("geonames-hierarchy")("hierarchy.txt"))
const wofRoot = PathBuilder.from(values["wof-root"] ?? dataRootPath("src", "wof-repos"))
const adminPath = PathBuilder.from(values.admin ?? wofDatabasePath("admin-global-priority.db"))
const outPath = PathBuilder.from(values.out ?? dataRootPath("gazetteer", "former-divisions-v1.json"))
const log = (line: string) => process.stderr.write(`${line}\n`)

const geonames = new Map<string, Awaited<ReturnType<typeof readGeonamesDivisions>>>()

for (const path of await sortedGlob(geonamesDir, "[A-Z][A-Z].txt")) {
	const country = basename(path).slice(0, 2)
	const read = await readGeonamesDivisions(path)

	geonames.set(country, read)
}

const historical: GeonamesHistoricalDivision[] = [...geonames.values()].flatMap((read) => read.historical)

log(`geonames: ${geonames.size} dumps, ${historical.length} historical divisions`)

const rowsCarryingCodes = new Map<string, Map<string, number[]>>()

for (const [country, read] of geonames) {
	const states = adminCodeStates(read.historical, read.current)
	const wanted = new Set<string>()

	for (const division of read.historical) {
		const code = states.get(division.geonamesID)

		if (code?.state === AdminCodeState.Retired && code.path) {
			wanted.add(`${division.level}:${code.path}`)
		}
	}

	if (wanted.size) {
		rowsCarryingCodes.set(country, await readRowsCarryingCodes(geonamesDir(`${country}.txt`), wanted))
	}
}

const hierarchyChildren = await readHierarchyChildren(hierarchyPath, new Set(historical.map((d) => d.geonamesID)))

log(`hierarchy: ${hierarchyChildren.size} historical divisions have children`)

const storePath = wofRecordStorePathFor(wofRoot)

if (values["refresh-store"]) {
	await refreshWOFRecordStore(storePath, wofRoot, {
		onRepo: (refresh) => log(`store: ${refresh.repo} ${refresh.records} records`),
	})
}

const ceased: CeasedWOFDivision[] = []

{
	using store = new DatabaseClient<WOFRecordStoreDatabase>(storePath, { readOnly: true })

	for (const record of storedWOFRecords(store, { placetypes: FORMER_DIVISION_PLACETYPES })) {
		const division = ceasedWOFDivision(record.id, record.feature.properties ?? {})

		if (division) {
			ceased.push(division)
		}
	}
}

log(`wof: ${ceased.length} ceased admin records`)

using admin = new DatabaseClient<WOFDatabase>(adminPath, { readOnly: true })

const wanted = new Set<number>()

for (const read of geonames.values()) {
	for (const row of read.current) {
		wanted.add(row.geonamesID)
	}
}

for (const ids of hierarchyChildren.values()) {
	for (const id of ids) {
		wanted.add(id)
	}
}

for (const byPath of rowsCarryingCodes.values()) {
	for (const ids of byPath.values()) {
		for (const id of ids) {
			wanted.add(id)
		}
	}
}

const wofPlaces = await wofPlacesOfGeonamesIDs(admin, wanted)
const successorIDs = [...new Set(ceased.flatMap((d) => d.supersededBy))]
const current = new Set<number>()

for (let start = 0; start < successorIDs.length; start += 900) {
	const rows = await admin
		.selectFrom("spr")
		.select("id")
		.where("id", "in", successorIDs.slice(start, start + 900))
		.where("is_current", "!=", 0)
		.execute()

	for (const row of rows) {
		current.add(row.id)
	}
}

const { divisions, census } = buildFormerDivisions({
	geonames,
	rowsCarryingCodes,
	hierarchyChildren,
	wofPlaces,
	ceased,
	isCurrentWOF: (id) => current.has(id),
})

const table: FormerDivisionsTable = {
	format: 1,
	builtAt: new Date().toISOString(),
	inputs: {
		hierarchy: `${hierarchyPath} sha256:${await sha256File(hierarchyPath)}`,
		admin: `${adminPath}`,
		wofStore: `${storePath}`,
		geonames: `${geonamesDir} (${geonames.size} dumps)`,
	},
	divisions,
}

await writeLocalJSONFile(table, outPath)

if (values.census) {
	await writeLocalJSONFile({ builtAt: table.builtAt, census }, values.census)
}

if (values.tuples) {
	const settlements = new Map<FormerDivisionRecord, CoveredSettlement[]>()

	for (const division of divisions) {
		const linked = [...new Set(division.links.flatMap((link) => link.wofIDs))]
		const ids = new Set<number>()

		for (let start = 0; start < linked.length; start += 900) {
			const slice = linked.slice(start, start + 900)

			const inside = await admin
				.selectFrom("ancestors")
				.innerJoin("spr", "spr.id", "ancestors.id")
				.select("spr.id as id")
				.where("ancestors.ancestor_id", "in", slice)
				.where("spr.placetype", "in", SETTLEMENT_PLACETYPES)
				.where("spr.country", "=", division.country)
				.where("spr.is_current", "!=", 0)
				.execute()

			for (const row of inside) {
				ids.add(row.id)
			}
		}

		const covered: CoveredSettlement[] = []

		for (let start = 0, list = [...ids]; start < list.length; start += 900) {
			const slice = list.slice(start, start + 900)
			const places = await admin.selectFrom("spr").select(["id", "name"]).where("id", "in", slice).execute()

			const dependents = await admin
				.selectFrom("ancestors")
				.innerJoin("spr", "spr.id", "ancestors.id")
				.select(["ancestors.ancestor_id as parent", "spr.name as name"])
				.where("ancestors.ancestor_id", "in", slice)
				.where("spr.placetype", "in", DEPENDENT_PLACETYPES)
				.where("spr.is_current", "!=", 0)
				.orderBy("spr.id")
				.execute()

			const byParent = new Map<number, string[]>()

			for (const row of dependents) {
				const names = byParent.get(row.parent) ?? []

				if (names.length < KEPT_PER_PLACE && row.name) {
					names.push(row.name)
				}

				byParent.set(row.parent, names)
			}

			for (const place of places) {
				if (place.name) {
					covered.push({ id: place.id, name: place.name, dependents: byParent.get(place.id) ?? [] })
				}
			}
		}

		settlements.set(division, covered)
	}

	const postcodes = new Map<string, Map<string, string[]>>()

	for (const country of new Set(divisions.map((d) => d.country))) {
		const path = dataRootPath("geonames-postal", `${country}.txt`)

		if (!POSTCODE_CONVENTIONS.has(country) || !(await pathExists(path))) continue

		const byName = new Map<string, string[]>()

		for await (const f of readUnquotedTSV(path)) {
			const key = formerDivisionNameKey(f[GEONAMES_POSTAL_COLUMNS.place] ?? "")
			const code = (f[GEONAMES_POSTAL_COLUMNS.postcode] ?? "").trim()

			if (!key || !code) continue

			const codes = byName.get(key) ?? []

			if (codes.length < KEPT_PER_PLACE && !codes.includes(code)) {
				codes.push(code)
			}

			byName.set(key, codes)
		}

		postcodes.set(country, byName)
	}

	const tuples = planFormerDivisionTuples({
		divisions,
		settlementsOf: (division) => settlements.get(division) ?? [],
		postcodesOf: (country, locality) => {
			const codes = postcodes.get(country)?.get(formerDivisionNameKey(locality))
			const placement = POSTCODE_CONVENTIONS.get(country)?.placement ?? null

			return codes && placement ? { codes, placement } : null
		},
		countryNameOf: (country) => {
			const name = COUNTRY_DISPLAY_NAME[country] ?? ISO2_TO_NAME.get(country) ?? null

			return name && name.length >= COUNTRY_FORM_MIN_LENGTH ? name : null
		},
		perCountry: Number(values["per-country"]),
		perDivision: Number(values["per-division"]),
	})

	await writeLocalTextFile(tuples.map((tuple) => stringifyJSON(tuple)).join("\n") + "\n", values.tuples)

	const rowsByCountry = new Map<string, number>()

	for (const tuple of tuples) {
		rowsByCountry.set(tuple.country, (rowsByCountry.get(tuple.country) ?? 0) + 1)
	}

	log(`tuples: ${tuples.length} rows in ${rowsByCountry.size} countries, written to ${values.tuples}`)

	for (const [country, rows] of [...rowsByCountry].toSorted((a, b) => a[0].localeCompare(b[0]))) {
		log(`tuples\t${country}\t${rows}`)
	}
}

const total = (pick: (row: FormerDivisionCensusRow) => number) => census.reduce((sum, row) => sum + pick(row), 0)
const geonamesCount = (row: FormerDivisionCensusRow) => Object.values(row.geonames).reduce((a, b) => a + b, 0)

console.log(
	[
		"country",
		"geonames",
		"wof_ceased",
		"joined",
		"code_retired",
		"code_shared",
		"code_ambiguous",
		"code_absent",
		"uncoded",
		"untagged",
		"linked_untagged",
		"hierarchy",
		"admin_codes",
		"wof_supersession",
		"linked_any",
		"linked_by_tag",
	].join("\t")
)

for (const row of census) {
	console.log(
		[
			row.country,
			geonamesCount(row),
			row.wofCeased,
			row.joined,
			row.codeStates.retired,
			row.codeStates.shared,
			row.codeStates.ambiguous,
			row.codeStates.absent,
			row.codeStates.uncoded,
			row.untagged,
			row.linkedUntagged,
			row.linked.geonames_hierarchy,
			row.linked.geonames_admin_codes,
			row.linked.wof_supersession,
			row.linkedAny,
			Object.entries(row.linkedByTag)
				.map(([tag, n]) => `${tag}=${n}`)
				.join(","),
		].join("\t")
	)
}

console.log(
	[
		"TOTAL",
		total(geonamesCount),
		total((r) => r.wofCeased),
		total((r) => r.joined),
		total((r) => r.codeStates.retired),
		total((r) => r.codeStates.shared),
		total((r) => r.codeStates.ambiguous),
		total((r) => r.codeStates.absent),
		total((r) => r.codeStates.uncoded),
		total((r) => r.untagged),
		total((r) => r.linkedUntagged),
		total((r) => r.linked.geonames_hierarchy),
		total((r) => r.linked.geonames_admin_codes),
		total((r) => r.linked.wof_supersession),
		total((r) => r.linkedAny),
		"",
	].join("\t")
)

log(`wrote ${divisions.length} linked divisions to ${outPath}`)
