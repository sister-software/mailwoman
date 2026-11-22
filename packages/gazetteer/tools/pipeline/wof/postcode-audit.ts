// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Audits the Who's On First postcode clones against what `@mailwoman/postcode`
 *   and the gazetteer build expect of a postcode record.
 *
 *   Each clone is a `whosonfirst-data-postalcode-<cc>` checkout.
 *   The audit reads every record the clone tracks through the doctor's readers
 *   and reports four findings over the clone's current records:
 *
 *   1. Format: `acceptPostcode(wof:name, country)` returns null.
 *   2. Geometry: `geom:latitude` and `geom:longitude` are both 0.
 *   3. Corroboration: `src:geom` is `geoplanet` and the GeoNames postal exports
 *      hold zero row for the postcode.
 *   4. Shared postcode: the same `wof:name` is current in more than one country clone.
 *
 *   A record is current unless it holds a date in `edtf:deprecated`, `mz:is_current`
 *   equal to 0, or a non-empty `wof:superseded_by`.
 *
 *   GeoNames files a territory's postcodes under the territory's own country code.
 *   A WOF record states that code in `iso:country`, as `GU` on the Guam records of the United States clone.
 *
 *   Before the audit reports a postcode uncorroborated, it reads the export of the
 *   record's `iso:country` beside the clone country's own.
 *
 *   A finding the audit couldn't measure has a state other than `measured` and a null count.
 *   A country without a stated postcode format, a missing export and an unreadable clone
 *   are each reported as such, and none of them is reported as a count of zero.
 */

import { dependentTerritories, hasCountry } from "@mailwoman/codex/country/sets"
import { isCurrentFeature } from "@mailwoman/corpus/utils/wof-json"
import { acceptPostcode, statesPostcodeSyntax } from "@mailwoman/postcode/country-formats"
import type { PathBuilderLike } from "path-ts"
import { parallelMap } from "spliterator"

import {
	findGeonamesPostalExport,
	geonamesPostcodeKey,
	readGeonamesPostalExport,
} from "#tools/pipeline/postcode/geonames/export"
import { type DoctorClone, readRecordProperties, trackedRecordPaths } from "#tools/pipeline/wof/doctor"
import { isDeprecatedWithoutSuccessor } from "#tools/pipeline/wof/slim"

/**
 * The `src:geom` value of a record whose only source is GeoPlanet.
 */
const GEOPLANET_SOURCE = "geoplanet"

/**
 * The most unreadable records each clone's report keeps as examples.
 */
const UNREADABLE_SAMPLE_LIMIT = 20

/**
 * Whether a finding was measured, and the reason when it wasn't.
 */
export const FindingState = {
	/**
	 * The count and ids cover every current record of the clone.
	 */
	Measured: "measured",
	/**
	 * The postcode package states no format for the country, so `acceptPostcode` answers null for every value.
	 */
	NoStatedFormat: "no-stated-format",
	/**
	 * The export directory holds neither `<CC>.txt` nor `<CC>.zip` for the clone's country.
	 */
	NoExport: "no-export",
	/**
	 * The clone country's export exists and couldn't be read to its end.
	 */
	ExportUnread: "export-unread",
} as const

/**
 * A finding state.
 */
export type FindingState = (typeof FindingState)[keyof typeof FindingState]

/**
 * One finding over a clone's current records.
 */
export interface PostcodeFinding {
	state: FindingState
	/**
	 * The records the finding reports, or null when the state isn't `measured`.
	 */
	count: number | null
	/**
	 * The `wof:id` of each reported record, ascending.
	 */
	ids: number[]
	/**
	 * Why the finding wasn't measured, when it wasn't.
	 */
	reason?: string
}

/**
 * One GeoNames postal export the audit consulted for a clone.
 */
export interface ConsultedExport {
	country: string
	/**
	 * Whether `COUNTRY_REFERENCE` marks the code as a dependency or territory.
	 */
	dependency: boolean
	/**
	 * The file read, or null when the directory holds none for the country.
	 */
	artifact: string | null
	/**
	 * Records and distinct postcodes read, or null when the export is missing or unreadable.
	 */
	rows: number | null
	postcodes: number | null
	/**
	 * The read error, or null.
	 */
	error: string | null
}

/**
 * The corroboration finding with the counts it's derived from.
 */
