/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   THE END-TO-END RECEIPT for the ROAD_TO_V9 §4 intent vocabulary: run real queries through the
 *   real geocode cascade, print the answer AND the markers side by side.
 *
 *   The unit tests pin the rules and the invariance receipt pins the 306-row corpus, but neither can
 *   answer the question that decides whether `declared_ambiguity` is worth shipping: on live
 *   gazetteer data, does the 0.5-log10 cut separate the names that need a warning from the ones that
 *   do not? That is a property of the candidate table's populations, not of any code in this repo,
 *   so it needs the ~9 GB shard set and cannot live in CI.
 *
 *   Reads `$MAILWOMAN_DATA_ROOT` read-only. Needs the dev weights linked
 *   (`node neural-weights-en-us/scripts/link-dev-weights.ts`, after `yarn compile`).
 *
 *   Usage:
 *
 *   ```bash
 *   node mailwoman/dev-tools/probe-query-intent.run.ts            # the built-in board
 *   node mailwoman/dev-tools/probe-query-intent.run.ts Richmond Cambridge   # ad-hoc queries
 *   ```
 *
 *   Measured 2026-08-06 on the shipped candidate backend, 21 bare toponyms + 3 controls:
 *
 *   | query      | top-2 margin | marker              |
 *   | ---------- | -----------: | ------------------- |
 *   | Cambridge  |        0.048 | declared_ambiguity  |
 *   | Richmond   |        0.063 | declared_ambiguity  |
 *   | Lebanon    |        0.261 | declared_ambiguity  |
 *   | Athens     |        0.381 | declared_ambiguity  |
 *   | Wellington |        0.543 | —                   |
 *   | Preston    |        0.635 | —                   |
 *   | Columbus   |        0.662 | —                   |
 *   | Bristol    |        0.885 | —                   |
 *   | Stanley    |        0.914 | —                   |
 *   | Dublin     |        0.930 | —                   |
 *   | Portland   |        0.984 | —                   |
 *   | Santiago   |        1.611 | —                   |
 *   | Paris      |        1.943 | —                   |
 *   | Bordeaux   |        3.295 | —                   |
 *
 *   Two things to read out of that table. The cut lands where the doctrine wants it: Cambridge
 *   (MA/UK/ON, three cities within 0.07 of each other) and Richmond (VA/BC/CA) are declared, and
 *   every capital-city query stays silent. And **Paris reads 1.94, not 0.01**, which is the
 *   coincident-collapse working — without it the `locality`/`localadmin` twin sits 0.3 km away with a
 *   0.01 margin and every major city on earth reads maximally ambiguous.
 *
 *   The gap this probe also exposes, and it is NOT a §4 defect: several famously-ambiguous names
 *   (`Springfield`, `Berlin`, `Manchester`, `Moscow`) come back from the GEOCODE path with a single
 *   candidate, where a direct `resolveTree` on the same bare-locality tree returns four. No
 *   alternatives means no margin to measure, so the marker cannot fire for them. Whatever prunes that
 *   list lives upstream of the intent vocabulary and is worth its own look.
 */

import { parseArgs } from "node:util"

import { buildGauntletDeps } from "../eval-harness/gauntlet/harness.ts"

/**
 * The default board: the hard-slice `bare_namesake` + `fst_out_of_reach` surfaces (the populations ROAD_TO_V9 §3
 * assembled for exactly this register), plus the three controls a reader needs to trust the rest — a full address, a
 * lowercase full address, and a route pair.
 */
const DEFAULT_BOARD = [
	"Springfield",
	"Portland",
	"Paris",
	"Bordeaux",
	"Richmond",
	"Cambridge",
	"Athens",
	"Lebanon",
	"Preston",
	"Columbus",
	"Bristol",
	"Dublin",
	"Wellington",
	"Santiago",
	"Stanley",
	"Hamilton",
	"Moscow",
	"Berlin",
	"Manchester",
	"Fulda",
	"Trier",
	// Controls — these must stay inert.
	"350 5th Ave, New York, NY 10118",
	"350 5th ave, new york, ny 10118",
	"12 rue de Rome, 75008 Paris",
	// The other three intent kinds, for the marker shapes.
	"Paris London",
	"gas station near me",
]

const { positionals } = parseArgs({ allowPositionals: true })
const board = positionals.length ? positionals : DEFAULT_BOARD
const deps = await buildGauntletDeps()

console.log(["query", "lat", "lon", "tier", "candidates", "markers", "evidence"].join("\t"))

for (const query of board) {
	const result = await deps.geocode(query)

	console.log(
		[
			query,
			result.lat ?? "-",
			result.lon ?? "-",
			result.resolution_tier,
			result.candidates.length,
			result.intent_markers.map((m) => m.code).join(",") || "-",
			result.intent_markers.length ? JSON.stringify(result.intent_markers[0]!.evidence ?? {}) : "-",
		].join("\t")
	)
}

deps.close()
