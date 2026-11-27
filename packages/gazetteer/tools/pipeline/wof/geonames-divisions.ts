// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Completes a fork's first- and second-level divisions from GeoNames, for a country whose
 *   fork holds part of them and files the rest under no parent.
 *
 *   The specification states the placetype of each GeoNames level. For each current GeoNames
 *   division of those levels, the tool does one of three things:
 *
 *   - A fork record that holds the division's GeoNames id is kept. When its parent is unset, it
 *     takes the record of the division GeoNames files it under.
 *   - A fork record the specification states is the division, without holding its id, takes the
 *     id, the level's placetype and the parent.
 *   - A division with no record gets a point record. GeoNames is CC BY 4.0, and it publishes a
 *     point and no boundary.
 *
 *   A record already filed under a parent keeps it, and a second run changes zero files.
 */

import { sortedGlob } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { nextMailwomanWOFID } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { PathBuilder, type PathBuilderLike } from "path-ts"

import { readGeonamesDivisions, type GeonamesCurrentDivision } from "#tools/pipeline/admin/former-divisions"
import { mailwomanWOFIDs, patchWOFRecordText, writeWOFRecord, type WOFRecordFeature } from "#tools/pipeline/wof/record"
import { concordancesOf, hierarchyOf, loadForkRecords, type LoadedRecord } from "#tools/pipeline/wof/region-reform"
import { wofGeometryHash } from "#tools/pipeline/wof/slim"
import { wofRepoName } from "#whosonfirst/extract-repo"

/**
 * The divisions of one country to complete.
 */
export interface GeoNamesDivisionSpec {
	/**
	 * The ISO 3166-1 alpha-2 code of the fork.
	 */
	country: string
	/**
	 * The WOF placetype of each GeoNames level, as `{ "1": "region", "2": "county" }`.
	 * The tool reads and writes only the levels listed.
	 */
	placetypes: Readonly<Record<string, string>>
	/**
	 * Endings a GeoNames name has and a WOF name leaves out, such as ` District`.
	 */
	nameSuffixes?: readonly string[]
	/**
	 * Fork records that are a GeoNames division without holding its id: GeoNames id to WOF id.
	 */
	existing?: Readonly<Record<string, number>>
}

/**
 * What {@link backfillGeoNamesDivisions} did, or would do under `dryRun`.
 */
export interface GeoNamesDivisionResult {
	repoDir: string
	written: Array<{ id: number; geonamesID: number; name: string; placetype: string; parent: number }>
	/**
	 * Records the fork already held that took a parent, a concordance or a placetype.
	 */
	changed: Array<{ id: number; name: string; parent: number; placetype: string }>
	/**
	 * Records below a changed record whose hierarchy was rewritten to follow it.
	 */
	descendants: number
	/**
	 * Divisions whose record already states a parent.
	 */
	kept: number
}

/**
 * Options for {@link backfillGeoNamesDivisions}.
 */
export interface GeoNamesDivisionOptions {
	spec: GeoNamesDivisionSpec
	reposRoot: PathBuilderLike
	geonamesDir: PathBuilderLike
	dryRun?: boolean
	lastModified: number
}

function codeKey(division: Pick<GeonamesCurrentDivision, "codes">, level: number): string {
	return division.codes.slice(0, level).join("|")
}

/**
 * Completes the divisions `options.spec` describes in its country's admin fork.
 */
