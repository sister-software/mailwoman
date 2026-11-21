// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file One CycloneDX document naming every data artifact a release can deliver, with each artifact's terms.
 *
 *   Four artifacts held a part of this record and no reader joined them. `bundles.ts` holds the publishers,
 *   terms, conditions and open questions per bundle as prose. `published-bundles.json` holds the served size
 *   and, where it could be read, the `tier` and flat expression of each artifact's own `layer_manifest`. A
 *   `layer_manifest` row on disk holds `license`, `attribution`, `source`, `source_vintage` and `build_sha`
 *   for a database that's present. `sbom.ts` writes the npm closure and lists no data file. A customer
 *   asking what governs a downloaded database had to read three of those and join them by hand.
 *
 *   CycloneDX 1.5 rather than a schema of this repository's own, because the existing validators run against
 *   it and the software SBOMs beside it are already in that format. The components are of type `data`.
 *
 *   **A mixed layer is listed by source.** A layer whose license is a `LicenseRef-<name>-Mixed` expression,
 *   such as the US address layer's `LicenseRef-US-Mixed`, gets its own component with one nested `data`
 *   component per source its ledgers name. Each records the publisher, the register decision and its basis,
 *   the terms URL and the attribution and share-alike states `#data/mixed-layer` reads. A source the
 *   register doesn't cover is emitted with `mailwoman:registerUncovered` rather than dropped.
 *
 *   **The document is deterministic.** `metadata.timestamp` stores the snapshot's `measuredAt` rather than
 *   the run's own clock. No `serialNumber` is emitted, so re-running over an unchanged snapshot produces
 *   identical bytes and the committed file diffs only when a measurement changed.
 *
 *   **What it doesn't establish.** An artifact whose `layer_manifest` couldn't be read reports the
 *   expression this repository's bundle registry assigns from the publishers' stated terms. The component
 *   records which of the two it is under `mailwoman:licenseBasis`. The 177 databases under the data root that
 *   have no `layer_manifest` row are counted in the metadata and are not emitted as components, because a
 *   component with no license field reads as unlicensed rather than as unrecorded.
 */

import { prettyJSON } from "@mailwoman/core/json"

import { BUNDLES, PUBLIC_BUCKET_BASE_URL, type DataBundle } from "#data/bundles"
import { Provenance, type InventoryEntry, type InventoryReport } from "#data/inventory"
import {
	isMixedLicenseExpression,
	mixedAddressLayerOf,
	type MixedLayerDescription,
	type MixedLayerSource,
	tallyObligationClasses,
} from "#data/mixed-layer"
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
	 * where the artifact's own row couldn't be read.
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
	/**
	 * The organization that published the component, as it spells its own name.
	 */
	publisher?: string
	name: string
	version: string
	description?: string
	licenses?: Array<{ expression: string }>
	hashes?: Array<{ alg: string; content: string }>
	externalReferences?: Array<{ type: string; url: string }>
	properties: BOMProperty[]
	/**
	 * The components this one contains: a mixed layer's sources, each under its own terms.
	 */
	components?: DataBOMComponent[]
}

/**
 * A mixed layer the document lists by source, and where its description was read.
 */
export interface DataBOMMixedLayer {
	description: MixedLayerDescription
	/**
	 * Where the manifest and ledgers were read: the data root's `db/` directory or the bucket's base URL.
	 */
	readFrom: string
	/**
	 * Whether the attribution notice exists beside the manifest where the layer was read.
	 */
	noticePresent: boolean
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
	 * There's no separate bundle-manifest version: `releases.json` pins one version per database family.
	 * Those versions appear per component.
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
	 * and `build_sha` in this document, because a published artifact's own row couldn't
	 * be read for any of the 106 bundle artifacts measured 2026-09-27.
	 */
	inventory?: InventoryReport

	/**
	 * The mixed layers to list by source, each nested under its own component.
	 */
	mixedLayers?: readonly DataBOMMixedLayer[]

	/**
	 * A mixed layer the caller couldn't describe, with the reason, recorded in
	 * the metadata in place of its sources.
	 */
	mixedLayersUnread?: ReadonlyArray<{ license: string; reason: string }>
}

