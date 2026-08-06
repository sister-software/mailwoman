/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generate `pelias.json` for the scoped local Pelias rig from what is actually on disk.
 *
 *   The importers key off explicit file lists, and every one of those lists is a fact about the
 *   filesystem: which OpenAddresses CSVs were extracted, which country PBFs downloaded, which
 *   polyline cuts survived (three PBFs are over the `pbf streets` size limit — see
 *   `cut-polylines.sh`), which US states the panel's point rows touch. Hand-maintaining them
 *   guarantees a stale entry, and a stale entry in `imports.openaddresses.files` is not a loud
 *   failure — the importer skips the missing file and the country silently under-imports. So this
 *   reads the disk and writes the config, and it is re-run after every fetch completes.
 *
 *   Deliberate departures from pelias/docker's per-country template:
 *
 *   - NO `pip` service in `api.services` (forward geocoding only, §1).
 *   - `imports.openstreetmap.datapath` is `/data/osm`, not `/data/openstreetmap` — the host
 *     directory predates this config and the key is what makes the two agree.
 *   - `whosonfirst.countryCode` is an ARRAY. The importer supports it (`schema.js`: "string OR
 *     array[string]"), and it is what makes one project cover twelve countries.
 *   - `imports.interpolation.download.tiger.states` is recorded even though we do NOT run that
 *     downloader (it is pinned to TIGER2021 via a geocode.earth mirror). Our TIGER 2024 county
 *     zips are mounted at `/data/tiger/downloads`, which is where `conflate_tiger.sh` globs. The
 *     block stays as the written-down statement of which states the build is scoped to.
 *
 *   Usage: node pelias-rig/project/build-config.ts
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"

const HERE = import.meta.dirname
const RIG_DATA = "/mnt/playpen/mailwoman-data/pelias-rig/data"
const OA_EXTRACTED = "/mnt/playpen/mailwoman-data/openaddresses/extracted"

/**
 * The panel's twelve countries (§1).
 */
const COUNTRY_CODES = ["US", "FR", "DE", "GB", "AU", "NZ", "AT", "CH", "CZ", "DK", "BE", "NL"]

/**
 * OpenAddresses directories to import, in ISO-2 lowercase. GB is absent on purpose: no OA-gb.
 */
const OA_COUNTRIES = ["fr", "de", "at", "be", "ch", "cz", "dk", "nl", "au", "nz"]

interface PanelManifest {
	usStatesRequiringLocalSources?: { abbreviation: string; fips: string; name: string }[]
	usStates?: { abbreviation: string; fips: string; name: string }[]
}

const manifest = parseJSONStrict<PanelManifest>(readFileSync(resolve(HERE, "../panel/panel-v1.manifest.json"), "utf8"))

const states = manifest.usStatesRequiringLocalSources ?? manifest.usStates ?? []

/**
 * Every CSV under a directory, as a path relative to the OpenAddresses datapath.
 */
function collectCSVs(relative: string): string[] {
	const root = join(OA_EXTRACTED, relative)

	if (!existsSync(root)) return []

	const out: string[] = []

	const walk = (dir: string) => {
		for (const entry of readdirSync(dir).toSorted()) {
			const full = join(dir, entry)

			if (statSync(full).isDirectory()) {
				walk(full)

				continue
			}

			if (entry.endsWith(".csv")) {
				out.push(full.slice(OA_EXTRACTED.length + 1))
			}
		}
	}

	walk(root)

	return out
}

/**
 * AU, NZ, CH, CZ, DK, NL and FR each ship a `countrywide.csv` alongside smaller region files that repeat its rows.
 * Importing both doubles the record count for no coverage gain, so where a countrywide file exists it is the ONLY file
 * taken for that country.
 */
function openaddressesFiles(): string[] {
	const files: string[] = []

	for (const cc of OA_COUNTRIES) {
		const all = collectCSVs(cc)
		const countrywide = all.filter((file) => file === `${cc}/countrywide.csv`)

		files.push(...(countrywide.length ? countrywide : all))
	}

	for (const state of states) {
		files.push(...collectCSVs(`us/${state.abbreviation.toLowerCase()}`))
	}

	return files
}

function listByExtension(directory: string, extension: string): string[] {
	if (!existsSync(directory)) return []

	return readdirSync(directory)
		.filter((entry) => entry.endsWith(extension))
		.toSorted()
}

const pbfFiles = listByExtension(join(RIG_DATA, "osm"), ".pbf")

// A zero-byte .0sv is a cut that failed partway; treat it as absent rather than importing nothing
// under a name that claims coverage.
const polylineFiles = listByExtension(join(RIG_DATA, "polylines"), ".0sv").filter(
	(file) => statSync(join(RIG_DATA, "polylines", file)).size > 0
)

const config = {
	logger: { level: "info", timestamp: false },
	esclient: { apiVersion: "7.5", hosts: [{ host: "elasticsearch" }] },
	elasticsearch: {
		settings: {
			index: { refresh_interval: "10s", number_of_replicas: "0", number_of_shards: "1" },
		},
	},
	api: {
		services: {
			libpostal: { url: "http://libpostal:4400" },
			placeholder: { url: "http://placeholder:4100" },
			interpolation: { url: "http://interpolation:4300" },
		},
	},
	imports: {
		whosonfirst: {
			datapath: "/data/whosonfirst",
			countryCode: COUNTRY_CODES,
			importPostalcodes: false,
		},
		openstreetmap: {
			leveldbpath: "/tmp",
			datapath: "/data/osm",
			import: pbfFiles.map((filename) => ({ filename })),
		},
		openaddresses: {
			datapath: "/data/openaddresses",
			files: openaddressesFiles(),
		},
		polyline: {
			datapath: "/data/polylines",
			files: polylineFiles,
		},
		interpolation: {
			download: {
				tiger: {
					datapath: "/data/tiger",
					states: states.map((state) => ({ state_code: state.fips })),
				},
			},
		},
	},
}

const outPath = resolve(HERE, "pelias.json")

writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n")

process.stdout.write(
	JSON.stringify(
		{
			wrote: outPath,
			pbfs: pbfFiles.length,
			polylines: polylineFiles,
			openaddressesFiles: config.imports.openaddresses.files.length,
			usStates: states.map((state) => state.abbreviation),
			countryCodes: COUNTRY_CODES,
		},
		null,
		2
	) + "\n"
)
