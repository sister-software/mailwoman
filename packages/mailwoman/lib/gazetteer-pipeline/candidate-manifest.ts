/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The candidate gazetteer's `layer_manifest` — the artifact every geocode actually reads.
 *
 *   the candidate is derived, so its manifest names its input rather than restating the input's sources.
 *   `buildCandidateTable` reads an admin gazetteer plus postcode and locality databases. it ingests no data
 *   from WOF, Overture or GeoNames directly. A manifest that repeated "whosonfirst+overture+geonames" here
 *   would be true of the ancestor and unfalsifiable of this file. It could not tell you which admin build
 *   this came from, which is the only question a reproduction actually asks.
 *
 *   So the source is the ancestor's identity, read out of the ancestor's own manifest when it has one:
 *   `admin-global-priority@2026-08-17.0`. That makes provenance a chain, and a chain is what survives the
 *   thing the flat form cannot. The lab holds thirteen candidate builds and about ten admin builds, and
 *   which pairs with which is currently recorded nowhere.
 *
 *   an unprovenanced ancestor is reported rather than hidden. Every admin build that predates phase 3 has no
 *   manifest, so the chain terminates in `unknown` and says so. Substituting the file's name would look
 *   like provenance and carry none.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { LayerFreshnessPolicy, type LayerManifest, LayerTier } from "@mailwoman/core/layers"
import type { layerschemadatabase } from "@mailwoman/core/layers/schema"
import { licenseIdentifiers } from "@mailwoman/core/license/obligations"
import { readLicenseRecord } from "@mailwoman/core/license/record"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { tableExists } from "@mailwoman/sqlite/introspection"
import { basename, type PathBuilderLike } from "path-ts"

import { probeManifest } from "#data/inventory"

/**
 * The ancestor's identity as this manifest records it.
 *
 * `unknown` is a measured state.
 * The admin build had no manifest — and is deliberately distinguishable from an admin
 * build whose manifest says its version is literally unknown.
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
	 * The admin gazetteer this candidate was built from.
	 *
	 * Read for its manifest, never for its rows.
	 */
	adminDBPath: PathBuilderLike
	/**
	 * Every postcode and locality database whose rows this candidate carries.
	 *
	 * The paths rather than their count, because the manifest's license expression
	 * is composed from what each one declares.
	 * Measured 2026-09-27, these folds supplied 2,082,665 of a candidate table's 8,714,235
	 * places, 23.90%, while the expression named the admin ancestor's terms alone.
	 *
	 * The count still reaches `sourceVintage`, because a candidate built from no database is a
	 * different artifact from one built from twenty-eight and no other field says which it is.
	 */
	contributingDatabases: {
		postcodes: readonly PathBuilderLike[]
		localities: readonly PathBuilderLike[]
	}
	/**
	 * Whether an importance database was folded in.
	 *
	 * A candidate without it ranks differently, and the difference is invisible from the schema.
	 */
	importance: boolean
	buildSHA: string
	version: string
	createdAt: string
}

/**
 * The identifier that stands for a fold whose own terms this build could not read.
 *
 * It is deliberately absent from `KNOWN_OBLIGATIONS`, so `summarizeLicense` reports
 * it as unrecognized and `refusalsForPublication` refuses the layer.
 * A fold whose grant nobody recorded carries unknown obligations, and an expression
 * that simply omitted it would read as a complete list of the terms.
 */
export const UNDECLARED_INPUT_LICENSE = "LicenseRef-Undeclared-Input"

/**
 * Where a contributing database recorded its terms.
 *
 * `layer_manifest` is the layer interface.
 * `meta` and `database_meta` are the key/value tables the postcode and locality builders wrote before
 * they stamped a manifest, and every database built before 2026-09-27 carries at most one of those.
 *
 * `none` means the database records no terms, or could not be read.
 */
export const FoldTermsRecord = {
	LayerManifest: "layer_manifest",
	Meta: "meta",
	DatabaseMeta: "database_meta",
	None: "none",
} as const

export type FoldTermsRecord = (typeof FoldTermsRecord)[keyof typeof FoldTermsRecord]

/**
 * What one contributing database says about its own publication.
 */
export interface FoldTerms {
	path: string
	/**
	 * The layer name the manifest records, or the filename when no manifest names one.
	 */
	name: string
	recordedIn: FoldTermsRecord
	/**
	 * The tier as recorded, or `null` when the database states none.
	 */
	tier: string | null
	/**
	 * The SPDX expression the recorded grant resolves to, or `null` when it states none
	 * or states prose that resolves to no expression.
	 */
	license: string | null
	/**
	 * Why the database could not be read, when it could not.
	 */
	error?: string
}

