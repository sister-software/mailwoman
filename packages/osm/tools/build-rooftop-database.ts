/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build a per-country OSM rooftop address-point extract from a Geofabrik `.osm.pbf` extract, from the
 *   command line. `buildRooftopDatabase` in `rooftop-database.ts` does the build; `mailwoman data build
 *   osm-address-points` runs the same function through the installer.
 *
 *   The output is an OpenStreetMap Derivative Database under ODbL 1.0. This code contains no OpenStreetMap
 *   data, and the license applies to the built `.db`. The builder prints the license notice before it starts
 *   and after it finishes. `README.md` states the licensing boundary.
 *
 *   The extract needs the receipt `tools/fetch/extract.ts` writes beside it, or `--source-url` naming where
 *   it was downloaded from.
 *
 *   Usage:
 *     node packages/osm/tools/build-rooftop-database.ts \
 *       --country fr --slug idf --release 260627 \
 *       --created-at 2026-06-27T00:00:00.000Z --build-sha $(git rev-parse head) \
 *       --pbf $MAILWOMAN_DATA_ROOT/db/osm/geofabrik/ile-de-france-260627.osm.pbf
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { scriptBuildCommand } from "@mailwoman/core/layers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"

import { osmLicenseNotice } from "#license"
import { osmDatabasePath } from "#paths"
import { readExtractProvenance } from "#sdk/extract/receipt"
import { streetLocaleForCountry } from "#street-locale"
import { buildRooftopDatabase } from "#tools/rooftop-database"

const { values } = parseArguments({
	options: {
		country: { type: "string" },
		slug: { type: "string" },
		pbf: { type: "string" },
		release: { type: "string" },
		"created-at": { type: "string" },
		"build-sha": { type: "string" },
		out: { type: "string" },
		recover: { type: "boolean" },
		"recover-radius-m": { type: "string" },
		"source-url": { type: "string" },
	},
})

const country = values.country?.toLowerCase()
const pbf = values.pbf

if (!country || !pbf) {
	throw new Error(
		"required: --country <cc> --pbf <path.osm.pbf> --created-at <ISO-8601> --build-sha <git-sha> " +
			"[--slug <slug>] [--release <tag>] [--out <path>] [--source-url <url, when the extract has no receipt>]"
	)
}

if (!(await pathExists(pbf))) throw new Error(`PBF not found: ${pbf}`)
// Throws for an unsupported country, so the build fails loud and never keys with the wrong normalizer.
streetLocaleForCountry(country)

const slug = values.slug?.toLowerCase() || country
const release = values.release || "unknown"
const createdAt = values["created-at"]
const buildSHA = values["build-sha"]

if (!createdAt || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
	throw new Error("required: --created-at <ISO-8601 timestamp>; the builder never invents provenance time")
}

if (!buildSHA) throw new Error("required: --build-sha <git-sha>")

const output = resolvePath(values.out || osmDatabasePath(`address-points-${country}-${slug}.db`))
const recover = Boolean(values.recover)
const recoverRadiusKm = Number(values["recover-radius-m"] ?? "30") / 1000

for (const line of osmLicenseNotice(output)) {
	console.error(`[osm] ${line}`)
}

// Hashed before the build starts, so a file that changed since its receipt stops the build
// before it spends an hour on bytes the manifest would misidentify.
const provenance = await readExtractProvenance(pbf, { sourceURL: values["source-url"] })

console.error(`[osm] extract ${provenance.sourceURL} sha256 ${provenance.sourceSHA256}`)

const counts = await buildRooftopDatabase({
	country,
	slug,
	pbf,
	release,
	createdAt,
	buildSHA,
	buildCmd: scriptBuildCommand(import.meta.url),
	output,
	provenance,
	recover,
	recoverRadiusKm,
	log: (line) => console.error(`[osm] ${line}`),
})

const gap = counts.total > 0 ? ((counts.noStreet / counts.total) * 100).toFixed(1) : "0.0"

console.error(
	`[osm] DONE ${output}\n` +
		`      total addr:housenumber features : ${counts.total.toLocaleString()}\n` +
		`      written total                    : ${counts.written.toLocaleString()}  (of which recovered: ${counts.recovered.toLocaleString()})\n` +
		`      bilingual streets (one row per form): ${counts.bilingual.toLocaleString()}\n` +
		`      skipped (no addr:street)         : ${counts.noStreet.toLocaleString()}  (${gap}% raw association gap)\n` +
		`      skipped (bad coord)              : ${counts.badCoord.toLocaleString()}\n` +
		`      source                           : openstreetmap:${country}  release=${release}  recover=${recover}`
)

for (const line of osmLicenseNotice(output)) {
	console.error(`[osm] ${line}`)
}
