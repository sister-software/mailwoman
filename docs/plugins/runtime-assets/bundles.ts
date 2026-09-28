/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build-time summary of the published data bundles, running in Node.js only (Docusaurus plugin context) and never
 *   bundled into the client. `BUNDLES` and the committed snapshot are read here, reduced to what a page renders, and
 *   handed to the client through the plugin's global data, so the data-products page states no size, file count,
 *   tier or license that somebody typed into it.
 *
 *   Every module on this import path is transformed by the Docusaurus loader, so none of them may touch
 *   `import.meta.resolve`, per the note atop `artifacts.ts`. The imports name `mailwoman/data/bundles` and
 *   `mailwoman/data/published-bundles` rather than the `mailwoman/data` barrel, because the barrel re-exports the
 *   inventory module, whose sqlite client the loader cannot require. Only a docs build verifies either.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { BUNDLES } from "mailwoman/data/bundles"
import {
	MeasurementStatus,
	type PublishedBundleRecord,
	readPublishedBundlesSnapshot,
	type RightsComponent,
} from "mailwoman/data/published-bundles"

/**
 * What the snapshot recorded for one bundle, reduced for rendering.
 */
export interface ServedBundleSummary {
	/**
	 * The sum of every measured `content-length`, or `null` when any artifact's size is unmeasured.
	 */
	servedBytes: number | null
	servedSize: string | null
	sizesUnmeasured: number
	/**
	 * The distinct tiers the measured manifests record, empty when none was measured.
	 */
	tiers: string[]
	/**
	 * The distinct flat expressions the measured manifests record, empty when none was measured.
	 */
	expressions: string[]
	manifestsMeasured: number
	manifestsUnmeasured: number
	/**
	 * The database-level license, or `null` with the recorded reason when unmeasured.
	 */
	databaseLicense: string | null
	databaseLicenseUnmeasuredReason: string | null
	components: RightsComponent[]
}

/**
 * One row of the rendered table: the registry's own figures, with the snapshot's beside them.
 */
export interface PublishedBundleSummary {
	name: string
	description: string
	artifactCount: number
	/**
	 * The bundle registry's rights record, verbatim.
	 *
	 * The license page's rights table renders this rather than restating it.
	 * The same two inputs, the registry and the snapshot, produce `mailwoman data bom`,
	 * so the customer table and the CycloneDX document state one joined record rather than two.
	 */
	rights: {
		publishers: string[]
		expression: string
		terms: string[]
		conditions: string[]
		unresolved: string[]
	}
	/**
	 * Summed from the registry's per-artifact `approxBytes`, never restated.
	 */
	totalBytes: number
	totalSize: string
	/**
	 * `null` when the snapshot carries no row for this bundle.
	 */
	served: ServedBundleSummary | null
}

/**
 * The `runtime-assets` plugin's global data, read by `#components/DataBundles/DataBundles`.
 */
export interface RuntimeAssetsGlobalData {
	measuredAt: string
	bucket: string
	bundles: PublishedBundleSummary[]
}

/**
 * A fixed locale so the rendered figure does not follow the build host's locale.
 */
const SIZE_LOCALE = "en-US"

function formatSize(bytes: number): string {
	return ByteFormatter.formatSI(bytes, { locales: SIZE_LOCALE })
}

function summarizeServed(record: PublishedBundleRecord): ServedBundleSummary {
	let servedBytes = 0
	let sizesUnmeasured = 0
	let manifestsMeasured = 0
	let manifestsUnmeasured = 0
	const tiers = new Set<string>()
	const expressions = new Set<string>()

	for (const artifact of record.artifacts) {
		if (artifact.size.status === MeasurementStatus.Measured) {
			servedBytes += artifact.size.contentLength
		} else {
			sizesUnmeasured++
		}

		if (artifact.manifest.status === MeasurementStatus.Measured) {
			manifestsMeasured++
			tiers.add(artifact.manifest.tier)

			if (artifact.manifest.expression !== null) {
				expressions.add(artifact.manifest.expression)
			}
		} else {
			manifestsUnmeasured++
		}
	}

	const { database } = record.rights

	return {
		servedBytes: sizesUnmeasured ? null : servedBytes,
		servedSize: sizesUnmeasured ? null : formatSize(servedBytes),
		sizesUnmeasured,
		tiers: [...tiers].toSorted(),
		expressions: [...expressions].toSorted(),
		manifestsMeasured,
		manifestsUnmeasured,
		databaseLicense: database.status === MeasurementStatus.Measured ? database.license : null,
		databaseLicenseUnmeasuredReason: database.status === MeasurementStatus.Unmeasured ? database.reason : null,
		components: record.rights.components,
	}
}

/**
 * Reads `BUNDLES` and the committed snapshot and reduces them to the rows a page renders.
 */
export async function summarizePublishedBundles(): Promise<RuntimeAssetsGlobalData> {
	const snapshot = await readPublishedBundlesSnapshot()
	const recordsByBundle = new Map(snapshot.bundles.map((record) => [record.bundle, record]))

	const bundles = Object.values(BUNDLES).map((bundle): PublishedBundleSummary => {
		const totalBytes = bundle.artifacts.reduce((sum, artifact) => sum + artifact.approxBytes, 0)
		const record = recordsByBundle.get(bundle.name)

		return {
			name: bundle.name,
			description: bundle.description,
			artifactCount: bundle.artifacts.length,
			rights: {
				publishers: [...bundle.rights.publishers],
				expression: bundle.rights.expression,
				terms: [...bundle.rights.terms],
				conditions: [...bundle.rights.conditions],
				unresolved: [...bundle.rights.unresolved],
			},
			totalBytes,
			totalSize: formatSize(totalBytes),
			served: record ? summarizeServed(record) : null,
		}
	})

	return { measuredAt: snapshot.measuredAt, bucket: snapshot.bucket, bundles }
}
