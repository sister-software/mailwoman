/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measures what the public bucket serves for every artifact in `BUNDLES` and writes the committed snapshot
 *   `packages/mailwoman/data/published-bundles.json`.
 *
 *   Each artifact gets two readings. The size is the `content-length` a HEAD request against its public URL
 *   reports, which needs no download. The tier and license come from the `layer_manifest` of the local copy under
 *   the data root, which only a host that has pulled the bundle can supply. An artifact this host does not hold
 *   gets its manifest recorded as unmeasured with the path that was looked for, so a reader of the snapshot can
 *   tell a tier nobody read from a tier somebody read.
 *
 *   The `published-bundles` repository-health check compares the sizes here against the registry's `approxBytes`,
 *   and the docs site renders the snapshot beside its date. Run this after publishing an artifact or changing the
 *   registry, then commit the result.
 *
 *   Usage:
 *   node packages/mailwoman/lib/dev-tools/data/published-bundles.run.ts
 */

import { APIClient } from "@mailwoman/core/api"
import { dataRootPath } from "@mailwoman/core/data-root"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { pathExists, statPath } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { LayerTier } from "@mailwoman/core/layers/schema"
import { isoSeconds } from "@mailwoman/core/utils"

import {
	artifactURL,
	bundleArtifactPath,
	BUNDLES,
	type BundleRightsRecord,
	headContentLength,
	MeasurementStatus,
	probeManifest,
	PUBLIC_BUCKET_BASE_URL,
	type PublishedArtifactRecord,
	type PublishedBundleRecord,
	type PublishedBundlesSnapshot,
	publishedBundlesSnapshotPath,
	readReleaseManifest,
	resolveBundleArtifacts,
	type ServedManifest,
	type ServedSize,
} from "#data"

const LAYER_TIERS = new Set<string>(Object.values(LayerTier))

/**
 * The manifest row's `tier` column is a string, and only a value `LayerTier` defines is recorded as a tier.
 */
function isLayerTier(value: string): value is LayerTier {
	return LAYER_TIERS.has(value)
}

const client = new APIClient({
	displayName: "mailwoman published-bundles",
	minRequestIntervalMs: 150,
	retry: true,
})

const dataRoot = dataRootPath()
const releaseManifest = await readReleaseManifest(dataRoot)
const measuredAt = isoSeconds()

const bundles: PublishedBundleRecord[] = []
const drift: string[] = []
let sizesMeasured = 0
let sizesUnmeasured = 0
let manifestsMeasured = 0
let manifestsUnmeasured = 0

async function measureSize(url: string): Promise<ServedSize> {
	try {
		return { status: MeasurementStatus.Measured, contentLength: await headContentLength(client, url) }
	} catch (error) {
		return { status: MeasurementStatus.Unmeasured, reason: (error as Error).message }
	}
}

/**
 * Reads the manifest of the local copy at `path` only when that copy is the published artifact.
 *
 * A data root commonly holds a newer build under the published artifact's local name,
 * and the only cheap test that the two are one file is the size comparison `data status` makes.
 * A size that differs records why rather than another build's tier.
 */
async function measureManifest(path: string, size: ServedSize): Promise<ServedManifest> {
	if (!(await pathExists(path))) {
		return { status: MeasurementStatus.Unmeasured, reason: `no local copy at ${path}` }
	}

	if (size.status === MeasurementStatus.Unmeasured) {
		return {
			status: MeasurementStatus.Unmeasured,
			reason: `the bucket's size is unmeasured, so the local copy at ${path} cannot be matched to the published artifact`,
		}
	}

	const localBytes = (await statPath(path)).size

	if (localBytes !== size.contentLength) {
		return {
			status: MeasurementStatus.Unmeasured,
			reason: `local copy at ${path} is ${localBytes} bytes and the published artifact is ${size.contentLength} bytes, so its manifest describes a different build`,
		}
	}

	const { manifest, error } = probeManifest(path)

	if (error) {
		return { status: MeasurementStatus.Unmeasured, reason: `${path}: ${error}` }
	}

	if (!manifest) {
		return { status: MeasurementStatus.Unmeasured, reason: `${path} holds no layer_manifest table` }
	}

	if (!isLayerTier(manifest.tier)) {
		return {
			status: MeasurementStatus.Unmeasured,
			reason: `${path} records tier ${stringifyJSON(manifest.tier)}, which LayerTier does not define`,
		}
	}

	return { status: MeasurementStatus.Measured, tier: manifest.tier, expression: manifest.license ?? null }
}

