/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Lists the OpenAddresses runs a US address-layer version admits and caches but takes zero records from.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/us/address-coverage/empty-runs.run.ts --plan <plan.json>
 *   --layer-version <version> [--out <runs.json>]
 *
 *   A run's records are the count its region's `ATTRIBUTION.json` states for `openaddresses:<member>`, and a run absent
 *   from it contributed zero. The anonymous results endpoint can serve a run whose rows hold positions without
 *   addresses, as `us/nh/statewide`'s 2021 run did. Each run listed is a candidate for
 *   `mailwoman corpus fetch openaddresses --sources <member>`, whose batch job the build then reads instead.
 */

import { currentSourcePath, dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { isAdmittedSource } from "@mailwoman/corpus/address-records/admission"
import { cachedRun, type OpenAddressesPlanEntry } from "@mailwoman/corpus/us/address-records/layer"
import {
	addressLayerManifestPath,
	type AddressLayerCountryManifest,
} from "@mailwoman/resolver-wof-sqlite/address/keys/layout"
import { dirname, resolvePath } from "path-ts"

const { values } = parseArguments({
	options: { plan: { type: "string" }, "layer-version": { type: "string" }, out: { type: "string" } },
})

if (!values.plan || !values["layer-version"]) throw new Error("--plan and --layer-version are required")

const root = dataRootPath("db")
const cache = currentSourcePath("openaddresses")

const manifest = await readLocalJSONFile<AddressLayerCountryManifest>(
	addressLayerManifestPath(root, "US", values["layer-version"])
)

const plan = await readLocalJSONFile<OpenAddressesPlanEntry[]>(values.plan)

/**
 * Records per source id, by region, from each region's `ATTRIBUTION.json`.
 */
const recordsByRegion = new Map<string, Map<string, number>>()

for (const region of manifest.regions) {
	const attribution = resolvePath(root, dirname(region.lookup.path), "ATTRIBUTION.json")

	if (!(await pathExists(attribution))) throw new Error(`${region.region} has no ${attribution}`)

	const entries = await readLocalJSONFile<Array<{ source: string; records: number }>>(attribution)

	recordsByRegion.set(region.region, new Map(entries.map((entry) => [entry.source, entry.records])))
}

const empty: Array<{ member: string; region: string; cached: "geojson" | "zip" }> = []
let checked = 0

for (const { member, license, skip } of plan) {
	const [country, state] = member.split("/")

	if (country !== "us" || !state || skip || !isAdmittedSource(member, license)) continue

	const region = `us-${state}`
	const records = recordsByRegion.get(region)
	const cached = await cachedRun(cache, member)

	if (!records || !cached) continue

	checked++

	if (!records.get(`openaddresses:${member}`)) {
		empty.push({ member, region, cached: cached.geojson ? "geojson" : "zip" })
	}
}

console.log(`${checked} admitted, cached runs in ${values["layer-version"]}; ${empty.length} contributed zero records`)

for (const run of empty) {
	console.log(`  ${run.member}\t${run.cached}`)
}

if (values.out) {
	await writeLocalJSONFile(empty, values.out)
}
