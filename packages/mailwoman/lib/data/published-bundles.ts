/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The committed snapshot of what the public bucket serves for each bundle in `BUNDLES` records the size the server
 *   reports per artifact and the tier and license expression in its `layer_manifest`. The snapshot also records when they were
 *   measured.
 *
 *   `BUNDLES` records `approxBytes` by hand. The docs site once restated those numbers by hand again. The
 *   artifacts themselves are gigabytes that neither a docs build nor a health check can download, so this file holds
 *   the measurement and `dev-tools/data/published-bundles.run.ts` is its one writer. The `published-bundles` check in
 *   `@mailwoman/repo-health` compares it against the registry. The docs site renders it beside its date.
 *
 *   A value that could not be measured is recorded as unmeasured with the reason. It is never defaulted, because a
 *   default reads the same as a measurement to everyone downstream.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import type { LayerTier } from "@mailwoman/core/layers/schema"
import { resolvePackagePathFrom } from "@mailwoman/core/module/resolve-from"
import type { PathBuilderLike } from "path-ts"

/**
 * Whether a snapshot value was read from the artifact or the server, or could not be.
 */
export const MeasurementStatus = {
	Measured: "measured",
	Unmeasured: "unmeasured",
} as const

export type MeasurementStatus = (typeof MeasurementStatus)[keyof typeof MeasurementStatus]

/**
 * A value the writer could not read, with the reason it records in place of a number.
 */
export interface UnmeasuredValue {
	status: typeof MeasurementStatus.Unmeasured
	reason: string
}

/**
 * The `content-length` the bucket reported for one artifact.
 */
export type ServedSize =
	| {
			status: typeof MeasurementStatus.Measured
			contentLength: number
	  }
	| UnmeasuredValue

/**
 * The tier and license expression an artifact's own `layer_manifest` records.
 *
 * `expression` is the manifest's flat `license` string, verbatim.
 * It joins every upstream's terms with `AND`.
 *
 * That claims that all of them govern the whole artifact.
 * Counsel states that claim is wrong for a database whose own rights differ from the rights in its contents.
 *
 * It is recorded because it is the value in the artifact.
 * The per-component record belongs in {@link BundleRightsRecord}.
 *
 * `null` records a manifest row that holds no expression.
 * This value describes the row rather than a failure to read it.
 */
export type ServedManifest =
	| {
			status: typeof MeasurementStatus.Measured
			tier: LayerTier
			expression: string | null
	  }
	| UnmeasuredValue

/**
 * One artifact of a published bundle, keyed by its object path in the bucket.
 */
export interface PublishedArtifactRecord {
	remotePath: string
	size: ServedSize
	manifest: ServedManifest
}

/**
 * The license governing a bundle's database as a whole, distinct from the rights in its contents.
 */
export type DatabaseLicense =
	| {
			status: typeof MeasurementStatus.Measured
			license: string
	  }
	| UnmeasuredValue

/**
 * One upstream component of a bundle, in the shape counsel asked for: provenance, license
 * identity, attribution text and review state as separate fields, with the database license
 * and the content license under distinct keys because ODbL grants them separately.
 */
export interface RightsComponent {
	source: string
	/**
	 * The license on the component's database rights, where the source grants those.
	 */
	databaseLicense?: string
	/**
	 * The license on the component's contents, where the source grants those separately.
	 */
	contentLicense?: string
	/**
	 * The license for a source that makes no database and content distinction.
	 */
	license?: string
	attribution?: string[]
	/**
	 * Recorded in place of a license when the terms depend on which upstream a row came from.
	 */
	reviewState?: string
	provenance?: string
}

/**
 * What is known about a bundle's rights beyond its artifacts' flat expressions.
 *
 * `components` is empty when none was measured.
 * A component without a read record is absent.
 *
 * The code does not synthesize it from the flat expression.
 * This follows the same rule as an absent artifact.
 */
export interface BundleRightsRecord {
	database: DatabaseLicense
	components: RightsComponent[]
}