export interface CorroborationFinding extends PostcodeFinding {
	/**
	 * Every export consulted: the clone country's own, then each `iso:country` a
	 * GeoPlanet record stated, in country-code order.
	 */
	exports: ConsultedExport[]
	/**
	 * Current records whose `src:geom` is `geoplanet`.
	 */
	geoplanet: number
	/**
	 * Current records of any source that the clone country's own export lacks, or null when it wasn't read.
	 */
	absentFromCountryExport: number | null
	/**
	 * GeoPlanet records the clone country's own export lacks, before any territory export is read.
	 */
	geoplanetAbsentFromCountryExport: number | null
	/**
	 * GeoPlanet records the clone country's export lacks and a territory export holds.
	 */
	corroboratedByTerritory: number | null
	/**
	 * GeoPlanet records the clone country's export lacks whose `iso:country` export is missing or unreadable.
	 *
	 * They're left out of `count`, because their territory's rows weren't read.
	 */
	territoryUnread: { count: number; ids: number[] }
}

/**
 * What the audit read from one clone.
 */
export interface PostcodeCloneAudit {
	repo: string
	country: string
	read: true
	/**
	 * Records read with a numeric `wof:id`.
	 */
	records: number
	current: number
	/**
	 * Records left out because they're deprecated, superseded or marked as no longer current.
	 */
	skipped: number
	unreadable: { count: number; sample: Array<{ path: string; error: string }> }
	/**
	 * Current records by `src:geom`, with `(none)` for a record that states none.
	 */
	sources: Record<string, number>
	/**
	 * Current records by `iso:country`, with `(none)` for a record that states none.
	 */
	recordCountries: Record<string, number>
	/**
	 * Current records without a numeric `geom:latitude` and `geom:longitude`,
	 * which the geometry finding can't judge.
	 */
	geometryUnstated: number
	format: PostcodeFinding
	geometry: PostcodeFinding
	corroboration: CorroborationFinding
	/**
	 * Current records whose postcode is current in another clone that was read.
	 */
	shared: PostcodeFinding
}

/**
 * A clone the audit couldn't read to its end.
 * It contributes no count.
 */
export interface UnreadPostcodeClone {
	repo: string
	country: string
	read: false
	error: string
}

/**
 * One record of a shared postcode, with whether it passes each of the first three findings.
 * A null means that finding wasn't measured for the record.
 */
export interface SharedPostcodeRecord {
	country: string
	id: number
	format: boolean | null
	geometry: boolean
	corroboration: boolean | null
}

/**
 * What {@linkcode auditPostcodeClones} found.
 */
export interface PostcodeAuditReport {
	geonamesDirectory: string
	clones: Array<PostcodeCloneAudit | UnreadPostcodeClone>
	/**
	 * Each postcode current in more than one read clone, in postcode order.
	 */
	shared: Array<{ postcode: string; records: SharedPostcodeRecord[] }>
}

/**
 * A postcode clone to audit: a doctor clone with the country its name encodes.
 */
export interface PostcodeClone extends DoctorClone {
	country: string
}

/**
 * Whether a record's properties leave it out of the audit: a date in `edtf:deprecated`,
 * `mz:is_current` equal to 0, or a non-empty `wof:superseded_by`.
 */
export function isRetiredPostcodeRecord(properties: Record<string, unknown>): boolean {
	const successors = properties["wof:superseded_by"]

	return (
		(Array.isArray(successors) && successors.length > 0) ||
		isDeprecatedWithoutSuccessor({ properties }) ||
		!isCurrentFeature(properties)
	)
}

interface LoadedExport extends ConsultedExport {
	keys: ReadonlySet<string> | null
}

/**
 * Reads `country`'s export to its end and keeps each postcode's comparison key.
 */
async function loadExport(directory: PathBuilderLike, country: string): Promise<LoadedExport> {
	const base = { country, dependency: hasCountry(dependentTerritories(), country) }

	try {
		const artifact = await findGeonamesPostalExport(directory, country)

		if (!artifact) return { ...base, artifact: null, rows: null, postcodes: null, error: null, keys: null }

		const keys = new Set<string>()
		let rows = 0

		for await (const columns of readGeonamesPostalExport(artifact, country)) {
			rows++
			keys.add(geonamesPostcodeKey(columns[1]!))
		}

		return { ...base, artifact, rows, postcodes: keys.size, error: null, keys }
	} catch (error) {
		return {
			...base,
			artifact: null,
			rows: null,
			postcodes: null,
			error: error instanceof Error ? error.message : String(error),
			keys: null,
		}
	}
}