export async function backfillGeoNamesDivisions(options: GeoNamesDivisionOptions): Promise<GeoNamesDivisionResult> {
	const { spec } = options
	const reposRoot = PathBuilder.from(options.reposRoot)
	const country = spec.country.toUpperCase()
	const repoName = wofRepoName("admin", country)
	const repoDir = reposRoot(repoName)
	const records = await loadForkRecords(repoDir)
	const { current } = await readGeonamesDivisions(PathBuilder.from(options.geonamesDir)(`${country}.txt`))
	const byGeoNamesID = new Map<number, LoadedRecord>()
	let countryRecord: LoadedRecord | null = null

	for (const record of records.values()) {
		const geonamesID = Number(concordancesOf(record)["gn:id"])
		const placetype = record.feature.properties["wof:placetype"]

		if (placetype === "country" && record.feature.properties["mz:is_current"] !== 0) {
			countryRecord = record
		}

		if (Number.isInteger(geonamesID) && geonamesID > 0 && Object.values(spec.placetypes).includes(String(placetype))) {
			byGeoNamesID.set(geonamesID, record)
		}
	}

	if (!countryRecord) throw new Error(`${repoName}: the fork holds no current country record`)

	for (const [geonamesID, wofID] of Object.entries(spec.existing ?? {})) {
		const record = records.get(wofID)

		if (!record) throw new Error(`${repoName}: the specification states WOF ${wofID}, which the fork doesn't hold`)

		byGeoNamesID.set(Number(geonamesID), record)
	}

	const levels = Object.keys(spec.placetypes)
		.map(Number)
		.toSorted((a, b) => a - b)

	const divisions = current.filter((division) => levels.includes(division.level))

	const byCode = new Map(
		divisions.map((division) => [`${division.level}:${codeKey(division, division.level)}`, division])
	)

	const minted = await mailwomanWOFIDs(await sortedGlob(reposRoot, "whosonfirst-data-*", { onlyFiles: false }))

	const result: GeoNamesDivisionResult = {
		repoDir: repoDir.toString(),
		written: [],
		changed: [],
		descendants: 0,
		kept: 0,
	}

	const writes = new Map<string, string>()
	const newRecords: WOFRecordFeature[] = []

	/**
	 * The hierarchy branch of each division handled so far, by GeoNames id.
	 * A lower level reads it.
	 */
	const branches = new Map<number, Record<string, number>>()
	const retyped = new Map<number, Record<string, number>>()

	for (const level of levels) {
		const placetype = spec.placetypes[String(level)]!

		for (const division of divisions.filter((row) => row.level === level)) {
			const above = levels
				.filter((other) => other < level)
				.toReversed()
				.map((other) => byCode.get(`${other}:${codeKey(division, other)}`))
				.find((row) => row && branches.has(row.geonamesID))

			const parentBranch = above ? branches.get(above.geonamesID)! : hierarchyOf(countryRecord)[0]!
			const parentID = above ? byGeoNamesID.get(above.geonamesID)!.feature.id : countryRecord.feature.id
			const existing = byGeoNamesID.get(division.geonamesID)

			const suffix = (spec.nameSuffixes ?? []).find((ending) => division.name.endsWith(ending))
			const name = suffix ? division.name.slice(0, -suffix.length) : division.name

			const url = `https://www.geonames.org/${division.geonamesID}`
			const geonames = `GeoNames division ${division.geonamesID} (${division.name})`

			if (existing) {
				const { properties } = existing.feature
				const branch = { ...parentBranch, [`${placetype}_id`]: existing.feature.id }

				branches.set(division.geonamesID, branch)

				const settled =
					Number(properties["wof:parent_id"]) > 0 &&
					properties["wof:placetype"] === placetype &&
					Number(concordancesOf(existing)["gn:id"]) === division.geonamesID

				if (settled) {
					result.kept++

					continue
				}

				if (properties["wof:placetype"] !== placetype) {
					retyped.set(existing.feature.id, branch)
				}

				const sources = Array.isArray(properties["mailwoman:sources"]) ? properties["mailwoman:sources"] : []

				writes.set(
					existing.path,
					patchWOFRecordText(existing.text, {
						"mailwoman:sources": [
							...sources,
							{
								property: "wof:hierarchy",
								citation: `${geonames}: a level ${level} division${above ? ` under GeoNames division ${above.geonamesID} (${above.name})` : ""}.`,
								url,
							},
						],
						"wof:belongsto": Object.values(parentBranch).toSorted((a, b) => a - b),
						"wof:concordances": { ...concordancesOf(existing), "gn:id": division.geonamesID },
						"wof:hierarchy": [branch],
						"wof:lastmodified": options.lastModified,
						"wof:parent_id": parentID,
						"wof:placetype": placetype,
					})
				)

				result.changed.push({
					id: existing.feature.id,
					name: String(properties["wof:name"]),
					parent: parentID,
					placetype,
				})

				continue
			}

			const id = nextMailwomanWOFID(minted)

			minted.add(id)

			const branch = { ...parentBranch, [`${placetype}_id`]: id }
			const geometry = { type: "Point", coordinates: [division.longitude, division.latitude] }

			const feature: WOFRecordFeature = {
				id,
				type: "Feature",
				properties: {
					"edtf:cessation": "uuuu",
					"edtf:inception": "uuuu",
					"geom:area": 0,
					"geom:area_square_m": 0,
					"geom:bbox": `${division.longitude},${division.latitude},${division.longitude},${division.latitude}`,
					"geom:latitude": division.latitude,
					"geom:longitude": division.longitude,
					...(division.population > 0 ? { "gn:population": division.population } : {}),
					"iso:country": country,
					"mailwoman:sources": [
						{ property: "wof:name", citation: `${geonames}: its name`, url },
						{ property: "geometry", citation: `${geonames}: its point. GeoNames publishes no boundary.`, url },
						{ property: "wof:concordances", citation: `${geonames}: its id`, url },
						{
							property: "wof:hierarchy",
							citation: `${geonames}: a level ${level} division${above ? ` under GeoNames division ${above.geonamesID} (${above.name})` : ""}.`,
							url,
						},
					],
					"mz:is_current": 1,
					"name:eng_x_preferred": [name],
					...(name === division.name ? {} : { "name:eng_x_variant": [division.name] }),
					"src:geom": "geonames",
					"wof:belongsto": Object.values(parentBranch).toSorted((a, b) => a - b),
					"wof:breaches": [],
					"wof:concordances": { "gn:id": division.geonamesID },
					"wof:country": country,
					"wof:geomhash": wofGeometryHash(geometry),
					"wof:hierarchy": [branch],
					"wof:id": id,
					"wof:lastmodified": options.lastModified,
					"wof:name": name,
					"wof:parent_id": parentID,
					"wof:placetype": placetype,
					"wof:repo": repoName,
					"wof:superseded_by": [],
					"wof:supersedes": [],
					"wof:tags": [],
				},
				bbox: [division.longitude, division.latitude, division.longitude, division.latitude],
				geometry,
			}

			branches.set(division.geonamesID, branch)
			byGeoNamesID.set(division.geonamesID, { path: "", text: "", feature })
			newRecords.push(feature)
			result.written.push({ id, geonamesID: division.geonamesID, name, placetype, parent: parentID })
		}
	}

	// A record below a retyped one stated it at its former tier, and follows it to the new one.
	for (const record of records.values()) {
		const branch = hierarchyOf(record)[0] ?? {}
		const moved = Object.values(branch).find((id) => retyped.has(id) && id !== record.feature.id)

		if (!moved || hierarchyOf(record).length !== 1) continue

		const placetype = String(record.feature.properties["wof:placetype"])
		const hierarchy = { ...retyped.get(moved)!, [`${placetype}_id`]: record.feature.id }

		writes.set(
			record.path,
			patchWOFRecordText(record.text, {
				"wof:belongsto": Object.values(hierarchy)
					.filter((id) => id !== record.feature.id)
					.toSorted((a, b) => a - b),
				"wof:hierarchy": [hierarchy],
				"wof:lastmodified": options.lastModified,
			})
		)

		result.descendants++
	}

	if (!options.dryRun) {
		for (const [path, text] of writes) {
			await writeLocalTextFile(text, path)
		}

		for (const record of newRecords) {
			await writeWOFRecord(repoDir, record)
		}
	}

	return result
}
