// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The candidate gazetteer's `layer_manifest`, which identifies its admin ancestor as `source`
 *   and reports an unprovenanced ancestor as `unknown` rather than substituting the file's name.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { LayerFreshnessPolicy, type LayerManifest, LayerTier } from "@mailwoman/core/layers"
import type { layerschemadatabase } from "@mailwoman/core/layers/schema"
import { SYNTHETIC_ID_RANGES } from "@mailwoman/core/resolver/synthetic-id-ranges"
import { licenseIdentifiers } from "@mailwoman/license/obligations"
import { readLicenseRecord } from "@mailwoman/license/record"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"
import { probeManifest } from "mailwoman/data/inventory"
import { basename, type PathBuilderLike } from "path-ts"

import { OVERTURE_PART_NOTICE } from "#tools/pipeline/collective-offer"

/**
 * The ancestor's identity as this manifest records it, where `unknown` is a
 * measured absence rather than a recorded version.
 */
export async function ancestorIdentity(adminDBPath: PathBuilderLike): Promise<string> {
	if (!(await pathExists(adminDBPath))) return "unknown (admin gazetteer not found)"

	const probed = probeManifest(adminDBPath)

	if (probed.error) return `unknown (${probed.error})`

	if (probed.manifest) return `${probed.manifest.name}@${probed.manifest.version}`

	// `probeManifest` answers `{}` for a missing table and an empty one alike — tell those apart.
	try {
		using db = new DatabaseClient<layerschemadatabase>(adminDBPath, { readOnly: true })

		return tableExists(db, "layer_manifest")
			? "unknown (admin manifest is empty)"
			: "unknown (admin gazetteer predates the layer interface)"
	} catch (error) {
		return `unknown (${(error as Error).message})`
	}
}

export interface CandidateManifestInput {
	/**
	 * The admin gazetteer this candidate was built from, read for its manifest rather than its rows.
	 */
	adminDBPath: PathBuilderLike
	/**
	 * Every postcode and locality database whose rows this candidate includes.
	 *
	 * Their paths compose the manifest's license expression.
	 * Their count reaches `sourceVintage`.
	 */
	contributingDatabases: {
		postcodes: readonly PathBuilderLike[]
		localities: readonly PathBuilderLike[]
	}
	/**
	 * The importance build whose scores fill the `importance` column, by path
	 * and md5, or `null` for an empty column.
	 * This changes ranking in a way the schema doesn't show.
	 */
	importance: { path: string; md5: string } | null
	/**
	 * The count of places ranked by the importance build's population estimates,
	 * or absent when the build didn't rank by them.
	 */
	populationEstimated?: number | null
	buildSHA: string
	version: string
	createdAt: string
	/**
	 * Each source's row and place counts on the table this build wrote, from {@linkcode tallyRowsBySource}.
	 *
	 * A caller that passes none records `rows-by-source=unmeasured` rather than a
	 * set of zeroes, because a later reader cannot tell a source that contributed
	 * zero rows from a count that the build skipped.
	 */
	rowsBySource?: readonly SourceRowCount[]
	/**
	 * Whether the build kept the Overture Divisions rows an independent part.
	 *
	 * It did when the admin ancestor recorded its matches in `overture_wof_match`
	 * instead of writing them onto WOF records.
	 */
	overturePart?: boolean
}

/**
 * The identifier that stands for a contributing database whose own terms this build
 * couldn't read, deliberately absent from `KNOWN_OBLIGATIONS` so `summarizeLicense`
 * reports it as unrecognized and `refusalsForPublication` refuses the layer.
 */
export const UNDECLARED_INPUT_LICENSE = "LicenseRef-Undeclared-Input"

/**
 * Where a contributing database recorded its terms, with `none` meaning it
 * records no terms or couldn't be read.
 */
export const InputTermsRecord = {
	LayerManifest: "layer_manifest",
	Meta: "meta",
	DatabaseMeta: "database_meta",
	None: "none",
} as const

export type InputTermsRecord = (typeof InputTermsRecord)[keyof typeof InputTermsRecord]

/**
 * What one contributing database records about its own publication.
 */