/**
 * No published artifact records a database-level license apart from its flat expression,
 * and no reader here can measure one, so both halves of the rights record are written
 * as unmeasured and empty rather than derived from that expression.
 */
function unmeasuredRights(): BundleRightsRecord {
	return {
		database: {
			status: MeasurementStatus.Unmeasured,
			reason: "no published artifact records a database-level license apart from its flat layer_manifest expression",
		},
		components: [],
	}
}

for (const name of Object.keys(BUNDLES).toSorted()) {
	const bundle = BUNDLES[name]!
	const artifacts: PublishedArtifactRecord[] = []

	for (const artifact of resolveBundleArtifacts(bundle, releaseManifest)) {
		const size = await measureSize(artifactURL(artifact))
		const manifest = await measureManifest(bundleArtifactPath(dataRoot, artifact), size)

		if (size.status === MeasurementStatus.Measured) {
			sizesMeasured++

			if (size.contentLength !== artifact.approxBytes) {
				drift.push(
					`${name} ${artifact.remotePath}: registry ${artifact.approxBytes} bytes, bucket ${size.contentLength} bytes`
				)
			}
		} else {
			sizesUnmeasured++
		}

		if (manifest.status === MeasurementStatus.Measured) {
			manifestsMeasured++
		} else {
			manifestsUnmeasured++
		}

		artifacts.push({ remotePath: artifact.remotePath, size, manifest })
	}

	bundles.push({ bundle: name, rights: unmeasuredRights(), artifacts })
}

await client[Symbol.asyncDispose]()

const snapshot: PublishedBundlesSnapshot = { measuredAt, bucket: PUBLIC_BUCKET_BASE_URL, bundles }
const outputPath = publishedBundlesSnapshotPath()

await writeLocalJSONFile(snapshot, outputPath)

console.log(`measured at           ${measuredAt}`)
console.log(`bundles               ${bundles.length}`)
console.log(`sizes measured        ${sizesMeasured}`)
console.log(`sizes unmeasured      ${sizesUnmeasured}`)
console.log(`manifests measured    ${manifestsMeasured}`)
console.log(`manifests unmeasured  ${manifestsUnmeasured}`)
console.log(`written to            ${outputPath}`)
console.log()

for (const { bundle, artifacts } of bundles) {
	let served = 0

	for (const artifact of artifacts) {
		if (artifact.size.status === MeasurementStatus.Measured) {
			served += artifact.size.contentLength
		}
	}

	const tiers = new Set(
		artifacts.map((artifact) =>
			artifact.manifest.status === MeasurementStatus.Measured ? artifact.manifest.tier : "unmeasured"
		)
	)

	console.log(
		`${bundle.padEnd(10)} ${String(artifacts.length).padStart(4)} artifact(s)  ${ByteFormatter.formatSI(served).padStart(9)} served  tier ${[...tiers].join(", ")}`
	)
}

if (drift.length) {
	console.log()
	console.log(`${drift.length} artifact(s) whose registry approxBytes differs from the bucket:`)

	for (const line of drift) {
		console.log(`  ${line}`)
	}
}

if (sizesUnmeasured) {
	console.log()
	console.log(`${sizesUnmeasured} size(s) could not be read, so the snapshot cannot verify those artifacts:`)

	for (const { bundle, artifacts } of bundles) {
		for (const artifact of artifacts) {
			if (artifact.size.status === MeasurementStatus.Unmeasured) {
				console.log(`  ${bundle} ${artifact.remotePath}: ${artifact.size.reason}`)
			}
		}
	}

	process.exitCode = 1
}
