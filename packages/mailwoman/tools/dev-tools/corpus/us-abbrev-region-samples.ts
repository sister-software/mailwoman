/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Regenerates the committed `corpus/us/abbrev-region-samples.ts` table from the Who's On First admin and US
 *   postcode databases: for each US state whose code is also another country's code, the most populous current
 *   localities under the state's region record and, for each, the postcode nearest its point among those whose
 *   parent is that locality.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { US_STATE_CODES_READ_AS_COUNTRIES } from "@mailwoman/corpus/us/state-country-codes"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

/**
 * Resolves the committed table from the `@mailwoman/corpus` package root, so the path
 * is the same from the source tree, `out/` and a published tarball.
 */
const DEFAULT_OUT = resolvePackagePath("@mailwoman/corpus", "lib", "us", "abbrev-region-samples.ts")

/**
 * The count of localities per state, each with its own postcode.
 */
const LOCALITIES_PER_STATE = 3

/**
 * The count of localities read per state before the ones without a postcode are dropped.
 */
const LOCALITY_CANDIDATES = 12

/**
 * Configures {@linkcode generateUSAbbrevRegionSamples}.
 */
export interface GenerateUSAbbrevRegionSamplesOptions {
	/**
	 * Overrides the output path.
	 *
	 * @defaultValue the committed `corpus/us/abbrev-region-samples.ts`.
	 */
	out?: string
	/**
	 * The Who's On First admin database.
	 *
	 * @defaultValue `admin-global-priority.db` under the data root's `db/wof/`.
	 */
	adminDB?: PathBuilderLike
	/**
	 * The Who's On First US postcode database.
	 *
	 * @defaultValue `postalcode-us.db` under the data root's `db/wof/`.
	 */
	postcodeDB?: PathBuilderLike
}

/**
 * Summarizes a {@linkcode generateUSAbbrevRegionSamples} run.
 */
export interface GenerateUSAbbrevRegionSamplesSummary {
	states: number
	outPath: string
}

interface StateSamples {
	localities: string[]
	postcodes: string[]
}

/**
 * Reads the samples for one state: its most populous current localities that hold a postcode.
 *
 * @throws When fewer than `LOCALITIES_PER_STATE` localities with a postcode are found,
 * so the table is never written with a thin state.
 */
async function readStateSamples(
	admin: DatabaseClient<WOFDatabase>,
	postal: DatabaseClient<WOFDatabase>,
	code: string,
	regionID: number
): Promise<StateSamples> {
	const localities = await admin
		.selectFrom("spr")
		.innerJoin("ancestors", "ancestors.id", "spr.id")
		.leftJoin("place_population", "place_population.id", "spr.id")
		.select(["spr.id as id", "spr.name as name", "spr.latitude as latitude", "spr.longitude as longitude"])
		.where("spr.placetype", "=", "locality")
		.where("spr.country", "=", "US")
		.where("spr.is_current", "=", 1)
		.where("ancestors.ancestor_id", "=", regionID)
		.where("ancestors.ancestor_placetype", "=", "region")
		.orderBy("place_population.population", "desc")
		.limit(LOCALITY_CANDIDATES)
		.execute()

	const samples: StateSamples = { localities: [], postcodes: [] }

	for (const locality of localities) {
		if (samples.localities.length === LOCALITIES_PER_STATE) break

		if (!locality.name) continue

		// The postcode nearest the locality's own point, so a city gets its central postcode
		// rather than the lowest-numbered one on its edge.
		const postcodes = await postal
			.selectFrom("spr")
			.select(["name", "latitude", "longitude"])
			.where("placetype", "=", "postalcode")
			.where("is_current", "=", 1)
			.where("parent_id", "=", locality.id)
			.execute()

		const nearest = postcodes
			.filter((postcode) => postcode.name)
			.map((postcode) => ({
				name: postcode.name!,
				distance: (postcode.latitude - locality.latitude) ** 2 + (postcode.longitude - locality.longitude) ** 2,
			}))
			.toSorted((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))[0]

		if (!nearest) continue

		samples.localities.push(locality.name)
		samples.postcodes.push(nearest.name)
	}

	if (samples.localities.length < LOCALITIES_PER_STATE) {
		throw new Error(
			`${code}: ${samples.localities.length} of ${LOCALITIES_PER_STATE} localities with a postcode among the ` +
				`${localities.length} most populous — the postcode database does not cover this state's localities`
		)
	}

	return samples
}

/**
 * Regenerates the committed `US_ABBREV_REGION_SAMPLES` table.
 *
 * The states are the codex-computed `US_STATE_CODES_READ_AS_COUNTRIES`, so a state the codex
 * tables add or remove changes the table on the next run rather than through a second edit.
 *
 * @throws When a state has no region record with its abbreviation in the admin database,
 * or too few localities with a postcode.
 */
export async function generateUSAbbrevRegionSamples(
	options: GenerateUSAbbrevRegionSamplesOptions = {},
	report?: (line: string) => void
): Promise<GenerateUSAbbrevRegionSamplesSummary> {
	const outPath = options.out ?? DEFAULT_OUT

	using admin = new DatabaseClient<WOFDatabase>(options.adminDB ?? wofDatabasePath("admin-global-priority.db"), {
		readOnly: true,
	})

	using postal = new DatabaseClient<WOFDatabase>(options.postcodeDB ?? wofDatabasePath("postalcode-us.db"), {
		readOnly: true,
	})

	const regions = await admin
		.selectFrom("spr")
		.innerJoin("place_abbr", "place_abbr.id", "spr.id")
		.select(["spr.id as id", "place_abbr.abbr as abbr"])
		.where("spr.placetype", "=", "region")
		.where("spr.country", "=", "US")
		.where("spr.is_current", "=", 1)
		.execute()

	const regionByCode = new Map(regions.map((region) => [region.abbr.toUpperCase(), region.id]))
	const lines: string[] = []

	for (const code of [...US_STATE_CODES_READ_AS_COUNTRIES].toSorted()) {
		const regionID = regionByCode.get(code)

		if (regionID == null) {
			throw new Error(`${code}: no current US region has this abbreviation in the admin database`)
		}

		const samples = await readStateSamples(admin, postal, code, regionID)
		const localities = samples.localities.map((name) => stringifyJSON(name)).join(", ")
		const postcodes = samples.postcodes.map((name) => stringifyJSON(name)).join(", ")

		lines.push(`\t${code}: { localities: [${localities}], postcodes: [${postcodes}] },`)
		report?.(`${code}: ${samples.localities.join(", ")}`)
	}

	const header = `/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   generated — do not edit by hand. Sample localities and postcodes for each US state whose code is also
 *   another country's ISO 3166-1 alpha-2 code: the three most populous current localities under the state's
 *   region record in Who's On First's admin database, each with the postcode nearest its point among those
 *   whose parent is that locality in the US postcode database. The states are the codex-computed
 *   US_STATE_CODES_READ_AS_COUNTRIES.
 *   Regenerate with: mailwoman dev generate corpus-us-abbrev-region-samples
 */

/**
 * USPS state code → the sample localities and the postcode paired with each one, index for index.
 */
export const US_ABBREV_REGION_SAMPLES: Readonly<
	Record<string, { readonly localities: readonly string[]; readonly postcodes: readonly string[] }>
> = {`

	await writeLocalTextFile(`${header}\n${lines.join("\n")}\n}\n`, outPath)
	report?.(`wrote ${outPath} (${lines.length} states)`)

	return { states: lines.length, outPath }
}
