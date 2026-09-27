/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The registry of published data bundles agrees with the committed measurement of the bucket.
 *
 *   `BUNDLES` in `mailwoman/data` records each artifact's `approxBytes` by hand, and `data status` compares a local
 *   file against that figure exactly. `packages/mailwoman/data/published-bundles.json` records the `content-length`
 *   the bucket reported for the same artifacts on a stated date. The two drifted apart once without any check
 *   noticing, and the docs site restated the stale figure to customers. This check reports an artifact the snapshot
 *   does not cover, an artifact the registry no longer names, a size the snapshot could not read, and a size the two
 *   disagree on.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import {
	assertPublishedBundlesSnapshot,
	BUNDLES,
	type DataBundle,
	MeasurementStatus,
	PUBLISHED_BUNDLES_SNAPSHOT_FILE,
	type PublishedBundlesSnapshot,
} from "mailwoman/data"
import { resolvePath } from "path-ts"

import { type Diagnostic, DiagnosticSeverity, type RepoCheck } from "#check"

/**
 * How far the registry's `approxBytes` may sit from the bucket's `content-length`
 * before the check reports it.
 *
 * Zero, because `data status` compares a local file against `approxBytes` exactly,
 * so a registry figure one byte off reports every correct download as stale.
 * The first snapshot, taken 2026-09-27, found all 106 published artifacts matching to
 * the byte, so the tolerance refuses no artifact that is right today.
 */
export const APPROX_BYTES_TOLERANCE = 0

/**
 * Compares a bundle registry against a snapshot and returns one diagnostic per disagreement.
 *
 * Pure over its arguments so a test can plant either side.
 */
export function compareRegistryToSnapshot(
	bundles: Record<string, DataBundle>,
	snapshot: PublishedBundlesSnapshot,
	file: string
): Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const measured = new Map<string, number | null>()
	const snapshotBundles = new Set<string>()

	for (const record of snapshot.bundles) {
		snapshotBundles.add(record.bundle)

		for (const artifact of record.artifacts) {
			measured.set(
				artifact.remotePath,
				artifact.size.status === MeasurementStatus.Measured ? artifact.size.contentLength : null
			)
		}
	}

	const registered = new Set<string>()

	for (const bundle of Object.values(bundles)) {
		if (!snapshotBundles.has(bundle.name)) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				file,
				message: `bundle \`${bundle.name}\` is in BUNDLES and has no row in the snapshot. Run published-bundles.run.ts and commit the result.`,
			})
		}

		for (const artifact of bundle.artifacts) {
			registered.add(artifact.remotePath)

			if (!measured.has(artifact.remotePath)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					file,
					message: `\`${artifact.remotePath}\` (bundle \`${bundle.name}\`) is in BUNDLES and has no row in the snapshot.`,
				})

				continue
			}

			const contentLength = measured.get(artifact.remotePath)

			if (contentLength === null || contentLength === undefined) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					file,
					message: `\`${artifact.remotePath}\` (bundle \`${bundle.name}\`) has an unmeasured size in the snapshot, so its approxBytes of ${artifact.approxBytes} is unverified.`,
				})

				continue
			}

			if (Math.abs(contentLength - artifact.approxBytes) > APPROX_BYTES_TOLERANCE) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					file,
					message: `\`${artifact.remotePath}\` (bundle \`${bundle.name}\`) records approxBytes ${artifact.approxBytes} and the bucket served ${contentLength} bytes on ${snapshot.measuredAt}. Correct the registry, or re-run published-bundles.run.ts if the artifact changed.`,
				})
			}
		}
	}

	for (const remotePath of measured.keys()) {
		if (registered.has(remotePath)) continue

		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			file,
			message: `\`${remotePath}\` is in the snapshot and no bundle in BUNDLES names it. Re-run published-bundles.run.ts so the snapshot describes the registry.`,
		})
	}

	return diagnostics
}

/**
 * The `published-bundles` check, over the live registry and the committed snapshot.
 */
export const publishedBundlesCheck: RepoCheck = {
	id: "published-bundles",
	description:
		"Every artifact in BUNDLES has a measured content-length in packages/mailwoman/data/published-bundles.json that equals its approxBytes.",
	async run(context) {
		const file = PUBLISHED_BUNDLES_SNAPSHOT_FILE

		const snapshot = assertPublishedBundlesSnapshot(
			await readLocalJSONFile<unknown>(resolvePath(context.repoRoot, file)),
			file
		)

		return compareRegistryToSnapshot(BUNDLES, snapshot, file)
	},
}
