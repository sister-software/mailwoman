/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_sources` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The census itself lives in `../source-census.ts`; this file is the CONTRACT.
 */

import { z } from "zod"

import { censusArtifact, gazetteerArtifacts, type SourceCensusRow } from "#source-census"
import type { DevTool, DevToolDeps } from "#tool-kit"

/**
 * Render one row as a line a reader can act on without re-querying.
 */
function line(row: SourceCensusRow, countries?: readonly string[]): string {
	const mb = `${(row.bytes / 1e6).toFixed(1)} MB`

	if (!row.readable) return `${row.artifact} (${mb}) — UNUSABLE: ${row.reason}`

	const counts = Object.entries(row.countries ?? {})
		.filter(([, n]) => n > 0 || countries !== undefined)
		.toSorted((a, b) => b[1] - a[1])

	const shown = countries ? counts : counts.slice(0, 8)
	const rendered = shown.map(([code, n]) => `${code}=${n}`).join(" ") || "no country rows"
	const more = !countries && counts.length > shown.length ? ` (+${counts.length - shown.length} more countries)` : ""
	const joins = row.join.length ? row.join.join("+") : "NONE"

	return `${row.artifact} (${mb}, join:${joins}, parent_id linked: ${row.parentLinked ? "yes" : "NO"}) ${rendered}${more}`
}

export const sourcesTool = async (_deps: DevToolDeps): Promise<DevTool> => ({
	name: "mwdev_sources",
	description:
		"What gazetteer data we HOLD, per country, per artifact — the question that comes before `mwdev_lookup`'s " +
		"'does this source know this string'. Answers whether a country has rows at all, in which file, and whether " +
		"that file can be JOINED to anything, which is what decides if a corpus builder can extract from it. A row " +
		"count alone is a misleading yes: `postalcode-geonames-intl.db` holds 395,544 PT postcodes and is `spr`-only, " +
		"while `postalcode-intl.db` holds 27,119 FR WITH the ancestry tables. Reports absence explicitly — a country " +
		"asked for and not found gets a zero, because 'the query returned nothing' and 'we never looked there' are " +
		"different facts. Start every locale expansion here.",
	inputSchema: z.object({
		countries: z
			.array(z.string().length(2))
			.min(1)
			.max(40)
			.optional()
			.describe(
				"ISO alpha-2 codes to report on, absences included. Omit to see each artifact's top countries instead, " +
					"which is the shape for 'what do we have at all' rather than 'do we have X'."
			),
		artifact: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Substring filter on the artifact filename — e.g. `postalcode` for the postcode family. Omit to census " +
					"every gazetteer shard under the data root."
			),
	}),
	handler: async (args) => {
		const countries = (args["countries"] as string[] | undefined)?.map((code) => code.toUpperCase())
		const filter = args["artifact"] as string | undefined

		const paths = (await gazetteerArtifacts()).filter((path) => (filter ? path.includes(filter) : true))

		if (!paths.length) {
			return {
				n_artifacts: 0,
				rows: [],
				summary: filter
					? `No gazetteer artifact under the data root matches ${JSON.stringify(filter)}. That is an ABSENCE of files, not of data — check the filter before concluding anything about coverage.`
					: "No gazetteer artifacts found under the data root at all. The data root is probably not what you think it is.",
			}
		}

		const rows = await Promise.all(paths.map(async (path) => await censusArtifact(path, countries)))
		const usable = rows.filter((row) => row.readable)

		// Per COUNTRY across artifacts, so "where is VE data" is one read rather than a scan of every row.
		const byCountry: Record<string, Array<{ artifact: string; n: number; join: string[] }>> = {}

		for (const row of usable) {
			for (const [code, n] of Object.entries(row.countries ?? {})) {
				if (n <= 0) continue

				byCountry[code] ??= []
				byCountry[code]!.push({ artifact: row.artifact, n, join: row.join })
			}
		}

		const asked = countries ?? []
		const missing = asked.filter((code) => !byCountry[code]?.length)

		// When the caller named countries, an artifact holding NONE of them is noise — 29 lines of zeros buries the
		// two that matter. The absence is still reported, in `summary` and by a country's empty `by_country` entry;
		// what is dropped is the per-artifact restatement of it.
		const relevant = countries
			? rows.filter((row) => !row.readable || Object.values(row.countries ?? {}).some((n) => n > 0))
			: rows

		const silent = rows.length - relevant.length

		return {
			n_artifacts: rows.length,
			n_unusable: rows.length - usable.length,
			rows,
			by_country: byCountry,
			rendered: relevant.map((row) => line(row, countries)),
			...(silent > 0 ? { artifacts_with_none_of_the_requested_countries: silent } : {}),
			summary:
				`${rows.length} artifact(s) censused, ${rows.length - usable.length} unusable` +
				(silent > 0 ? `, ${silent} holding none of the requested countries (not rendered)` : "") +
				". " +
				(asked.length
					? missing.length
						? `NO DATA ON DISK for ${missing.join(", ")} — that is an acquisition task, not a build task. `
						: `Every requested country has rows somewhere. `
					: "") +
				"A country with rows in an artifact whose `join` is NONE can be counted but not joined to a locality or " +
				"region, so it cannot yield a (postcode, locality, region) triple without a spatial join. And an " +
				"artifact reporting `parent_id linked: NO` cannot be walked upward at all.",
			notes: [
				"`join` reports which tables EXIST, not that the chain reaches a locality. Measured on postalcode-intl.db: " +
					"the ancestry chain for FR `75002` is a single SELF-reference at placetype `postalcode`, so `ancestry` " +
					"present is necessary and not sufficient.",
				"`.prev`, `.bak` and journal siblings are excluded — they are on disk on purpose and would report the same " +
					"country twice under a name nobody can act on.",
				"Counts are `spr` rows, which for a postcode shard is postcodes and for an admin shard is places. Compare " +
					"across artifacts of the same family, never across families.",
			],
		}
	},
})
