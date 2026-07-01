/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman reverse <lat> <lon>` — resolve a WGS-84 coordinate to its containing admin hierarchy
 *   via the WOFReverseGeocoder (#484).
 *
 *   Falls back to the MAILWOMAN_WOF_ADMIN_DB / MAILWOMAN_WOF_POLYGONS_DB env vars when the
 *   corresponding flags are absent. Prints a JSON object with the resolved hierarchy and the
 *   containment kind (polygon | approximate) so callers can gauge result quality.
 *
 *   Exit-code contract:
 *
 *   - 0 successful reverse-geocode (including "open ocean" empty-hierarchy)
 *   - 1 bad arguments or DB path missing / wrong
 */

import { setImmediate } from "node:timers/promises"

import { Spinner } from "@inkjs/ui"
import { Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../sdk/cli.js"
import { $public } from "../sdk/runtime/index.js"

const ArgumentsSchema = zod
	.array(zod.string())
	.describe("Positional args: <lat> <lon> — WGS-84 decimal degrees (e.g. 40.7128 -74.0060).")

const OptionsSchema = zod.object({
	adminDb: zod
		.string()
		.optional()
		.describe(
			"Path to the admin gazetteer SQLite DB (must carry the package-built place_bbox R*Tree). " +
				"Defaults to $MAILWOMAN_WOF_ADMIN_DB."
		),
	polygonsDb: zod
		.string()
		.optional()
		.describe(
			"Path to the polygon sidecar DB (wof-polygons.db, table polygons(id, geom)). " +
				"Without it every result is containment: approximate. " +
				"Defaults to $MAILWOMAN_WOF_POLYGONS_DB."
		),
	format: zod
		.enum(["json", "text"])
		.optional()
		.default("json")
		.describe('Output format. "json" emits a machine-readable object; "text" prints a human-readable hierarchy.'),
})

export { ArgumentsSchema as args, OptionsSchema as options }

function resolveAdminDBPath(options: zod.infer<typeof OptionsSchema>): string {
	const path = options.adminDb ?? $public.MAILWOMAN_WOF_ADMIN_DB

	if (!path) {
		throw new Error(
			"reverse needs an admin DB path. Set $MAILWOMAN_WOF_ADMIN_DB or pass --admin-db <path>. " +
				"Build one with `mailwoman-wof-build-fts <path-to-wof.db>` after building the WOF SQLite " +
				"distribution with `mailwoman-wof-build-slim`."
		)
	}

	return path
}

function resolvePolygonsDBPath(options: zod.infer<typeof OptionsSchema>): string | undefined {
	return options.polygonsDb ?? $public.MAILWOMAN_WOF_POLYGONS_DB
}

async function runReverse(lat: number, lon: number, options: zod.infer<typeof OptionsSchema>): Promise<string> {
	let mod: typeof import("@mailwoman/resolver-wof-sqlite")

	try {
		mod = await import("@mailwoman/resolver-wof-sqlite")
	} catch {
		throw new Error(
			"reverse requires `@mailwoman/resolver-wof-sqlite` to be installed. " +
				"Run `npm install @mailwoman/resolver-wof-sqlite` and try again."
		)
	}

	const adminDBPath = resolveAdminDBPath(options)
	const polygonDBPath = resolvePolygonsDBPath(options)

	const geocoder = new mod.WOFReverseGeocoder({ adminDBPath, polygonDBPath })

	try {
		const result = await geocoder.reverseGeocode(lat, lon)

		if (options.format === "text") {
			const lines: string[] = []
			lines.push(`containment: ${result.containment}`)

			if (result.hierarchy.length === 0) {
				lines.push("(no admin hierarchy — point may be in open ocean or outside the gazetteer coverage)")
			} else {
				for (const place of result.hierarchy) {
					const distStr = place.distanceKm !== undefined ? ` (~${place.distanceKm.toFixed(1)} km from centroid)` : ""
					lines.push(`  ${place.placetype.padEnd(16)} ${place.name} [wof:${place.id}]${distStr}`)
				}
			}

			return lines.join("\n")
		}

		// JSON: emit a tidy object — the full hierarchy array + containment at the top level.
		return JSON.stringify(
			{
				lat,
				lon,
				containment: result.containment,
				hierarchy: result.hierarchy.map((p) => ({
					id: p.id,
					name: p.name,
					placetype: p.placetype,
					country: p.country,
					lat: p.lat,
					lon: p.lon,
					...(p.distanceKm !== undefined ? { distanceKm: p.distanceKm } : {}),
				})),
			},
			null,
			2
		)
	} finally {
		geocoder.close()
	}
}

const ReverseCommand: CommandComponent<typeof OptionsSchema, typeof ArgumentsSchema> = ({ args, options }) => {
	const [output, setOutput] = useState<string>()
	const [error, setError] = useState<string>()

	useEffect(() => {
		if (error) {
			setImmediate().then(() => process.exit(1))
		}
	}, [error])

	useEffect(() => {
		const rawLat = args[0]
		const rawLon = args[1]

		if (!rawLat || !rawLon) {
			setError("reverse requires two positional arguments: <lat> <lon>  (e.g. mailwoman reverse 40.7128 -74.0060)")

			return
		}

		const lat = Number(rawLat)
		const lon = Number(rawLon)

		if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
			setError(`Invalid latitude ${JSON.stringify(rawLat)} — must be a number in [-90, 90].`)

			return
		}

		if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
			setError(`Invalid longitude ${JSON.stringify(rawLon)} — must be a number in [-180, 180].`)

			return
		}

		runReverse(lat, lon, options)
			.then(setOutput)
			.catch((err: unknown) => setError((err as Error).message))
	}, [args, options])

	if (error) {
		return <Text color="red">{error}</Text>
	}

	if (!output) {
		return <Spinner />
	}

	return <Text>{output}</Text>
}

export default ReverseCommand
