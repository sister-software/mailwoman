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

import { createHash } from "node:crypto"
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

/**
 * The polyline cuts, deduplicated by CONTENT.
 *
 * Two filters, each written against a failure that actually happened on 2026-08-07:
 *
 * - A zero-byte `.0sv` is a cut that failed partway (or is still being written); treat it as absent rather than importing
 *   nothing under a name that claims coverage.
 * - The ten country PBFs were cut TWICE under two naming schemes — `cut-polylines.sh` named its output by ISO-2 code
 *   (`de.0sv`), the later `cut-polylines-remaining.sh` names it after the PBF basename (`germany.0sv`). Byte-identical,
 *   and this list is what the polylines importer streams into Elasticsearch, so shipping both would have doubled every
 *   street row for ten of the twelve countries and doubled `street.db` under interpolation. The duplicates were deleted
 *   on disk (the slug name wins — it is the rule the US state cuts already follow), but a re-run of either cutter
 *   recreates them, so the guard belongs HERE where the list is consumed, not only in the cutter.
 *
 * Dedupe is by size-then-hash: size buckets are cheap and a collision inside a bucket is rare enough that the sha256
 * only runs on real candidates. Measured on the 19-file set: 1 hash pair, 0 ms of consequence.
 */
function polylineCuts(): string[] {
	const directory = join(RIG_DATA, "polylines")
	const nonEmpty = listByExtension(directory, ".0sv").filter((file) => statSync(join(directory, file)).size > 0)

	const bySize = new Map<number, string[]>()

	for (const file of nonEmpty) {
		const size = statSync(join(directory, file)).size

		bySize.set(size, [...(bySize.get(size) ?? []), file])
	}

	const seenDigests = new Set<string>()
	const kept: string[] = []

	for (const file of nonEmpty) {
		const size = statSync(join(directory, file)).size

		// Unique size means unique content — no need to read 100 MB to prove it.
		if (bySize.get(size)!.length === 1) {
			kept.push(file)

			continue
		}

		const digest = createHash("sha256")
			.update(readFileSync(join(directory, file)))
			.digest("hex")

		if (seenDigests.has(digest)) {
			process.stderr.write(`duplicate polyline cut skipped: ${file} (sha256 ${digest.slice(0, 12)})\n`)

			continue
		}

		seenDigests.add(digest)
		kept.push(file)
	}

	return kept
}

const polylineFiles = polylineCuts()

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
