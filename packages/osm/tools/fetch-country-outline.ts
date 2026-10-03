/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Download geoBoundaries ADM0 country outlines into `$MAILWOMAN_DATA_ROOT/db/osm/outlines`, with a receipt
 *   beside each that records the license geoBoundaries states for that country.
 *
 *   An outline decides which records of a Geofabrik extract lie inside the country (`emit-corpus-jsonl
 *   --within`). It is read and never redistributed, and each receipt keeps the per-country license
 *   because geoBoundaries states one per boundary rather than one for the collection.
 *
 *   Usage:
 *     node packages/osm/tools/fetch-country-outline.ts --iso3 RUS --iso3 CHN
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { osmDatabasePath } from "#paths"

const API = "https://www.geoboundaries.org/api/current/gbOpen"

interface GeoBoundariesRecord {
	boundaryLicense?: string
	licenseSource?: string
	boundarySource?: string
	boundaryYearRepresented?: string
	gjDownloadURL?: string
}

const { values } = parseArguments({
	options: {
		iso3: { type: "string", multiple: true },
		dir: { type: "string" },
	},
})

const codes = values.iso3 ?? []

if (!codes.length) throw new Error("usage: fetch-country-outline --iso3 <ISO3> [--iso3 …] [--dir <dir>]")

const directory = values.dir ?? osmDatabasePath("outlines").toString()

await makeDirectories(directory)

for (const iso3 of codes.map((code) => code.toUpperCase())) {
	const destination = `${directory}/${iso3}-ADM0.geojson`

	if (await pathExists(destination)) {
		console.log(`[outline] ${destination} present; skipped`)

		continue
	}

	const metaURL = `${API}/${iso3}/ADM0/`
	const meta = await fetch(metaURL)

	if (!meta.ok) throw new Error(`geoBoundaries metadata failed (${meta.status}) for ${iso3}`)

	const record = (await meta.json()) as GeoBoundariesRecord

	if (!record.gjDownloadURL) throw new Error(`geoBoundaries names no GeoJSON for ${iso3}`)

	const body = await fetch(record.gjDownloadURL)

	if (!body.ok) throw new Error(`geoBoundaries download failed (${body.status}) for ${record.gjDownloadURL}`)

	const text = await body.text()

	if (!text.trimStart().startsWith("{")) {
		throw new Error(`${record.gjDownloadURL} did not return GeoJSON (a Git LFS pointer reads as text)`)
	}

	await writeLocalTextFile(text, destination)

	await writeLocalJSONFile(
		{
			iso3,
			metadata_url: metaURL,
			source_url: record.gjDownloadURL,
			license: record.boundaryLicense ?? null,
			license_source: record.licenseSource ?? null,
			boundary_source: record.boundarySource ?? null,
			year_represented: record.boundaryYearRepresented ?? null,
			retrieved_at: new Date().toISOString(),
			bytes: Buffer.byteLength(text),
			sha256: sha256Hex(text),
		},
		`${destination}.receipt.json`
	)

	console.log(`[outline] ${iso3}: ${Buffer.byteLength(text)} bytes, ${record.boundaryLicense}`)
}
