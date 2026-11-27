// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Builds `<data root>/db/poi/landmarks.db` from the fetched Wikidata vital-places inventory.
 *
 *   Usage: node packages/mailwoman/tools/dev-tools/landmarks/build.run.ts
 *   [--source-root <fetch root>] [--out <path>]
 *
 *   `--source-root` is the `--out-root` `mailwoman corpus fetch wikidata-vital-places`
 *   wrote under, by default the current-source root `$MAILWOMAN_CACHE_ROOT/sources/`.
 */

import { currentSourcesRoot, dataRootPath, wofReposPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { createWikidataClient } from "@mailwoman/corpus/tools/fetch/wikidata/subvenue"
import { VITAL_PLACES_FILES, vitalPlacesPath } from "@mailwoman/corpus/tools/fetch/wikidata/vital-places"
import type { ClassRoots } from "@mailwoman/corpus/tools/fetch/wikidata/vital-places/classify"
import type { VitalPlace } from "@mailwoman/corpus/tools/fetch/wikidata/vital-places/inventory"
import { resolveWOFRepo } from "@mailwoman/gazetteer/whosonfirst/extract-repo"
import { OUTCOMES_REPO } from "@mailwoman/gazetteer/whosonfirst/outcomes/definition"
import { readPinnedOutcomeSpec } from "@mailwoman/gazetteer/whosonfirst/outcomes/read"
import { poiDatabaseRoot } from "@mailwoman/resolver-wof-sqlite/paths"
import { PathBuilder, resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

import { LANDMARK_DATABASE_FILE } from "#geocode/session/layers"
import { AIRPORT_CODES_QUERY, type AirportCode, readAirportCodes } from "#tools/dev-tools/landmarks/airport-codes"
import { buildLandmarkDatabase } from "#tools/dev-tools/landmarks/build"

const { values } = parseArguments({
	options: {
		"source-root": { type: "string" },
		out: { type: "string" },
		"fetch-airports": { type: "boolean" },
	},
})

const AIRPORT_CODES_FILE = "airport-codes.json"

const sourceDir = vitalPlacesPath(
	PathBuilder.from(values["source-root"] ? resolvePath(values["source-root"]) : currentSourcesRoot())
)

const roots = await readLocalJSONFile<ClassRoots>(sourceDir(VITAL_PLACES_FILES.classRoots))
const places = await JSONSpliterator.fromAsync<VitalPlace>(sourceDir(VITAL_PLACES_FILES.places)).toArray()
const out = values.out ? resolvePath(values.out) : poiDatabaseRoot(dataRootPath())(LANDMARK_DATABASE_FILE)

// The answer lands beside the inventory, so a rebuild reads the same codes until someone refreshes them.
const airportsPath = sourceDir(AIRPORT_CODES_FILE)

if (values["fetch-airports"] || !(await pathExists(airportsPath))) {
	await using client = createWikidataClient({ cacheDir: sourceDir(VITAL_PLACES_FILES.httpCache) })

	await writeLocalJSONFile(readAirportCodes(await client.query(AIRPORT_CODES_QUERY)), airportsPath)
}

const airports = await readLocalJSONFile<AirportCode[]>(airportsPath)

// The outcome tables come from the definitions clone's committed spec.
// A host without the clone builds without them.
const outcomesRepo = await resolveWOFRepo(wofReposPath(), OUTCOMES_REPO.name)
const outcomes = outcomesRepo ? readPinnedOutcomeSpec(outcomesRepo) : null

if (!outcomes) {
	console.error(
		`${OUTCOMES_REPO.name} isn't cloned under ${wofReposPath().toString()}; the database gets no outcome tables`
	)
}

const counts = await buildLandmarkDatabase(places, roots, out, airports, outcomes)

console.log(
	`wrote ${out.toString()}: ${counts.places} places, ${counts.rows} name rows` +
		(outcomes ? `, ${counts.outcomeRows} outcome rows at ${outcomes.pin.revision}` : "")
)