function tally(counts: Record<string, number>, value: unknown): void {
	const key = typeof value === "string" && value ? value : "(none)"

	counts[key] = (counts[key] ?? 0) + 1
}

const ascending = (a: number, b: number) => a - b

/**
 * Reads every record the postcode clones track and reports the four findings for each clone.
 *
 * `geonamesDirectory` holds the GeoNames postal exports as `<CC>.txt` or `<CC>.zip`.
 * A clone whose listing or scan throws is returned as {@linkcode UnreadPostcodeClone}
 * and takes no part in the shared-postcode finding.
 *
 * @throws When two clones encode the same country.
 */
export async function auditPostcodeClones(
	clones: readonly PostcodeClone[],
	opts: {
		geonamesDirectory: PathBuilderLike
		concurrency?: number
		listRecords?: (directory: PathBuilderLike) => Iterable<string> | AsyncIterable<string>
		onClone?: (audit: PostcodeCloneAudit | UnreadPostcodeClone) => void
	}
): Promise<PostcodeAuditReport> {
	const listRecords = opts.listRecords ?? trackedRecordPaths
	const countries = clones.map((clone) => clone.country.toUpperCase())
	const repeated = countries.find((country, index) => countries.indexOf(country) !== index)

	// The shared-postcode finding identifies a record's clone by its country.
	if (repeated) throw new Error(`two clones encode the country ${repeated}`)

	const exportsByCountry = new Map<string, Promise<LoadedExport>>()

	const exportOf = (country: string): Promise<LoadedExport> => {
		let loaded = exportsByCountry.get(country)

		if (!loaded) {
			loaded = loadExport(opts.geonamesDirectory, country)
			exportsByCountry.set(country, loaded)
		}

		return loaded
	}

	const report: PostcodeAuditReport = {
		geonamesDirectory: opts.geonamesDirectory.toString(),
		clones: [],
		shared: [],
	}

	// Each postcode's current records across the read clones, by comparison key.
	const holders = new Map<string, SharedPostcodeRecord[]>()

	for (const clone of clones) {
		const country = clone.country.toUpperCase()
		const stated = statesPostcodeSyntax(country)
		const own = await exportOf(country)
		const consulted = new Map<string, LoadedExport>([[country, own]])

		const audit: PostcodeCloneAudit = {
			repo: clone.repo,
			country,
			read: true,
			records: 0,
			current: 0,
			skipped: 0,
			unreadable: { count: 0, sample: [] },
			sources: {},
			recordCountries: {},
			geometryUnstated: 0,
			format: stated
				? { state: FindingState.Measured, count: 0, ids: [] }
				: {
						state: FindingState.NoStatedFormat,
						count: null,
						ids: [],
						reason: `the postcode package states no format for ${country}`,
					},
			geometry: { state: FindingState.Measured, count: 0, ids: [] },
			corroboration: {
				state: own.keys ? FindingState.Measured : own.error ? FindingState.ExportUnread : FindingState.NoExport,
				count: own.keys ? 0 : null,
				ids: [],
				...(own.keys
					? {}
					: { reason: own.error ?? `${report.geonamesDirectory} holds no ${country}.txt or ${country}.zip` }),
				exports: [],
				geoplanet: 0,
				absentFromCountryExport: own.keys ? 0 : null,
				geoplanetAbsentFromCountryExport: own.keys ? 0 : null,
				corroboratedByTerritory: own.keys ? 0 : null,
				territoryUnread: { count: 0, ids: [] },
			},
			shared: { state: FindingState.Measured, count: 0, ids: [] },
		}

		const { corroboration } = audit
		const cloneRecords: Array<{ key: string; record: SharedPostcodeRecord }> = []

		// Whether the export of a record's own `iso:country` holds a postcode the clone country's export lacks.
		// Null means that export is missing or unreadable.
		const territoryCorroborates = async (
			properties: Record<string, unknown>,
			id: number,
			key: string
		): Promise<boolean | null> => {
			const recordCountry = properties["iso:country"]

			const territory =
				typeof recordCountry === "string" && /^[A-Za-z]{2}$/.test(recordCountry) ? recordCountry.toUpperCase() : country

			if (territory === country) return false

			const other = await exportOf(territory)

			consulted.set(territory, other)

			if (!other.keys) {
				corroboration.territoryUnread.ids.push(id)

				return null
			}

			if (!other.keys.has(key)) return false

			corroboration.corroboratedByTerritory!++

			return true
		}

		try {
			const read = parallelMap(
				listRecords(clone.directory),
				async (
					path
				): Promise<{ path: string; properties: Record<string, unknown> } | { path: string; error: string }> => {
					try {
						return {
							path,
							properties: (await readRecordProperties(`${clone.directory.toString()}/${path}`)).properties,
						}
					} catch (error) {
						return { path, error: error instanceof Error ? error.message : String(error) }
					}
				},
				{ concurrency: opts.concurrency ?? 32 }
			)

			for await (const result of read) {
				const properties = "properties" in result ? result.properties : null
				const id = properties?.["wof:id"]

				if (!properties || typeof id !== "number") {
					audit.unreadable.count++

					if (audit.unreadable.sample.length < UNREADABLE_SAMPLE_LIMIT) {
						audit.unreadable.sample.push({
							path: result.path,
							error: "error" in result ? result.error : "the properties hold no numeric wof:id",
						})
					}

					continue
				}

				audit.records++

				if (isRetiredPostcodeRecord(properties)) {
					audit.skipped++

					continue
				}

				audit.current++
				tally(audit.sources, properties["src:geom"])
				tally(audit.recordCountries, properties["iso:country"])

				const name = typeof properties["wof:name"] === "string" ? properties["wof:name"] : ""
				const key = geonamesPostcodeKey(name)
				const refused = stated && acceptPostcode(name, country) === null

				if (refused) {
					audit.format.ids.push(id)
				}

				const latitude = properties["geom:latitude"]
				const longitude = properties["geom:longitude"]
				const atOrigin = latitude === 0 && longitude === 0

				if (typeof latitude !== "number" || typeof longitude !== "number") {
					audit.geometryUnstated++
				} else if (atOrigin) {
					audit.geometry.ids.push(id)
				}

				const geoplanet = properties["src:geom"] === GEOPLANET_SOURCE
				// Null while unmeasured: the clone country's export, or the record's territory export, wasn't read.
				let corroborated: boolean | null = own.keys ? true : null

				if (geoplanet) {
					corroboration.geoplanet++
				}

				const absent = own.keys ? !own.keys.has(key) : false

				if (absent) {
					corroboration.absentFromCountryExport!++
				}

				if (absent && geoplanet) {
					corroboration.geoplanetAbsentFromCountryExport!++
					corroborated = await territoryCorroborates(properties, id, key)
				}

				if (corroborated === false) {
					corroboration.ids.push(id)
				}

				cloneRecords.push({
					key,
					record: { country, id, format: stated ? !refused : null, geometry: !atOrigin, corroboration: corroborated },
				})
			}
		} catch (error) {
			const unread: UnreadPostcodeClone = {
				repo: clone.repo,
				country,
				read: false,
				error: error instanceof Error ? error.message : String(error),
			}

			report.clones.push(unread)
			opts.onClone?.(unread)

			continue
		}

		for (const finding of [audit.format, audit.geometry, corroboration]) {
			finding.ids.sort(ascending)

			if (finding.state === FindingState.Measured) {
				finding.count = finding.ids.length
			}
		}

		corroboration.territoryUnread.ids.sort(ascending)
		corroboration.territoryUnread.count = corroboration.territoryUnread.ids.length
		// The order records are read in differs between machines, so the other exports are listed by country code.
		const [ownExport, ...otherExports] = [...consulted.values()]

		corroboration.exports = [ownExport!, ...otherExports.toSorted((a, b) => a.country.localeCompare(b.country))].map(
			({ keys: _keys, ...consultedExport }) => consultedExport
		)

		for (const { key, record } of cloneRecords) {
			// A record without a name shares no postcode with another.
			if (!key) continue

			const records = holders.get(key)

			if (records) {
				records.push(record)
			} else {
				holders.set(key, [record])
			}
		}

		report.clones.push(audit)
		opts.onClone?.(audit)
	}

	const audits = new Map(report.clones.flatMap((clone) => (clone.read ? [[clone.country, clone] as const] : [])))

	for (const [postcode, records] of holders) {
		if (new Set(records.map((record) => record.country)).size < 2) continue

		report.shared.push({ postcode, records })

		for (const record of records) {
			audits.get(record.country)!.shared.ids.push(record.id)
		}
	}

	report.shared.sort((a, b) => (a.postcode < b.postcode ? -1 : a.postcode > b.postcode ? 1 : 0))

	for (const audit of audits.values()) {
		audit.shared.ids.sort(ascending)
		audit.shared.count = audit.shared.ids.length
	}

	return report
}
