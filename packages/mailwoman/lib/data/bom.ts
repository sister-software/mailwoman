/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file One CycloneDX document naming every data artifact a release can deliver, with the terms each one
 *   carries.
 *
 *   Four artifacts held a part of this record and no reader joined them. `bundles.ts` holds the publishers,
 *   terms, conditions and open questions per bundle as prose. `published-bundles.json` holds the served size
 *   and, where it could be read, the `tier` and flat expression of each artifact's own `layer_manifest`. A
 *   `layer_manifest` row on disk holds `license`, `attribution`, `source`, `source_vintage` and `build_sha`
 *   for a database that is present. `sbom.ts` writes the npm closure and lists no data file. A customer
 *   asking what governs a downloaded database had to read three of those and join them by hand.
 *
 *   CycloneDX 1.5 rather than a schema of this repository's own, because the existing validators run against
 *   it and the software SBOMs beside it are already in that format. The components are of type `data`.
 *
 *   **The document is deterministic.** `metadata.timestamp` carries the snapshot's `measuredAt` rather than
 *   the run's own clock, and no `serialNumber` is emitted, so re-running over an unchanged snapshot produces
 *   identical bytes and the committed file diffs only when a measurement changed.
 *
 *   **What it does not establish.** An artifact whose `layer_manifest` could not be read carries the
 *   expression this repository's bundle registry assigns from the publishers' stated terms, and the component
 *   records which of the two it is under `mailwoman:licenseBasis`. The 177 databases under the data root that
 *   carry no `layer_manifest` row are counted in the metadata and are not emitted as components, because a
 *   component with no license field reads as unlicensed rather than as unrecorded.
 */

import { prettyJSON } from "@mailwoman/core/json"

import { BUNDLES, PUBLIC_BUCKET_BASE_URL, type DataBundle } from "#data/bundles"
import { Provenance, type InventoryEntry, type InventoryReport } from "#data/inventory"
import { MeasurementStatus, type PublishedBundlesSnapshot } from "#data/published-bundles"

/**
 * The CycloneDX specification version the document declares.
 */
export const DATA_BOM_SPEC_VERSION = "1.5"

/**
 * Where a component's license expression came from.
 */
export const LicenseBasis = {
	/**
	 * The artifact's own `layer_manifest` row, read from the published file or from a local copy.
	 */
	ArtifactManifest: "artifact-layer-manifest",

	/**
	 * The expression `bundles.ts` assigns from the publishers' stated terms, used
	 * where the artifact's own row could not be read.
	 *
	 * It is this repository's reading rather than the artifact's statement.
	 */
	BundleRegistry: "bundle-registry",
} as const

export type LicenseBasis = (typeof LicenseBasis)[keyof typeof LicenseBasis]

interface BOMProperty {
	name: string
	value: string
}

/**
 * One `data` component: a single database or archive a bundle delivers,
 * or a manifested database found under the data root.
 */
export interface DataBOMComponent {
	type: "data"
	"bom-ref": string
	name: string
	version: string
	description?: string
	licenses?: Array<{ expression: string }>
	hashes?: Array<{ alg: string; content: string }>
	externalReferences?: Array<{ type: string; url: string }>
	properties: BOMProperty[]
}

export interface DataBOM {
	bomFormat: "CycloneDX"
	specVersion: typeof DATA_BOM_SPEC_VERSION
	version: number
	metadata: {
		timestamp: string
		component: { type: "data"; name: string; version: string; description: string }
		properties: BOMProperty[]
	}
	components: DataBOMComponent[]
}

export interface DataBOMOptions {
	/**
	 * The `mailwoman` package version, used in the file name and the root component's `version`.
	 *
	 * The bundle registry ships inside that package, so its version is what identifies
	 * the set of artifacts the document describes.
	 * There is no separate bundle-manifest version: `releases.json` pins one version
	 * per database family, and those appear per component.
	 */
	mailwomanVersion: string

	/**
	 * The committed measurement of what the bucket serves.
	 */
	snapshot: PublishedBundlesSnapshot

	/**
	 * The data root's databases, when the caller took an inventory.
	 *
	 * Its manifested entries are the only source of `attribution`, `source_vintage`
	 * and `build_sha` in this document, because a published artifact's own row could not
	 * be read for any of the 106 bundle artifacts measured 2026-09-27.
	 */
	inventory?: InventoryReport
}

function property(name: string, value: string | number | undefined): BOMProperty[] {
	if (value === undefined || value === "") return []

	return [{ name, value: String(value) }]
}

/**
 * The repository-relative path the document is written to.
 *
 * It sits beside the software SBOMs.
 * Those are keyed by the same package version.
 */
export function dataBOMPath(mailwomanVersion: string): string {
	return `docs/static/sbom/mailwoman-data-${mailwomanVersion}.cdx.json`
}