/**
 * The key/value tables a builder wrote its terms into before the manifest existed,
 * in the order they are consulted.
 */
const TERMS_TABLES = [FoldTermsRecord.Meta, FoldTermsRecord.DatabaseMeta] as const

/**
 * Read what a contributing database records about its tier and grant.
 *
 * A layer database records both in `layer_manifest`.
 * The postcode and locality builders predate that interface and record them in a `meta`
 * or `database_meta` key/value table instead, as prose rather than an identifier,
 * so all three are read and the grant resolved through `readLicenseRecord`.
 *
 * Prose that resolves to no expression reads as `null` rather than as the prose, because the
 * caller composes an SPDX expression and a sentence inside one is not a grant a reader can act on.
 * An unreadable database records no terms this build can quote, and says why.
 */
export async function readFoldTerms(path: PathBuilderLike): Promise<FoldTerms> {
	const pathString = path.toString()
	const name = basename(pathString, ".db")
	const none: FoldTerms = { path: pathString, name, recordedIn: FoldTermsRecord.None, tier: null, license: null }

	if (!(await pathExists(path))) return { ...none, error: "not found" }

	const probed = probeManifest(path)

	if (probed.error) return { ...none, error: probed.error }

	if (probed.manifest) {
		return {
			path: pathString,
			name: probed.manifest.name,
			recordedIn: FoldTermsRecord.LayerManifest,
			tier: probed.manifest.tier ?? null,
			license: probed.manifest.license ? readLicenseRecord(probed.manifest.license).expression : null,
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
			}
		}

		return none
	} catch (error) {
		return { ...none, error: (error as Error).message }
	}
}

/**
 * Every contributing database whose recorded tier permits no publication.
 *
 * A fold that states no tier is not in this list.
 * It is a finding the caller reports separately, and its undeclared grant already reaches the
 * candidate's expression as {@link UNDECLARED_INPUT_LICENSE}, which refuses publication of the whole.
 */
export function foldsRefusingPublication(terms: readonly FoldTerms[]): FoldTerms[] {
	return terms.filter((fold) => fold.tier !== null && fold.tier !== LayerTier.Shipped)
}

/**
 * Compose the candidate gazetteer's manifest.
 */
export async function candidateLayerManifest(input: CandidateManifestInput): Promise<LayerManifest> {
	const ancestor = await ancestorIdentity(input.adminDBPath)
	const contributing = [...input.contributingDatabases.postcodes, ...input.contributingDatabases.localities]
	const identifiers = new Set<string>()
	let undeclared = 0

	const adminTerms = await readFoldTerms(input.adminDBPath)
	const foldTerms = await Promise.all(contributing.map((path) => readFoldTerms(path)))
	// The ancestor is not a fold, so the count reads the contributing databases alone.
	const buildLocal = foldsRefusingPublication(foldTerms).length

	for (const terms of [adminTerms, ...foldTerms]) {
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
		// Never `shipped`.
		// The admin ancestor is `build-local` and this file carries its rows,
		// and the postcode folds add their own share-alike sources on top.
		tier: LayerTier.BuildLocal,
		// Composed from what every fold declared rather than from the ancestor's terms alone.
		// Measured 2026-09-27, a literal `ODbL-1.0 AND CDLA-Permissive-2.0 AND CC-BY-4.0` stood here
		// while the postcode and locality folds supplied 23.90% of the table's places under terms
		// it did not name, and 28 of those 28 databases declared no `layer_manifest` at all.
		license: [...identifiers].toSorted().join(" AND "),
		attribution: "derived from the mailwoman admin gazetteer and its postcode folds; see each layer's manifest",
		source: ancestor,
		// `build-local-folds` is the count a publish decision can read without re-opening the inputs:
		// a fold whose own tier permits no publication was folded in, and the caller asked for it.
		sourceVintage:
			`admin=${ancestor} postcode-databases=${input.contributingDatabases.postcodes.length} ` +
			`locality-databases=${input.contributingDatabases.localities.length} ` +
			`undeclared-folds=${undeclared} build-local-folds=${buildLocal} importance=${input.importance ? "yes" : "no"}`,
		buildCmd: "mailwoman gazetteer build candidate",
		buildSHA: input.buildSHA,
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		// `spr_id` is the join back to the admin gazetteer, and the reason a chained manifest
		// is worth having: the id only means something against a known ancestor.
		spineKeys: { wofID: "spr_id" },
		createdAt: input.createdAt,
	}
}
