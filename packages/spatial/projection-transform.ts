/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ask PROJ which datum transformation it would choose, and refuse a ballpark one.
 *
 *   PROJ SUBSTITUTES A BALLPARK DATUM SHIFT WHEN THE ACCURATE GRID IS NOT ON DISK, AND IT DOES SO SILENTLY.
 *   Measured on the EA flood product: with the OSGB36→WGS84 grid missing, ogr2ogr placed the first
 *   feature's first vertex at `1.698151293, 52.648130027`; with `uk_os_OSTN15_NTv2_OSGBtoETRS.tif` present
 *   it placed it at `1.698174628, 52.648157259` — 3.4 m apart. Both look like perfectly ordinary WGS84
 *   coordinates, both pass a bounding-box check, and the whole layer is offset. It surfaced as eight
 *   disagreements out of 59 against the authority's own OGC service, every one a point that fell into a
 *   NEIGHBOURING sliver.
 *
 *   `--config PROJ_NETWORK ON` does not reach PROJ through GDAL 3.8, and `PROJ_ONLY_BEST=ON` was observed
 *   not to refuse, so neither is a usable guard. What is usable is asking PROJ what it would do: `projinfo`
 *   names the best candidate operation and says when a grid is missing.
 *
 *   IT IS RUN EVEN WHERE NO TRANSFORMATION IS NEEDED, AND THAT IS THE POINT. A source already in EPSG:4326
 *   gets `Null geographic offset from WGS 84 to WGS 84, 0 m, World.` — trivially usable, and the check costs
 *   one process. Skipping it on the reasoning that a source needs no shift makes the guard fire on the day
 *   a source arrives that does, which is the day nobody is looking.
 *
 *   SHARED BY EVERY VECTOR INGEST, because the failure is a property of PROJ rather than of any product. The
 *   parse is split from the spawn so it can be pinned against captured output: the two states it
 *   distinguishes were observed from the same command on the same machine, before and after the grid was
 *   installed, and they are the difference between a metre-accurate layer and a 3 m-offset one.
 */

import { execFile } from "@mailwoman/platform/child_process"
import { promisify } from "@mailwoman/platform/util"

const execFileAsync = promisify(execFile)

/**
 * What PROJ would do, and whether it can actually do it.
 */
export interface DatumTransformationVerdict {
	/**
	 * The candidate operation line PROJ named, verbatim. Absent when it named none.
	 */
	best?: string
	usable: boolean
	reason: string
}

/**
 * Read `projinfo --summary` output: which operation PROJ would choose, and whether it can actually run.
 */
export function assessDatumTransformation(summary: string): DatumTransformationVerdict {
	// The first line naming a candidate operation is the one PROJ will choose. Everything before it is a header, and the
	// `Note:` line about `--spatial-test` is not a candidate.
	//
	// `projinfo --summary` prints a header plus one line per candidate operation: two to nine lines, bounded by PROJ's own
	// candidate enumeration rather than by input size. Reaching for a streaming reader would put a `spliterator` dependency
	// on this package for a fixed handful of lines.
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- bounded output, see above
	const lines = summary.split("\n")

	const best = lines
		.map((line) => line.trim())
		.find((line) => line.includes(", ") && !line.startsWith("Note:") && !line.startsWith("Candidate operations"))

	if (!best) return { usable: false, reason: "projinfo named no candidate operation" }

	if (best.includes("grid missing")) return { best, usable: false, reason: "its grid is not installed" }

	if (best.toLowerCase().includes("ballpark")) return { best, usable: false, reason: "it is a ballpark offset" }

	return { best, usable: true, reason: "the best operation is available" }
}

/**
 * The target every layer ingest reprojects to — H3 takes WGS84 latitude and longitude.
 */
export const WGS84_EPSG = 4326

export interface AssertDatumTransformationOptions {
	/**
	 * Names the caller in the refusal, so a build log says which ingest stopped.
	 */
	context: string
	targetEPSG?: number
	/**
	 * The area-of-use to name in the `projsync` remedy the message prints.
	 */
	areaOfUse?: string
}

/**
 * Refuse an ingest whose best available datum transformation is a ballpark one, or is missing its grid.
 *
 * @throws {Error} When PROJ names no candidate, would use a ballpark offset, or would use an operation whose grid is
 *   not installed.
 */
export async function assertDatumTransformationAvailable(
	sourceEPSG: number,
	options: AssertDatumTransformationOptions
): Promise<DatumTransformationVerdict> {
	const targetEPSG = options.targetEPSG ?? WGS84_EPSG

	const { stdout } = await execFileAsync("projinfo", [
		"-s",
		`EPSG:${sourceEPSG}`,
		"-t",
		`EPSG:${targetEPSG}`,
		"--summary",
	])

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
