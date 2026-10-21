/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A result that resolved to a postcode or an admin place in a country whose finer tier is published and not
 *   installed states so, in the `engine` block and under the CLI's text result. The statement is information about
 *   the installation, in the shape of AG Grid's watermark without the defacement: the result is printed as computed,
 *   and the absence is labeled with the command that fills it.
 */

import type { GeocodeResult } from "@mailwoman/core/geocode"
import type { EngineCoverage } from "@mailwoman/core/license"
import type { PathBuilderLike } from "path-ts"

import { bundleArtifactPath, BUNDLES, type DataBundle } from "#data/bundles"
import { existingLocalPath, readReleaseManifest } from "#data/release"

/**
 * The tiers a published country tier would resolve further than.
 *
 * `address_point`, `interpolated`, `street`, `venue` and `plus_code` already place
 * the result at or below a street, so no ceiling applies to them.
 */
const CEILING_TIERS: ReadonlySet<GeocodeResult["resolution_tier"]> = new Set(["postcode", "admin"])

/**
 * The bundles whose every artifact is on disk under the data root, by name.
 */
export async function installedBundleNames(
	dataRoot: PathBuilderLike,
	bundles: Readonly<Record<string, DataBundle>> = BUNDLES
): Promise<ReadonlySet<string>> {
	const manifest = await readReleaseManifest(dataRoot)
	const installed = new Set<string>()

	for (const bundle of Object.values(bundles)) {
		let present = bundle.artifacts.length > 0

		for (const artifact of bundle.artifacts) {
			const existing = await existingLocalPath(dataRoot, manifest, artifact, bundleArtifactPath(dataRoot, artifact))

			if (!existing) {
				present = false

				break
			}
		}

		if (present) {
			installed.add(bundle.name)
		}
	}

	return installed
}

/**
 * The ceiling a result met, or `null` when the result is already fine,
 * the country has no published tier, or the tier is installed.
 */
export function precisionCeiling(
	result: Pick<GeocodeResult, "resolution_tier" | "countryCode">,
	installed: ReadonlySet<string>,
	bundles: Readonly<Record<string, DataBundle>> = BUNDLES
): EngineCoverage | null {
	const bundle = ceilingCandidate(result, bundles)

	if (!bundle?.tier || installed.has(bundle.name)) return null

	return { resolved: result.resolution_tier, tier: bundle.tier, command: `mailwoman data pull ${bundle.name}` }
}

/**
 * The first tiered bundle that covers the result's country, when the result resolved
 * coarsely enough for a tier to matter, or `null`.
 *
 * This reads no disk, so a caller can skip the installed-bundle scan when it answers `null`,
 * which it does for every result today because no bundle declares a tier.
 */
export function ceilingCandidate(
	result: Pick<GeocodeResult, "resolution_tier" | "countryCode">,
	bundles: Readonly<Record<string, DataBundle>> = BUNDLES
): DataBundle | null {
	if (!CEILING_TIERS.has(result.resolution_tier)) return null

	const country = result.countryCode

	if (country == null) return null

	return Object.values(bundles).find((bundle) => bundle.tier && bundle.countries?.includes(country)) ?? null
}

/**
 * The sentence the CLI prints under a text result that met a ceiling.
 */
export function coverageSentence(coverage: EngineCoverage): string {
	return `Resolved to ${coverage.resolved}. The ${coverage.tier} tier covers this country and is not installed: ${coverage.command}`
}
