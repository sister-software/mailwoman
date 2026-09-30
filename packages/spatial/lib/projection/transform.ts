import { runFile } from "@mailwoman/core/process"
import { TextSpliterator } from "spliterator"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ask PROJ which datum transformation it would choose. Refuse a ballpark operation.
 *
 *   PROJ silently substitutes a ballpark datum shift when the accurate grid is absent. On the EA flood product,
 *   `ogr2ogr` placed the first feature's first vertex at `1.698151293, 52.648130027` without the OSGB36→WGS84 grid.
 *   With `uk_os_OSTN15_NTv2_OSGBtoETRS.tif` present, it placed the vertex at `1.698174628, 52.648157259`, a distance
 *   of 3.4 m. Both coordinates look like ordinary WGS84 values and pass a bounding-box check. The layer is offset.
 *   The check found eight disagreements among 59 points against the authority's OGC service. Each point fell into a
 *   neighbouring sliver.
 *
 *   GDAL 3.8 does not pass `--config PROJ_NETWORK on` through to PROJ. Tests also showed that `PROJ_ONLY_BEST=on`
 *   does not refuse a ballpark shift. `projinfo` provides the usable check. Its output identifies the best candidate
 *   operation and reports a missing grid.
 *
 *   The check runs even when a source needs no transformation. A source already in EPSG:4326 returns
 *   `Null geographic offset from WGS 84 to WGS 84, 0 m, World.` This operation is usable. The check costs one process.
 *   A skipped case would leave a later source's required grid unchecked.
 *
 *   Every vector ingest shares this check because the failure comes from PROJ rather than from a particular product.
 *   Output parsing is separate from process execution so tests can use captured output. The two output states came from the
 *   same command on the same machine before and after grid installation. One produced a metre-accurate layer. The
 *   other produced a 3 m offset.
 */

/**
 * Reports the operation PROJ would choose and whether it can run it.
 */
export interface DatumTransformationVerdict {
	/**
	 * The candidate operation string returned by PROJ, verbatim.
	 *
	 * Absent when PROJ returned no candidate operation.
	 */
	best?: string
	usable: boolean
	reason: string
}

/**
 * Reads `projinfo --summary` output.
 *
 * It reports which operation PROJ would choose and whether it can run it.
 */
export function assessDatumTransformation(summary: string): DatumTransformationVerdict {
	// The first line naming a candidate operation is the one PROJ will choose.
	// Earlier lines are headers.
	// The `Note:` line about `--spatial-test` also describes no candidate operation.
	// The reader trims each line.
	const best = TextSpliterator.from(summary).find(
		(line) => line.includes(", ") && !line.startsWith("Note:") && !line.startsWith("Candidate operations")
	)

	if (!best) return { usable: false, reason: "projinfo named no candidate operation" }

	if (best.includes("grid missing")) return { best, usable: false, reason: "its grid is not installed" }

	if (best.toLowerCase().includes("ballpark")) return { best, usable: false, reason: "it is a ballpark offset" }

	return { best, usable: true, reason: "the best operation is available" }
}

/**
 * The target every layer ingest reprojects to.
 * H3 takes WGS84 latitude and longitude.
 */
export const WGS84_EPSG = 4326

export interface AssertDatumTransformationOptions {
	/**
	 * Identifies the caller in the refusal, so a build log reports which ingest stopped.
	 */
	context: string
	targetEPSG?: number
	/**
	 * The area-of-use to name in the `projsync` action the message prints.
	 */
	areaOfUse?: string
}

/**
 * Refuse an ingest whose best available datum transformation is a ballpark one, or is missing its grid.
 *
 * @throws {Error} When proj names no candidate, would use a ballpark offset,
 * or would use an operation whose grid is not installed.
 */
export async function assertDatumTransformationAvailable(
	sourceEPSG: number,
	options: AssertDatumTransformationOptions
): Promise<DatumTransformationVerdict> {
	const targetEPSG = options.targetEPSG ?? WGS84_EPSG

	const { stdout } = await runFile("projinfo", ["-s", `EPSG:${sourceEPSG}`, "-t", `EPSG:${targetEPSG}`, "--summary"])

	const verdict = assessDatumTransformation(stdout)

	if (verdict.usable) return verdict

	const remedy = options.areaOfUse
		? `Install the grid with \`projsync --area-of-use "${options.areaOfUse}"\` and re-run.`
		: "Install the grid with `projsync` for the source's area of use and re-run."

	throw new Error(
		`${options.context}: the best EPSG:${sourceEPSG} → EPSG:${targetEPSG} transformation is unusable — ${verdict.reason} ` +
			`(${verdict.best ?? "projinfo named no candidate"}). PROJ falls back to a ballpark datum shift, which is metres ` +
			`wrong and looks exactly like a correct answer. ${remedy}`
	)
}
