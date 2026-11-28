// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Writes a Who's On First `country` record for each former country of a specification into
 *   the `mailwoman` fork of `whosonfirst-data-admin-xy`, the repository for places of no one country.
 *
 *   The specification is what Wikidata (CC0) states about each item that holds an ISO 3166-3
 *   code, the standard's list of country names it has withdrawn: the item's labels, point,
 *   inception, dissolution and successors. Wikidata's wider classes of former state also hold
 *   periods of a state that still exists and former subnational units, so the code is the test.
 *
 *   Each record is a point, ceased on the item's dissolution date and not current. It is
 *   superseded by each successor with a current `country` record in a fork, and by each
 *   successor in the same specification. No existing record changes: a successor's own `wof:supersedes`
 *   stays as it is.
 *
 *   A state that a record already holds by its Wikidata id is skipped, so a second run writes
 *   zero records.
 */

import { sortedGlob, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { git } from "@mailwoman/core/repo/git"
import { nextMailwomanWOFID } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { parseJSONStrict } from "@mailwoman/core/values/json"
import { isPresent } from "@mailwoman/core/values/objects"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { parallelMap, TextSpliterator } from "spliterator"

import { mailwomanWOFIDs, writeWOFRecord, type WOFRecordFeature } from "#tools/pipeline/wof/record"
import { wofGeometryHash } from "#tools/pipeline/wof/slim"

/**
 * The repository and the `wof:country` of a place of no one country.
 */
const MULTI_COUNTRY_REPO = "whosonfirst-data-admin-xy"
const MULTI_COUNTRY_CODE = "XY"

/**
 * The forks searched at once for a successor's record.
 * Each search is one `git grep` child process.
 */
const SEARCH_CONCURRENCY = 4

/**
 * The stdout a search of one fork may return: a list of matching paths.
 */
const SEARCH_BYTES = 16 * 1024 * 1024

/**
 * One former country, as Wikidata states it.
 */
export interface FormerCountry {
	wikidata: string
	/**
	 * The four-letter ISO 3166-3 code, `SUHH`.
	 */
	iso3166_3: string
	/**
	 * The English label.
	 */
	name: string
	/**
	 * The English aliases.
	 */
	variants: readonly string[]
	/**
	 * The label in other languages, by three-letter language code.
	 */
	names: Readonly<Record<string, string>>
	/**
	 * Longitude and latitude.
	 */
	point: readonly [number, number]
	/**
	 * EDTF dates, `uuuu` when Wikidata states none.
	 */
	inception: string
	cessation: string
	/**
	 * The Wikidata ids of the states that replaced it.
	 */
	successors: readonly string[]
}

/**
 * The former countries to write, and the day Wikidata was read.
 */
export interface FormerCountrySpec {
	read: string
	states: readonly FormerCountry[]
}

/**
 * Options for {@link writeFormerCountries}.
 */
export interface FormerCountryOptions {
	spec: FormerCountrySpec
	reposRoot: PathBuilderLike
	dryRun?: boolean
	lastModified: number
}

/**
 * What {@link writeFormerCountries} did, or would do under `dryRun`.
 */
export interface FormerCountryResult {
	repoDir: string
	written: Array<{ id: number; wikidata: string; name: string; supersededBy: number[]; supersedes: number[] }>
	/**
	 * States a record of some fork already holds by Wikidata id.
	 */
	alreadyHeld: Array<{ wikidata: string; name: string; id: number }>
	/**
	 * Successors Wikidata states that are neither a current country record nor in the specification.
	 */
	unresolved: Array<{ wikidata: string; name: string; successor: string }>
}

/**
 * The records of every fork that hold one of `wikidataIDs` as `wd:id`, by that id.
 */
async function recordsByWikidataID(
	reposRoot: PathBuilder,
	wikidataIDs: readonly string[]
): Promise<Map<string, WOFRecordFeature[]>> {
	const forks = await sortedGlob(reposRoot, "whosonfirst-data-admin-*", { onlyFiles: false })
	const pattern = `"wd:id": ?"(${wikidataIDs.join("|")})"`
	const found = new Map<string, WOFRecordFeature[]>()

	const searches = parallelMap(
		forks,
		async (fork) => {
			// `git grep` exits 1 when a fork holds zero matches, and the client throws on it.
			// A fork that fails for another reason leaves a successor unresolved.
			// The result lists each unresolved successor.
			const paths = await git(["grep", "-l", "-E", pattern, "--", "data"], fork, SEARCH_BYTES).catch(() => "")

			return Promise.all(
				[...TextSpliterator.from(paths)]
					.filter((path) => /(?:^|\/)\d+\.geojson$/u.test(path))
					.map(async (path) => parseJSONStrict<WOFRecordFeature>(await readLocalTextFile(PathBuilder.from(fork)(path))))
			)
		},
		{ concurrency: SEARCH_CONCURRENCY }
	)

	for await (const features of searches) {
		for (const feature of features) {
			const concordances = feature.properties["wof:concordances"] as Record<string, unknown> | undefined
			const wikidata = String(concordances?.["wd:id"] ?? "")

			found.set(wikidata, [...(found.get(wikidata) ?? []), feature])
		}
	}

	return found
}

/**
 * Writes a ceased `country` point record for each former country of `options.spec`.
 */
export async function writeFormerCountries(options: FormerCountryOptions): Promise<FormerCountryResult> {
	const { spec } = options
	const reposRoot = PathBuilder.from(options.reposRoot)
	const repoDir = reposRoot(MULTI_COUNTRY_REPO)
	const wanted = [...new Set(spec.states.flatMap((state) => [state.wikidata, ...state.successors]))]
	const held = await recordsByWikidataID(reposRoot, wanted)
	const minted = await mailwomanWOFIDs(await sortedGlob(reposRoot, "whosonfirst-data-*", { onlyFiles: false }))

	const result: FormerCountryResult = { repoDir: repoDir.toString(), written: [], alreadyHeld: [], unresolved: [] }

	// The id of each state of the specification: the record that holds it, or a new id.
	const idOf = new Map<string, number>()
	const fresh: FormerCountry[] = []

	for (const state of spec.states) {
		const existing = held.get(state.wikidata)?.[0]

		if (existing) {
			idOf.set(state.wikidata, existing.id)
			result.alreadyHeld.push({ wikidata: state.wikidata, name: state.name, id: existing.id })

			continue
		}

		const id = nextMailwomanWOFID(minted)

		minted.add(id)
		idOf.set(state.wikidata, id)
		fresh.push(state)
	}

	const currentCountry = (wikidata: string): number | null =>
		held
			.get(wikidata)
			?.find(
				(feature) => feature.properties["wof:placetype"] === "country" && feature.properties["mz:is_current"] !== 0
			)?.id ?? null

	const newRecords: WOFRecordFeature[] = []

	for (const state of fresh) {
		const id = idOf.get(state.wikidata)!
		const supersededBy: number[] = []

		for (const successor of state.successors) {
			const successorID = idOf.get(successor) ?? currentCountry(successor)

			if (isPresent(successorID)) {
				supersededBy.push(successorID)
			} else {
				result.unresolved.push({ wikidata: state.wikidata, name: state.name, successor })
			}
		}

		const supersedes = spec.states
			.filter((other) => other.successors.includes(state.wikidata))
			.map((other) => idOf.get(other.wikidata))
			.filter(isPresent)

		const [longitude, latitude] = state.point
		const geometry = { type: "Point", coordinates: [longitude, latitude] }
		const url = `https://www.wikidata.org/wiki/${state.wikidata}`
		const wikidata = `Wikidata ${state.wikidata}, read on ${spec.read}`

		const names = Object.fromEntries(
			Object.entries(state.names).map(([language, label]) => [`name:${language}_x_preferred`, [label]])
		)

		result.written.push({ id, wikidata: state.wikidata, name: state.name, supersededBy, supersedes })

		newRecords.push({
			id,
			type: "Feature",
			properties: {
				"edtf:cessation": state.cessation,
				"edtf:inception": state.inception,
				"geom:area": 0,
				"geom:area_square_m": 0,
				"geom:bbox": `${longitude},${latitude},${longitude},${latitude}`,
				"geom:latitude": latitude,
				"geom:longitude": longitude,
				"iso:country": MULTI_COUNTRY_CODE,
				"mailwoman:sources": [
					{
						property: "wof:placetype",
						citation: `${wikidata}: ISO 3166-3 code ${state.iso3166_3} (P773), the standard's code for a country name it has withdrawn.`,
						url,
					},
					{ property: "wof:name", citation: `${wikidata}: its labels and English aliases`, url },
					{ property: "geometry", citation: `${wikidata}: coordinate location (P625)`, url },
					{
						property: "edtf:cessation",
						citation: `${wikidata}: inception (P571) and dissolved, abolished or demolished date (P576)`,
						url,
					},
					{ property: "wof:superseded_by", citation: `${wikidata}: replaced by (P1366)`, url },
				],
				"mz:hierarchy_label": 1,
				"mz:is_current": 0,
				"name:eng_x_preferred": [state.name],
				...(state.variants.length ? { "name:eng_x_variant": [...state.variants] } : {}),
				...names,
				"src:geom": "wikidata",
				"wof:belongsto": [],
				"wof:breaches": [],
				"wof:concordances": { "wd:id": state.wikidata },
				"wof:country": MULTI_COUNTRY_CODE,
				"wof:geomhash": wofGeometryHash(geometry),
				"wof:hierarchy": [{ country_id: id }],
				"wof:id": id,
				"wof:lastmodified": options.lastModified,
				"wof:name": state.name,
				"wof:parent_id": -1,
				"wof:placetype": "country",
				"wof:repo": MULTI_COUNTRY_REPO,
				"wof:superseded_by": supersededBy.toSorted((a, b) => a - b),
				"wof:supersedes": supersedes.toSorted((a, b) => a - b),
				"wof:tags": [],
			},
			bbox: [longitude, latitude, longitude, latitude],
			geometry,
		})
	}

	if (!options.dryRun) {
		for (const record of newRecords) {
			await writeWOFRecord(repoDir, record)
		}
	}

	return result
}
