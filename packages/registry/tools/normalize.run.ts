// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes `data/normalized/iso3166-1.json`, `data/normalized/iata-airports.json` and
 *   `data/manifests/coverage.json` from the pinned sources.
 *
 *   Usage: `node packages/registry/tools/normalize.run.ts`
 *
 *   The run refuses a source file whose digest differs from `data/manifests/sources.lock.json`.
 */

import { writeLocalFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { workspacePathBuilder } from "@mailwoman/core/paths"

import { readSourceLock } from "#sdk/fetch"
import { formatNormalized, normalizeFromLock } from "#tools/normalize"

const lock = await readSourceLock()

if (!lock) throw new Error("no sources.lock.json; run packages/registry/sdk/fetch.run.ts --repin first")

const { countries, airports, coverage } = await normalizeFromLock(lock)
const data = workspacePathBuilder("registry", "data")

await writeLocalFile(formatNormalized(countries), data("normalized", "iso3166-1.json"))
await writeLocalFile(formatNormalized(airports), data("normalized", "iata-airports.json"))
await writeLocalJSONFile(coverage, data("manifests", "coverage.json"))

console.log(
	`countries: ${countries.records.length} (${stringifyJSON(coverage.namespaces["iso3166-1-alpha2"]!.statuses)})`
)
console.log(`airports: ${airports.records.length} (${stringifyJSON(coverage.namespaces["iata-location"]!.statuses)})`)
console.log(`country lists: ${coverage.namespaces["$countryListComparison"]!.kinds!.join("; ")}`)