export interface InputTerms {
	path: string
	/**
	 * The layer name the manifest records, or the filename when no manifest identifies one.
	 */
	name: string
	recordedIn: InputTermsRecord
	/**
	 * The tier as recorded, or `null` when the database states none.
	 */
	tier: string | null
	/**
	 * The SPDX expression the recorded grant resolves to, or `null` when it states none
	 * or states prose that resolves to no expression.
	 */
	license: string | null
	error: string | null
}

/**
 * The key/value tables a builder wrote its terms into before the manifest existed, consulted in this order.
 */
const TERMS_TABLES = [InputTermsRecord.Meta, InputTermsRecord.DatabaseMeta] as const

/**
 * One source's contribution to a built candidate table, counted by the id range its builder mints from.
 */
export interface SourceRowCount {
	source: string
	rows: number
	places: number
}

/**
 * Count each source's rows and distinct places in a built candidate table.
 *
 * A source's share of a published artifact is recoverable from the artifact itself only
 * while the upstream release is still served.
 * Overture prunes a release from its bucket.
 *
 * The per-country register behind an Overture row is then unreadable,
 * so the count belongs in the manifest at build time.
 *
 * The bounds come from `SYNTHETIC_ID_RANGES`, the same registry each builder mints its
 * place ids from, so a range added there reaches this census without a second list.
 * Rows below the first base contain Who's On First's own ids and are reported under `wof`.
 */
export function tallyRowsBySource(candidateDBPath: PathBuilderLike): SourceRowCount[] {
	using db = new DatabaseClient<layerschemadatabase>(candidateDBPath, { readOnly: true })

	if (!tableExists(db, "candidate")) return []

	const ranges = [...SYNTHETIC_ID_RANGES].toSorted((a, b) => a.base - b.base)

	const bounds: Array<{ source: string; low: number; high: number }> = [
		{ source: "wof", low: 0, high: ranges[0]?.base ?? Number.MAX_SAFE_INTEGER },
	]

	for (const [index, range] of ranges.entries()) {
		bounds.push({ source: range.name, low: range.base, high: ranges[index + 1]?.base ?? Number.MAX_SAFE_INTEGER })
	}

	const counted: SourceRowCount[] = []

	for (const bound of bounds) {
		const row = db
			.prepare(
				`SELECT COUNT(*) AS rows, COUNT(DISTINCT spr_id) AS places FROM candidate WHERE spr_id >= ? AND spr_id < ?`
			)
			.get(bound.low, bound.high) as { rows: number; places: number } | undefined

		// A range holding zero rows is left out rather than recorded at zero.
		// The registry lists every range any builder may mint from.
		// One artifact takes rows from only a handful, so zeroes would outnumber the counts
		// and read as sources this build refused.
		if (row?.rows) {
			counted.push({ source: bound.source, rows: row.rows, places: row.places })
		}
	}

	return counted
}

/**
 * Read what a contributing database records about its tier and grant, resolving a pre-manifest prose
 * grant through `readLicenseRecord` and reporting prose that resolves to no expression as `null`.
 */
export async function readInputTerms(path: PathBuilderLike): Promise<InputTerms> {
	const pathString = path.toString()
	const name = basename(pathString, ".db")

	const none: InputTerms = {
		path: pathString,
		name,
		recordedIn: InputTermsRecord.None,
		tier: null,
		license: null,
		error: null,
	}

	if (!(await pathExists(path))) return { ...none, error: "not found" }

	const probed = probeManifest(path)

	if (probed.error) return { ...none, error: probed.error }

	if (probed.manifest) {
		return {
			path: pathString,
			name: probed.manifest.name,
			recordedIn: InputTermsRecord.LayerManifest,
			tier: probed.manifest.tier ?? null,
			license: probed.manifest.license ? readLicenseRecord(probed.manifest.license).expression : null,
			error: null,
		}
	}

	try {
		using db = new DatabaseClient<layerschemadatabase>(path, { readOnly: true })

		for (const table of TERMS_TABLES) {
			if (!tableExists(db, table)) continue

			const rows = db.prepare(`SELECT key, value FROM ${table} WHERE key IN ('tier', 'license')`).all() as Array<{
				key: string
				value: unknown
			}>

			const values = new Map(rows.map((row) => [row.key, row.value]))
			const tier = values.get("tier")
			const license = values.get("license")

			return {
				path: pathString,
				name,
				recordedIn: table,
				tier: typeof tier === "string" ? tier : null,
				license: typeof license === "string" ? readLicenseRecord(license).expression : null,
				error: null,
			}
		}

		return none
	} catch (error) {
		return { ...none, error: (error as Error).message }
	}
}

