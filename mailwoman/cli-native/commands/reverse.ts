/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isValidLatitude, isValidLongitude } from "@mailwoman/spatial/coordinate-bounds"

import { CLIError, CLIUsageError, type CommandSpec, parseCommand, renderCommandHelp } from "../spec.ts"

/**
 * Native reverse-geocode command contract.
 */
export const spec = {
	name: "reverse",
	description: "Resolve a WGS-84 coordinate to its containing Who's On First administrative hierarchy.",
	positionals: [
		{ name: "lat", description: "Latitude in WGS-84 decimal degrees.", required: true },
		{ name: "lon", description: "Longitude in WGS-84 decimal degrees.", required: true },
	],
	options: {
		"admin-db": {
			type: "string",
			hint: "path",
			description: "Admin gazetteer SQLite DB carrying the place_bbox R*Tree.",
		},
		"polygons-db": {
			type: "string",
			hint: "path",
			description: "Optional polygon sidecar; without it containment is approximate.",
		},
		format: {
			type: "string",
			default: "json",
			choices: ["json", "text"],
			description: "Machine-readable JSON or a human-readable hierarchy.",
		},
	},
} as const satisfies CommandSpec

function coordinate(raw: string, kind: "latitude" | "longitude"): number {
	const value = Number(raw)
	const valid = kind === "latitude" ? isValidLatitude(value) : isValidLongitude(value)

	if (!valid) {
		const range = kind === "latitude" ? "[-90, 90]" : "[-180, 180]"

		throw new CLIUsageError(`Invalid ${kind} ${JSON.stringify(raw)} — must be a number in ${range}.`)
	}

	return value
}

/**
 * Run `mw reverse` without loading React, Ink, or Zod.
 */
export async function run(args: readonly string[]): Promise<number> {
	let parsed

	try {
		parsed = parseCommand(spec, args)
	} catch (error) {
		if (error instanceof CLIUsageError && error.message.startsWith("Missing required argument")) {
			throw new CLIUsageError(
				"reverse requires two positional arguments: <lat> <lon> (for example mw reverse 40.7128 -74.0060)."
			)
		}

		throw error
	}

	if (parsed.values.help) {
		process.stdout.write(`${await renderCommandHelp(spec)}\n`)

		return 0
	}

	const lat = coordinate(parsed.positionals[0]!, "latitude")
	const lon = coordinate(parsed.positionals[1]!, "longitude")
	const { $public } = await import("@mailwoman/core/env")

	const adminDBPath =
		typeof parsed.values["admin-db"] === "string" ? parsed.values["admin-db"] : $public.MAILWOMAN_WOF_ADMIN_DB

	const polygonDBPath =
		typeof parsed.values["polygons-db"] === "string" ? parsed.values["polygons-db"] : $public.MAILWOMAN_WOF_POLYGONS_DB

	if (!adminDBPath) {
		throw new CLIError(
			"reverse needs an admin DB path. Set $MAILWOMAN_WOF_ADMIN_DB or pass --admin-db <path>. " +
				"Build one with `mailwoman gazetteer build admin` followed by `mailwoman gazetteer build fts`."
		)
	}

	const mod = await import("@mailwoman/resolver-wof-sqlite")
	const geocoder = new mod.WOFReverseGeocoder({ adminDBPath, polygonDBPath })

	try {
		const result = await geocoder.reverseGeocode(lat, lon)

		if (parsed.values.format === "text") {
			const lines = [`containment: ${result.containment}`]

			if (!result.hierarchy.length) {
				lines.push("(no admin hierarchy — point may be in open ocean or outside the gazetteer coverage)")
			} else {
				for (const place of result.hierarchy) {
					const distance = place.distanceKm === undefined ? "" : ` (~${place.distanceKm.toFixed(1)} km from centroid)`

					lines.push(`  ${place.placetype.padEnd(16)} ${place.name} [wof:${place.id}]${distance}`)
				}
			}

			process.stdout.write(`${lines.join("\n")}\n`)
		} else {
			process.stdout.write(
				`${JSON.stringify(
					{
						lat,
						lon,
						containment: result.containment,
						hierarchy: result.hierarchy.map((place) => ({
							id: place.id,
							name: place.name,
							placetype: place.placetype,
							country: place.country,
							lat: place.lat,
							lon: place.lon,
							...(place.distanceKm === undefined ? {} : { distanceKm: place.distanceKm }),
						})),
					},
					null,
					2
				)}\n`
			)
		}

		return 0
	} finally {
		geocoder.close()
	}
}
