/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Freezes an evaluation set of addresses that end in their country, with the Who's On First
 *   `<locality>, <country>` chains of the same countries.
 *
 *   Usage:
 *   node packages/mailwoman/tools/eval-harness/heldout/dataset/trailing/country.run.ts \
 *     --countries AL,AM,AE,BF,CI,CR,EC --wof-manifest <corpus MANIFEST.json> --dataset-id <id> --out <dataset .json> \
 *     [--osm-dir /mnt/mw/db/osm/corpus] [--per-country 300] [--unseen <provenance .json>]
 *
 *   Address rows come from each country's OSM extract (`osm-<cc>-<date>.corpus.jsonl`, the newest) through the OSM
 *   adapter, rendered with the country's name last (`trailing-country.ts`). The country's name is the spelling with the
 *   highest count among its Who's On First test rows. Chains come from the Who's On First admin test rows of `--wof-manifest`.
 *
 *   An address extract holds rows a training corpus also holds. Freeze once with a large `--per-country`, audit the
 *   result with `overlap.run.ts`, then freeze again with `--unseen <that provenance file>`. The second pass draws each
 *   country's quota from the rows the audit classed `verified_unseen`. A country with no extract is listed and
 *   skipped, and the manifest's `drawnFrom.files` names every extract read.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { sha256File } from "@mailwoman/core/hash"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { osmAdapter } from "@mailwoman/corpus/adapters/osm/adapter"
import { baseManifestFiles } from "@mailwoman/corpus/tools/overlay/manifest"
import { Globerator } from "spliterator/node/fs"

import { writeHeldoutDataset } from "#tools/eval-harness/heldout/dataset/manifest"
import {
	commonCountryName,
	endsInLocalityCountry,
	firstByTextHash,
	trailingCountryRow,
} from "#tools/eval-harness/heldout/dataset/trailing/country"
import {
	type HeldoutCellCount,
	type HeldoutRow,
	heldoutRowID,
	type ProvenanceRecord,
	sampleHeldoutRows,
} from "#tools/eval-harness/heldout/per/country"

const { values } = parseArguments({
	options: {
		countries: { type: "string", description: "ISO 3166-1 alpha-2 codes, comma-separated" },
		"osm-dir": { type: "string", default: "/mnt/mw/db/osm/corpus", description: "Where the OSM extracts sit" },
		"wof-manifest": { type: "string", description: "The corpus MANIFEST.json whose wof-admin test rows to read" },
		"path-root": { type: "string", default: "/mnt/mw", description: "Local directory for the manifest's /data prefix" },
		"per-country": { type: "string", default: "300", description: "Rows kept per country and row kind" },
		unseen: { type: "string", description: "An overlap audit's provenance file; keep only verified_unseen rows" },
		"dataset-id": { type: "string", description: "The dataset's name" },
		out: { type: "string", description: "Where to write the dataset manifest" },
	},
})

if (!values.countries || !values["wof-manifest"] || !values["dataset-id"] || !values.out) {
	throw new Error("--countries, --wof-manifest, --dataset-id and --out are required")
}

const countries = values.countries.split(",").map((cc) => cc.trim().toUpperCase())
const perCountry = Number(values["per-country"])

const unseen = values.unseen
	? new Map(Object.entries((await readLocalJSONFile<{ rows: Record<string, ProvenanceRecord> }>(values.unseen)).rows))
	: null

const keep = (row: HeldoutRow) => !unseen || unseen.get(heldoutRowID(row))?.provenance === "verified_unseen"

const manifest = await readLocalJSONFile<Record<string, unknown>>(values["wof-manifest"])
const wofFiles = baseManifestFiles<{ path: string; source?: string }>(manifest)

const wof = await sampleHeldoutRows(
	values["wof-manifest"],
	1_000_000,
	values["path-root"],
	null,
	{},
	null,
	wofFiles.filter((file) => file.source !== "wof-admin").map((file) => file.path)
)

const rows: HeldoutRow[] = []
const cells: HeldoutCellCount[] = []
const extracts: string[] = []

for (const country of countries) {
	const chains = wof.rows.filter((row) => row.country === country)
	const countryName = commonCountryName(chains)
	const localityChains = chains.filter((row) => endsInLocalityCountry(row) && keep(row))

	const extract = (
		await Globerator.from(`osm-${country.toLowerCase()}-*.corpus.jsonl`, {
			cwd: values["osm-dir"],
			absolute: true,
		}).toArray()
	)
		.toSorted()
		.at(-1)

	const addresses: HeldoutRow[] = []

	if (!extract) {
		console.error(`${country}: no OSM extract in ${values["osm-dir"]}, address rows skipped`)
	} else if (!countryName) {
		console.error(`${country}: no Who's On First test row names the country, address rows skipped`)
	} else {
		extracts.push(extract)

		for await (const canonical of osmAdapter.rows({ inputPath: extract, country })) {
			if (!canonical.components.locality) continue

			const row = trailingCountryRow({
				components: canonical.components,
				country,
				countryName,
				source: `osm-${country.toLowerCase()}`,
				sourceID: canonical.source_id!,
			})

			if (row && keep(row)) {
				addresses.push(row)
			}
		}
	}

	const keptAddresses = firstByTextHash(addresses, perCountry)
	const keptChains = firstByTextHash(localityChains, perCountry)

	rows.push(...keptAddresses, ...keptChains)

	cells.push(
		{ country, kind: "address", available: addresses.length, sampled: keptAddresses.length },
		{ country, kind: "gazetteer", available: localityChains.length, sampled: keptChains.length }
	)

	console.error(
		`${country} (${countryName ?? "unnamed"}): ${keptAddresses.length} of ${addresses.length} address rows, ` +
			`${keptChains.length} of ${localityChains.length} <locality>, <country> chains`
	)
}

const written = await writeHeldoutDataset(values.out, {
	datasetID: values["dataset-id"],
	createdAt: new Date().toISOString(),
	drawnFrom: {
		manifest: values["wof-manifest"],
		sha256: await sha256File(values["wof-manifest"]),
		corpusVersion: typeof manifest["corpus_version"] === "string" ? manifest["corpus_version"] : null,
		files: [...extracts, ...wof.files],
	},
	sampling: {
		method: "per-group-text-hash-order",
		perCountry,
		seed: null,
		order:
			"sha256(raw), one row per group; OSM extract rows rendered with a trailing country, " +
			`Who's On First <locality>, <country> test chains${unseen ? `; verified_unseen in ${values.unseen}` : ""}`,
		engine: "trailing-country.run.ts",
	},
	cells,
	rows,
})

console.log(
	`${written.datasetID} version ${written.version}: ${written.rows.length} rows, sha256 ${written.rowsFile.sha256}`
)