function bundleComponents(
	bundleName: string,
	bundle: DataBundle,
	snapshot: PublishedBundlesSnapshot
): DataBOMComponent[] {
	const record = snapshot.bundles.find((entry) => entry.bundle === bundleName)
	const components: DataBOMComponent[] = []

	for (const artifact of bundle.artifacts) {
		const served = record?.artifacts.find((entry) => entry.remotePath === artifact.remotePath)
		const manifest = served?.manifest
		const measuredManifest = manifest?.status === MeasurementStatus.Measured ? manifest : null

		const expression = measuredManifest?.expression ?? bundle.rights.expression
		const basis = measuredManifest?.expression ? LicenseBasis.ArtifactManifest : LicenseBasis.BundleRegistry

		components.push({
			type: "data",
			"bom-ref": `bundle/${bundleName}/${artifact.remotePath}`,
			name: artifact.remotePath,
			// A per-state database's version is the family version `releases.json` pins.
			// Every other artifact carries the date segment of its own object key.
			// That segment is how the bucket versions it.
			version: artifact.family ?? artifact.remotePath.split("/").at(-2) ?? bundleName,
			description: bundle.description,
			licenses: [{ expression }],
			externalReferences: [{ type: "distribution", url: `${PUBLIC_BUCKET_BASE_URL}${artifact.remotePath}` }],
			properties: [
				...property("mailwoman:bundle", bundleName),
				...property("mailwoman:localPath", artifact.localPath),
				...property("mailwoman:licenseBasis", basis),
				...property("mailwoman:tier", measuredManifest?.tier),
				...property(
					"mailwoman:servedBytes",
					served?.size.status === MeasurementStatus.Measured ? served.size.contentLength : undefined
				),
				...property(
					"mailwoman:servedBytesUnmeasured",
					served?.size.status === MeasurementStatus.Unmeasured ? served.size.reason : undefined
				),
				...property("mailwoman:registryBytes", artifact.approxBytes),
				...property(
					"mailwoman:manifestUnread",
					manifest?.status === MeasurementStatus.Unmeasured ? manifest.reason : undefined
				),
				...property("mailwoman:md5Sidecar", String(artifact.md5Sidecar)),
				...property("mailwoman:stateSlug", artifact.stateSlug),
				...property("mailwoman:publishers", bundle.rights.publishers.join(" | ")),
				...property("mailwoman:terms", bundle.rights.terms.join(" | ")),
				...property("mailwoman:conditions", bundle.rights.conditions.join(" | ")),
				...property("mailwoman:unresolved", bundle.rights.unresolved.join(" | ")),
			],
		})
	}

	return components
}

function inventoryComponent(entry: InventoryEntry): DataBOMComponent {
	const manifest = entry.manifest!

	return {
		type: "data",
		"bom-ref": `data-root/${entry.path}`,
		name: entry.path,
		version: manifest.version,
		description: manifest.name,
		// A row written before the column existed leaves `license` undefined,
		// and an absent expression is an unstated one.
		// `NOASSERTION` is SPDX's own word for that state, and a validator accepts it.
		licenses: [{ expression: manifest.license ?? "NOASSERTION" }],
		properties: [
			...property("mailwoman:licenseBasis", LicenseBasis.ArtifactManifest),
			...property("mailwoman:tier", manifest.tier),
			...property("mailwoman:attribution", manifest.attribution),
			...property("mailwoman:source", manifest.source),
			...property("mailwoman:sourceVintage", manifest.source_vintage),
			...property("mailwoman:buildSha", manifest.build_sha),
			...property("mailwoman:buildCommand", manifest.build_cmd),
			...property("mailwoman:createdAt", manifest.created_at),
			...property("mailwoman:bytes", entry.bytes),
			...property("mailwoman:linkTarget", entry.linkTarget),
		],
	}
}

/**
 * Assemble the data document from the bundle registry, the committed served-size snapshot
 * and, when the caller took one, the data root's inventory.
 */
export function buildDataBOM(options: DataBOMOptions): DataBOM {
	const components: DataBOMComponent[] = []

	for (const [name, bundle] of Object.entries(BUNDLES)) {
		components.push(...bundleComponents(name, bundle, options.snapshot))
	}

	const manifested = (options.inventory?.entries ?? []).filter((entry) => entry.provenance === Provenance.Manifested)

	for (const entry of manifested) {
		components.push(inventoryComponent(entry))
	}

	const unprovenanced = options.inventory?.counts[Provenance.Unprovenanced]

	return {
		bomFormat: "CycloneDX",
		specVersion: DATA_BOM_SPEC_VERSION,
		version: 1,
		metadata: {
			timestamp: options.snapshot.measuredAt,
			component: {
				type: "data",
				name: "mailwoman-data",
				version: options.mailwomanVersion,
				description:
					"Every data artifact a mailwoman release can deliver, with the terms each one carries. " +
					"Sizes and per-artifact manifests come from the committed snapshot in " +
					"packages/mailwoman/data/published-bundles.json; publishers, terms, conditions and open " +
					"questions come from the bundle registry in packages/mailwoman/lib/data/bundles.ts.",
			},
			properties: [
				...property("mailwoman:bucket", options.snapshot.bucket),
				...property("mailwoman:bundles", Object.keys(BUNDLES).join(", ")),
				...property("mailwoman:snapshotMeasuredAt", options.snapshot.measuredAt),
				...property("mailwoman:dataRoot", options.inventory?.dataRoot),
				...property("mailwoman:dataRootManifested", options.inventory ? manifested.length : undefined),
				...property(
					"mailwoman:dataRootUnprovenanced",
					unprovenanced === undefined
						? undefined
						: `${unprovenanced} databases under the data root carry no layer_manifest row and are not components here`
				),
			],
		},
		components,
	}
}

/**
 * The document as the bytes to write, with the trailing newline a committed file carries.
 */
export function serializeDataBOM(document: DataBOM): string {
	return prettyJSON(document)
}