function property(name: string, value: string | number | null | undefined): BOMProperty[] {
	if (value == null || value === "") return []

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

		const expression = measuredManifest?.expression ?? artifact.expression ?? bundle.rights.expression
		const basis = measuredManifest?.expression ? LicenseBasis.ArtifactManifest : LicenseBasis.BundleRegistry

		components.push({
			type: "data",
			"bom-ref": `bundle/${bundleName}/${artifact.remotePath}`,
			name: artifact.remotePath,
			// A per-state database's version is the family version `releases.json` pins.
			// Every other artifact has the date segment of its own object key.
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
					served?.size.status === MeasurementStatus.Measured ? served.size.contentLength : null
				),
				...property(
					"mailwoman:servedBytesUnmeasured",
					served?.size.status === MeasurementStatus.Unmeasured ? served.size.reason : null
				),
				...property("mailwoman:registryBytes", artifact.approxBytes),
				...property(
					"mailwoman:manifestUnread",
					manifest?.status === MeasurementStatus.Unmeasured ? manifest.reason : null
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

/**
 * Where a manifested database with a mixed license has its sources listed, or why it has none.
 */
function mixedListing(path: string, license: string | undefined, layers: readonly DataBOMMixedLayer[]): BOMProperty[] {
	if (!license || !isMixedLicenseExpression(license)) return []

	const listing = layers.find(
		({ description }) =>
			description.license === license &&
			path.startsWith(`db/addresses/${description.country.toLowerCase()}-`) &&
			path.includes(`/${description.version}/`)
	)

	if (listing) return property("mailwoman:mixedSourcesListedUnder", layerReference(listing.description))

	return property(
		"mailwoman:mixedSourcesUnlisted",
		mixedAddressLayerOf(license)
			? "this database's version is not the layer version this document lists by source"
			: `no reader lists the sources of ${license}, so this document records the expression only`
	)
}

const layerReference = (description: MixedLayerDescription): string => `layer/${description.id}/${description.version}`

/**
 * One source of a mixed layer, with its publisher's register decision, basis, terms and obligations.
 */
function mixedSourceComponent(description: MixedLayerDescription, source: MixedLayerSource): DataBOMComponent {
	const deciding = source.deciding

	const statement =
		deciding && deciding.decision !== "unchecked" ? (source.statement ?? "unrecorded in the register") : null

	return {
		type: "data",
		"bom-ref": `${layerReference(description)}/source/${source.source}`,
		...(source.publisher ? { publisher: source.publisher } : {}),
		name: source.source,
		version: description.version,
		// An SPDX expression only where the register elected one.
		// Every other source states no license this document can name.
		licenses: [{ expression: source.spdx ?? "NOASSERTION" }],
		...(source.termsURL ? { externalReferences: [{ type: "license", url: source.termsURL }] } : {}),
		properties: [
			...property("mailwoman:records", source.records),
			...property("mailwoman:regions", source.regions.join(", ")),
			...property("mailwoman:registerSources", source.rows.map((row) => row.registerSource).join(", ")),
			...property(
				"mailwoman:registerUncovered",
				source.rows.length ? null : "the source table maps this source to no register row"
			),
			...property("mailwoman:registerDecision", deciding ? (deciding.decision ?? "no decision") : "uncovered"),
			...property("mailwoman:termsBasis", source.basis),
			...property("mailwoman:termsStatement", statement),
			...property("mailwoman:spdx", source.spdx),
			...property("mailwoman:electedTerms", deciding?.electedTerms),
			...property("mailwoman:termsURL", source.termsURL),
			...property("mailwoman:termsRetrievedCopy", deciding?.retrievedCopy),
			...property("mailwoman:decisionBecause", deciding?.because),
			...property("mailwoman:attribution", source.attribution),
			...property("mailwoman:attributionText", source.attributionText),
			...property("mailwoman:shareAlike", source.shareAlike),
			...property("mailwoman:obligationClass", source.obligationClass),
			...source.obligations.flatMap((entry) =>
				property(`mailwoman:obligation:${entry.obligation}`, `${entry.strength}: ${entry.quote}`)
			),
			...property("mailwoman:layerRecordedLicense", source.recordedLicense),
			...property(
				"mailwoman:openAddressesAttribution",
				source.openAddresses?.attribution == null ? null : String(source.openAddresses.attribution)
			),
			...property("mailwoman:openAddressesAttributionName", source.openAddresses?.attributionName),
			...property(
				"mailwoman:openAddressesShareAlike",
				source.openAddresses?.shareAlike == null ? null : String(source.openAddresses.shareAlike)
			),
			...source.rows.flatMap((row) =>
				property("mailwoman:registerRow", `${row.registerSource}: ${row.decision ?? "no decision"}, ${row.basis}`)
			),
		],
	}
}

/**
 * A mixed layer's own component, with one nested component per source.
 */
function mixedLayerComponent(layer: DataBOMMixedLayer): DataBOMComponent {
	const { description } = layer
	const base = layer.readFrom.endsWith("/") ? layer.readFrom : `${layer.readFrom}/`

	return {
		type: "data",
		"bom-ref": layerReference(description),
		name: description.manifestPath,
		version: description.version,
		description:
			`The ${description.country} address layer: ${description.regions} regions whose rows come from ` +
			`${description.sources.length} sources under their publishers' own terms, each listed as a nested component.`,
		licenses: [{ expression: description.license }],
		externalReferences: [
			{ type: "distribution", url: `${PUBLIC_BUCKET_BASE_URL}${description.manifestPath}` },
			...(layer.noticePresent ? [{ type: "license", url: `${PUBLIC_BUCKET_BASE_URL}${description.noticePath}` }] : []),
		],
		properties: [
			...property("mailwoman:readFrom", base),
			...property("mailwoman:regions", description.regions),
			...property("mailwoman:records", description.records),
			...property("mailwoman:sources", description.sources.length),
			...tallyObligationClasses(description).flatMap((tally) =>
				property(
					"mailwoman:obligationClassCount",
					`${tally.obligationClass}: ${tally.sources} sources, ${tally.records} records`
				)
			),
			...(layer.noticePresent
				? property("mailwoman:attributionNotice", description.noticePath)
				: property(
						"mailwoman:attributionNoticeAbsent",
						`${description.noticePath} does not exist where the layer was read. Write it with \`mailwoman situs attribution-manifest --layer-version ${description.version}\``
					)),
		],
		components: description.sources.map((source) => mixedSourceComponent(description, source)),
	}
}

function inventoryComponent(entry: InventoryEntry, layers: readonly DataBOMMixedLayer[]): DataBOMComponent {
	const manifest = entry.manifest!

	return {
		type: "data",
		"bom-ref": `data-root/${entry.path}`,
		name: entry.path,
		version: manifest.version,
		description: manifest.name,
		// A row written before the column existed leaves `license` undefined, An absent expression is unstated.
		// `NOASSERTION` is SPDX's term for that state.
		// A validator accepts it.
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
			// The record count each publisher supplied to the build, verbatim as the manifest stores it.
			// An artifact recording no count has no property.
			// The count cannot be recovered from the input afterwards.
			// A zero would assert that a publisher supplied 0 records to this build.
			...property("mailwoman:sourceRecords", manifest.source_records),
			// The build reads this input file.
			// A share-alike license's database-access terms direct recipients to it.
			...property("mailwoman:sourceURL", manifest.source_url),
			...property("mailwoman:sourceSHA256", manifest.source_sha256),
			...property("mailwoman:bytes", entry.bytes),
			...property("mailwoman:linkTarget", entry.linkTarget),
			// Whether the active selection lists the artifact, for an artifact the catalog holds.
			...property("mailwoman:selection", entry.selection),
			...mixedListing(entry.path, manifest.license, layers),
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

	const layers = options.mixedLayers ?? []

	for (const entry of manifested) {
		components.push(inventoryComponent(entry, layers))
	}

	for (const layer of layers) {
		components.push(mixedLayerComponent(layer))
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
				...property("mailwoman:dataRootManifested", options.inventory ? manifested.length : null),
				...property(
					"mailwoman:dataRootUnprovenanced",
					!unprovenanced
						? undefined
						: `${unprovenanced} databases under the data root carry no layer_manifest row and are not components here`
				),
				...layers.flatMap(({ description }) =>
					property("mailwoman:mixedLayer", `${description.license} ${layerReference(description)}`)
				),
				...(options.mixedLayersUnread ?? []).flatMap(({ license, reason }) =>
					property("mailwoman:mixedLayerUnread", `${license}: ${reason}`)
				),
			],
		},
		components,
	}
}

/**
 * The document as the bytes to write, including the trailing newline used in committed files.
 */
export function serializeDataBOM(document: DataBOM): string {
	return prettyJSON(document)
}
