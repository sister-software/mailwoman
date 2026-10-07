/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes a `layer_manifest` into a freshly built database. Call it before `sealDatabase`, because a
 *   sealed database is read-only.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import {
	assertTierMatchesLicense,
	createLayerManifestTable,
	LayerFreshnessPolicy,
	type layerschemadatabase,
	type LayerManifest,
	type LayerTier,
	type SpineKeys,
	writeLayerManifest,
} from "@mailwoman/core/layers"
import { assertAdmissibleLicenseExpression } from "@mailwoman/core/license/obligations"
import { LicenseResolution, readLicenseRecord } from "@mailwoman/core/license/record"
import { runFileSync } from "@mailwoman/core/process"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

/**
 * What a postcode or locality builder states about the database it seals.
 *
 * The candidate build folds these databases.
 * `candidateLayerManifest` composes its own terms from what each one records, so every field here
 * is a claim the builder makes about its own artifact rather than a value copied from a runbook.
 */
export interface FoldLayerManifestInput {
	/**
	 * The artifact's filename without its extension.
	 * `DEFAULT_POSTCODE_DATABASES` uses this name.
	 */
	name: string
	/**
	 * The build date or the source release the artifact reproduces.
	 */
	version: string
	/**
	 * The tier the builder states.
	 *
	 * `assertTierMatchesLicense` refuses a tier the license expression contradicts.
	 */
	tier: LayerTier
	/**
	 * The grant as the builder records it, as an SPDX expression or as the prose in its `meta` table.
	 *
	 * Prose resolves through `readLicenseRecord`.
	 * An expression naming a repository-defined `LicenseRef-` is admissible while unresolved.
	 *
	 * Build-local artifacts use that form for inputs with no declared terms.
	 *
	 * A value that is neither stops the build rather than reaching the manifest.
	 */
	license: string
	attribution?: string
	source: string
	sourceVintage: string
	buildCmd: string
	buildSHA: string
	createdAt: string
	spineKeys: SpineKeys
	/**
	 * Input record count per publisher, counted during the build.
	 *
	 * The absent field records that the build did not count.
	 * That is what every artifact built before the field existed.
	 *
	 * Overture removes a release from its bucket once a newer one lands, so a count
	 * omitted here cannot be recovered from the input afterwards.
	 */
	sourceRecords?: Readonly<Record<string, number>>
}

/**
 * The expression a manifest records for what a builder wrote.
 *
 * A resolved reading wins.
 * An admissible expression that stays unresolved, one naming a `LicenseRef-`, is recorded as
 * written, because `assertTierMatchesLicense` is what decides whether a tier may rest on it.
 *
 * @throws When the value is prose that resolves to no expression and is not an admissible one.
 */
function manifestLicenseExpression(name: string, license: string): string {
	const record = readLicenseRecord(license)

	if (record.resolution === LicenseResolution.Resolved && record.expression) return record.expression

	try {
		assertAdmissibleLicenseExpression(license, `${name} manifest`)
	} catch {
		throw new Error(
			`${name} manifest: license ${stringifyJSON(license)} resolves to no SPDX expression whose ` +
				`obligations are recorded. Record the grant as an identifier, or add the measured prose to ` +
				`EXPRESSION_ALIASES in @mailwoman/core/license/record.`
		)
	}

	return license
}

/**
 * Compose the manifest a postcode or locality builder stamps before sealing.
 *
 * @throws When the license resolves to no recorded expression, or when the stated tier contradicts it.
 */
export function foldLayerManifest(input: FoldLayerManifestInput): LayerManifest {
	const license = manifestLicenseExpression(input.name, input.license)

	assertTierMatchesLicense({ tier: input.tier, license }, `${input.name} manifest`)

	return {
		name: input.name,
		version: input.version,
		schemaVersion: 1,
		tier: input.tier,
		license,
		attribution: input.attribution ?? null,
		source: input.source,
		sourceVintage: input.sourceVintage,
		buildCmd: input.buildCmd,
		buildSHA: input.buildSHA,
		freshnessPolicy: LayerFreshnessPolicy.Sealed,
		spineKeys: input.spineKeys,
		createdAt: input.createdAt,
		sourceRecords: input.sourceRecords ?? null,
	}
}

/**
 * Opens `path` and writes `manifest` into it.
 * Then closes the connection.
 *
 * The function opens its own connection.
 * Callers reach it after closing their build handle and before sealing the database.
 *
 * @throws When the database is already sealed.
 */
export async function stampLayerManifest(path: PathBuilderLike, manifest: LayerManifest): Promise<void> {
	using kdb = new DatabaseClient<layerschemadatabase>(path)

	await createLayerManifestTable(kdb)
	await writeLayerManifest(kdb, manifest)
}

/**
 * Returns the short git SHA of `repoRoot` for `layer_manifest.build_sha`.
 *
 * It returns `unknown` when git fails, so a build outside a checkout still gets a manifest.
 */
export function buildSHA(repoRoot: PathBuilderLike): string {
	try {
		return runFileSync("git", ["rev-parse", "--short", "HEAD"], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: "pipe",
		}).trim()
	} catch {
		return "unknown"
	}
}