/**
 * One bundle of `BUNDLES`, with a record per artifact.
 */
export interface PublishedBundleRecord {
	bundle: string
	rights: BundleRightsRecord
	artifacts: PublishedArtifactRecord[]
}

/**
 * The whole snapshot as committed.
 */
export interface PublishedBundlesSnapshot {
	/**
	 * The ISO 8601 instant when the writer ran.
	 * Readers render it as the measurement date.
	 */
	measuredAt: string
	/**
	 * The bucket base URL every `remotePath` was measured against.
	 */
	bucket: string
	bundles: PublishedBundleRecord[]
}

/**
 * The repository-relative path of the snapshot, the one string a checkout-relative reader needs.
 */
export const PUBLISHED_BUNDLES_SNAPSHOT_FILE = "packages/mailwoman/data/published-bundles.json"

/**
 * The absolute path of the snapshot inside the installed `mailwoman` package.
 */
export function publishedBundlesSnapshotPath(): string {
	return resolvePackagePathFrom(import.meta.url, "mailwoman", "data", "published-bundles.json")
}

function fail(path: string, where: string, problem: string): never {
	throw new Error(`${path}: ${where} ${problem}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertUnmeasured(value: Record<string, unknown>, path: string, where: string): UnmeasuredValue {
	if (typeof value.reason !== "string" || !value.reason.length) {
		fail(path, where, "is unmeasured and records no reason")
	}

	return { status: MeasurementStatus.Unmeasured, reason: value.reason }
}

function assertServedSize(value: unknown, path: string, where: string): ServedSize {
	if (!isRecord(value)) {
		fail(path, where, "is not an object")
	}

	if (value.status === MeasurementStatus.Unmeasured) return assertUnmeasured(value, path, where)

	if (value.status !== MeasurementStatus.Measured) {
		fail(path, where, `has status ${stringifyJSON(value.status ?? null)} rather than measured or unmeasured`)
	}

	if (!Number.isSafeInteger(value.contentLength) || (value.contentLength as number) < 0) {
		fail(path, where, `records contentLength ${stringifyJSON(value.contentLength ?? null)}, which is not a byte count`)
	}

	return { status: MeasurementStatus.Measured, contentLength: value.contentLength as number }
}

function assertServedManifest(value: unknown, path: string, where: string): ServedManifest {
	if (!isRecord(value)) {
		fail(path, where, "is not an object")
	}

	if (value.status === MeasurementStatus.Unmeasured) return assertUnmeasured(value, path, where)

	if (value.status !== MeasurementStatus.Measured) {
		fail(path, where, `has status ${stringifyJSON(value.status ?? null)} rather than measured or unmeasured`)
	}

	if (typeof value.tier !== "string" || !value.tier.length) {
		fail(path, where, "records no tier")
	}

	if (value.expression !== null && typeof value.expression !== "string") {
		fail(
			path,
			where,
			`records expression ${stringifyJSON(value.expression ?? null)}. The value must be a string or null`
		)
	}

	return {
		status: MeasurementStatus.Measured,
		tier: value.tier as LayerTier,
		expression: value.expression as string | null,
	}
}

function assertDatabaseLicense(value: unknown, path: string, where: string): DatabaseLicense {
	if (!isRecord(value)) {
		fail(path, where, "is not an object")
	}

	if (value.status === MeasurementStatus.Unmeasured) return assertUnmeasured(value, path, where)

	if (value.status !== MeasurementStatus.Measured) {
		fail(path, where, `has status ${stringifyJSON(value.status ?? null)} rather than measured or unmeasured`)
	}

	if (typeof value.license !== "string" || !value.license.length) {
		fail(path, where, "is measured and records no license")
	}

	return { status: MeasurementStatus.Measured, license: value.license }
}

const OPTIONAL_COMPONENT_STRINGS = [
	"databaseLicense",
	"contentLicense",
	"license",
	"reviewState",
	"provenance",
] as const satisfies ReadonlyArray<keyof RightsComponent>

function assertRightsComponent(value: unknown, path: string, where: string): RightsComponent {
	if (!isRecord(value)) {
		fail(path, where, "is not an object")
	}

	if (typeof value.source !== "string" || !value.source.length) {
		fail(path, where, "has no source")
	}

	const component: RightsComponent = { source: value.source }

	for (const key of OPTIONAL_COMPONENT_STRINGS) {
		if (value[key] === undefined) continue

		if (typeof value[key] !== "string") {
			fail(path, `${where}.${key}`, "is not a string")
		}

		component[key] = value[key]
	}

	if (value.attribution !== undefined) {
		if (!Array.isArray(value.attribution) || !value.attribution.every((line) => typeof line === "string")) {
			fail(path, `${where}.attribution`, "is not an array of strings")
		}

		component.attribution = value.attribution as string[]
	}

	return component
}

function assertRights(value: unknown, path: string, where: string): BundleRightsRecord {
	if (!isRecord(value)) {
		fail(path, where, "is not an object")
	}

	if (!Array.isArray(value.components)) {
		fail(path, `${where}.components`, "is not an array")
	}

	return {
		database: assertDatabaseLicense(value.database, path, `${where}.database`),
		components: value.components.map((component, index) =>
			assertRightsComponent(component, path, `${where}.components[${index}]`)
		),
	}
}

function assertArtifact(value: unknown, path: string, where: string): PublishedArtifactRecord {
	if (!isRecord(value)) {
		fail(path, where, "is not an object")
	}

	if (typeof value.remotePath !== "string" || !value.remotePath.length) {
		fail(path, where, "has no remotePath")
	}

	return {
		remotePath: value.remotePath,
		size: assertServedSize(value.size, path, `${where}.size`),
		manifest: assertServedManifest(value.manifest, path, `${where}.manifest`),
	}
}

/**
 * Validates a parsed snapshot field by field, throwing on the first field it cannot read.
 *
 * Every field is required.
 * A reader that filled one in would hand its consumers an unmeasured number.
 */
export function assertPublishedBundlesSnapshot(value: unknown, path: string): PublishedBundlesSnapshot {
	if (!isRecord(value)) {
		fail(path, "the document", "is not an object")
	}

	if (typeof value.measuredAt !== "string" || Number.isNaN(Date.parse(value.measuredAt))) {
		fail(path, "measuredAt", `is ${stringifyJSON(value.measuredAt ?? null)} rather than an ISO 8601 instant`)
	}

	if (typeof value.bucket !== "string" || !value.bucket.length) {
		fail(path, "bucket", "is missing")
	}

	if (!Array.isArray(value.bundles)) {
		fail(path, "bundles", "is not an array")
	}

	const bundles = value.bundles.map((entry, index): PublishedBundleRecord => {
		const where = `bundles[${index}]`

		if (!isRecord(entry)) {
			fail(path, where, "is not an object")
		}

		if (typeof entry.bundle !== "string" || !entry.bundle.length) {
			fail(path, where, "has no bundle name")
		}

		if (!Array.isArray(entry.artifacts)) {
			fail(path, `${where}.artifacts`, "is not an array")
		}

		return {
			bundle: entry.bundle,
			rights: assertRights(entry.rights, path, `${where}.rights`),
			artifacts: entry.artifacts.map((artifact, artifactIndex) =>
				assertArtifact(artifact, path, `${where}.artifacts[${artifactIndex}]`)
			),
		}
	})

	return { measuredAt: value.measuredAt, bucket: value.bucket, bundles }
}

/**
 * Reads and validates the snapshot at `path`, defaulting to the committed copy.
 */
export async function readPublishedBundlesSnapshot(
	path: PathBuilderLike = publishedBundlesSnapshotPath()
): Promise<PublishedBundlesSnapshot> {
	return assertPublishedBundlesSnapshot(await readLocalJSONFile<unknown>(path), path.toString())
}
