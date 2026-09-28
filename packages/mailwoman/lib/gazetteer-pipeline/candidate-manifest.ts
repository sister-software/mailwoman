/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The candidate gazetteer's `layer_manifest`, which names its admin ancestor as `source` and
 *   reports an unprovenanced ancestor as `unknown` rather than substituting the file's name.
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
	 * Every postcode and locality database whose rows this candidate carries, whose paths
	 * compose the manifest's license expression and whose count reaches `sourceVintage`.
	 */
	contributingDatabases: {
		postcodes: readonly PathBuilderLike[]
		localities: readonly PathBuilderLike[]
	}
	/**
	 * Whether an importance database was folded in, which changes ranking in a way the schema does not show.
	 */
	importance: boolean
	buildSHA: string
	version: string
	createdAt: string
}

/**
 * The identifier that stands for a fold whose own terms this build could not read,
 * deliberately absent from `KNOWN_OBLIGATIONS` so `summarizeLicense` reports it as
 * unrecognized and `refusalsForPublication` refuses the layer.
 */
export const UNDECLARED_INPUT_LICENSE = "LicenseRef-Undeclared-Input"

/**
 * Where a contributing database recorded its terms, with `none` meaning it
 * records no terms or could not be read.
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
	error?: string
}

/**
 * The key/value tables a builder wrote its terms into before the manifest existed, consulted in this order.
 */
const TERMS_TABLES = [FoldTermsRecord.Meta, FoldTermsRecord.DatabaseMeta] as const

/**
 * Read what a contributing database records about its tier and grant, resolving a pre-manifest prose
 * grant through `readLicenseRecord` and reporting prose that resolves to no expression as `null`.
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
 * Every contributing database whose recorded tier permits no publication, excluding a fold that
 * states no tier because its undeclared grant already reaches {@link UNDECLARED_INPUT_LICENSE}.
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
		// Never `shipped`: the admin ancestor is `build-local`, this file carries its rows,
		// and the postcode folds add share-alike sources.
		tier: LayerTier.BuildLocal,
		license: [...identifiers].toSorted().join(" AND "),
		attribution: "derived from the mailwoman admin gazetteer and its postcode folds; see each layer's manifest",
		source: ancestor,
		// `build-local-folds` is the count a publish decision reads without re-opening the inputs:
		// a fold whose own tier permits no publication was folded in.
		sourceVintage:
			`admin=${ancestor} postcode-databases=${input.contributingDatabases.postcodes.length} ` +
			`locality-databases=${input.contributingDatabases.localities.length} ` +
			`undeclared-folds=${undeclared} build-local-folds=${buildLocal} importance=${input.importance ? "yes" : "no"}`,
		buildCmd: "mailwoman gazetteer build candidate",
		buildSHA: input.buildSHA,
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		// `spr_id` is the join back to the admin gazetteer.
		// The id means something only against a known ancestor.
		spineKeys: { wofID: "spr_id" },
		createdAt: input.createdAt,
	}
}