/**
 * Every contributing database whose recorded tier permits no publication, excluding a database
 * that states no tier because its undeclared grant already reaches {@link UNDECLARED_INPUT_LICENSE}.
 */
export function inputsRefusingPublication(terms: readonly InputTerms[]): InputTerms[] {
	return terms.filter((input) => input.tier !== null && input.tier !== LayerTier.Shipped)
}

/**
 * Compose the candidate gazetteer's manifest.
 */
export async function candidateLayerManifest(input: CandidateManifestInput): Promise<LayerManifest> {
	const ancestor = await ancestorIdentity(input.adminDBPath)
	const contributing = [...input.contributingDatabases.postcodes, ...input.contributingDatabases.localities]
	const identifiers = new Set<string>()
	let undeclared = 0

	const adminTerms = await readInputTerms(input.adminDBPath)
	const inputTerms = await Promise.all(contributing.map((path) => readInputTerms(path)))
	// The ancestor isn't a contributing database, so the count reads only the contributing databases.
	const buildLocal = inputsRefusingPublication(inputTerms).length

	for (const terms of [adminTerms, ...inputTerms]) {
		if (!terms.license) {
			undeclared++

			continue
		}

		for (const identifier of licenseIdentifiers(terms.license)) {
			identifiers.add(identifier)
		}
	}

	if (undeclared) {
		identifiers.add(UNDECLARED_INPUT_LICENSE)
	}

	return {
		name: "candidate",
		version: input.version,
		schemaVersion: 1,
		// Never `shipped`: the admin ancestor is `build-local`, and this file includes its rows.
		// The postcode databases add share-alike sources.
		tier: LayerTier.BuildLocal,
		license: [...identifiers].toSorted().join(" AND "),
		// A file whose Overture rows are an independent part is a Collective Database,
		// and the attribution states which part the ODbL governs.
		attribution:
			"derived from the mailwoman admin gazetteer and the postcode databases the build added; see each layer's manifest" +
			(input.overturePart && input.rowsBySource?.some((count) => count.source === "overture" && count.rows > 0)
				? `. ${OVERTURE_PART_NOTICE}`
				: ""),
		source: ancestor,
		// `build-local-inputs` is the count a publish decision reads without re-opening the inputs:
		// the build added a database whose own tier permits no publication.
		sourceVintage:
			`admin=${ancestor} postcode-databases=${input.contributingDatabases.postcodes.length} ` +
			`locality-databases=${input.contributingDatabases.localities.length} ` +
			`undeclared-inputs=${undeclared} build-local-inputs=${buildLocal} ` +
			(input.importance
				? `importance=${input.importance.path} importance-md5=${input.importance.md5}`
				: "importance=none") +
			(typeof input.populationEstimated === "number" ? ` population-estimates=${input.populationEstimated}` : "") +
			// Each source's rows and places, measured on the built table. Recorded here because a source's share
			// is recoverable from the artifact itself only while its upstream release is still served.
			(input.rowsBySource?.length
				? ` rows-by-source=${input.rowsBySource.map((count) => `${count.source}:${count.rows}/${count.places}`).join(",")}`
				: " rows-by-source=unmeasured (the builder passed none)"),
		buildCmd: "mailwoman gazetteer build candidate",
		buildSHA: input.buildSHA,
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		// `spr_id` is the join back to the admin gazetteer.
		// The id means something only against a known ancestor.
		spineKeys: { wofID: "spr_id" },
		createdAt: input.createdAt,
		sourceRecords: null,
	}
}
