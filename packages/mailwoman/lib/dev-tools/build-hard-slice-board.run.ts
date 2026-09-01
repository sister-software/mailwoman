/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Emit `eval-harness/fixtures/hard-slice-board.jsonl` (ROAD_TO_V9 §3). The board's SELECTION is curated by
 *   hand — every row below pins one discrimination case and says why — but its NUMBERS are machine-filled
 *   from primary data, and that split is the point:
 *
 *   - **Coordinates + place names** come from the WOF admin DB by place id, so a row's truth is never a
 *       hand-typed decimal. The curator picks the ID; the builder reads the point.
 *   - **`popBias` / `impBias`** come from walking the two FST binaries themselves and collapsing the
 *       accepting entries exactly as `neural/fst-prior.ts`'s `applyBias` does (max per BIO tag, and ONLY the
 *       four placetypes `PLACETYPE_TO_BIO` maps — `localadmin`/`county`/`borough`/`neighbourhood` reach no
 *       label and contribute nothing). So the recorded delta is the bias the DECODER sees, not a proxy for it
 *       computed off the database.
 *
 *   The sweep-derived classes (`country_structure`, `fst_out_of_reach`) are lifted VERBATIM from
 *   `gauntlet/cases/<cc>/regression.jsonl` — same input, same coordinate, same tolerance — so the board and
 *   the corpus cannot drift apart on a row they share.
 *
 *   Run: node packages/mailwoman/lib/dev-tools/build-hard-slice-board.run.ts [--out <path>]
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { getRow } from "@mailwoman/core/utils"
import { collapseFSTBias } from "@mailwoman/neural/fst-prior"
import { normalizeTokens, deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { JSONSpliterator } from "spliterator"

import { FRAGMENT_ROWS } from "#dev-tools/hard-slice-rows"
import { TOPONYM_ROWS } from "#dev-tools/hard-slice-rows-toponym"
import { SWEEP_ROWS } from "#dev-tools/hard-slice-sweep-rows"
import { canonicalizeHardSliceCase, type HardSliceCase, HARD_SLICE_BOARD_PATH } from "#eval-harness/hard-slice-board"

const { values } = parseArguments({ options: { out: { type: "string" } } })
const OUT = values.out ?? HARD_SLICE_BOARD_PATH

const ADDED_AT = "2026-08-06"
const WOF_DB = String(dataRootPath("wof", "fst-staging-2026-08-05", "admin-global-priority-importance.db"))
const POP_FST_DIR = String(dataRootPath("wof", "fst-per-locale"))
const IMP_FST_DIR = String(dataRootPath("wof", "fst-staging-2026-08-05-importance-fanoutfix"))

using db = new DatabaseClient<WOFDatabase>(WOF_DB, { readOnly: true })
const pointStmt = db.prepare("SELECT name, latitude, longitude FROM spr WHERE id = ?")

interface Point {
	name: string
	latitude: number
	longitude: number
}

function pointOf(id: number): Point {
	const row = getRow<Point>(pointStmt, id)

	if (!row) throw new Error(`wof id ${id} not found in ${WOF_DB} — a curated row names a place that is not there`)

	return row
}

const matcherCache = new Map<string, { pop: unknown; imp: unknown }>()

async function matchers(locale: string): Promise<{ pop: unknown; imp: unknown }> {
	const cached = matcherCache.get(locale)

	if (cached) return cached

	const pair = {
		pop: deserializeFST(await readLocalBuffer(`${POP_FST_DIR}/fst-${locale}.bin`)),
		imp: deserializeFST(await readLocalBuffer(`${IMP_FST_DIR}/fst-${locale}.bin`)),
	}

	matcherCache.set(locale, pair)

	return pair
}

/**
 * `max(importance)` per BIO tag for `surface` — the collapse `applyBias` performs before it touches the emission
 * matrix. A surface the FST does not accept returns an empty map, which is ABSENCE (the gazetteer has nothing to say),
 * reported by the caller as a zero bias on a named tag rather than silently as 0.
 */
function biasOf(matcher: unknown, surface: string): Map<string, number> {
	const walk = (matcher as { walk(t: string[]): { stateID: number; accepted: boolean } | null }).walk(
		normalizeTokens(surface)
	)

	if (!walk?.accepted) return new Map()

	const entries = (matcher as { accepting(id: number): Array<{ placetype: string; importance: number }> }).accepting(
		walk.stateID
	)

	// Collapsed by the decoder's OWN function: a bias measured over placetypes the decoder cannot see would overstate
	// every delta on this board.
	return collapseFSTBias(entries, normalizeTokens(surface))
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4

//#region Emit

const CASES_ROOT = new URL("../eval-harness/gauntlet/cases/", import.meta.url)

async function sweepRow(cc: string, caseID: string): Promise<Record<string, unknown>> {
	const path = new URL(`${cc}/regression.jsonl`, CASES_ROOT)
	const rows = await Array.fromAsync(JSONSpliterator.fromAsync<Record<string, unknown>>(path.pathname))
	const row = rows.find((r) => r["id"] === caseID)

	if (!row) throw new Error(`sweep case ${caseID} not found in ${path.pathname}`)

	return row
}

const out: HardSliceCase[] = []

for (const c of [...FRAGMENT_ROWS, ...TOPONYM_ROWS]) {
	const { pop, imp } = await matchers(c.locale)
	const popTags = biasOf(pop, c.probeSurface)
	const impTags = biasOf(imp, c.probeSurface)
	// Report on the tag the row is ABOUT — locality unless the curator named another. A surface the FST
	// does not accept yields 0 on that named tag, which is a declared zero (the gazetteer has nothing), not
	// a missing measurement.
	const tag = c.probeTag ?? "locality"
	const point = c.expectID === undefined ? undefined : pointOf(c.expectID)

	out.push({
		id: c.id,
		input: c.input,
		locale: c.locale,
		country: c.country,
		class: c.class,
		fstReach: "in",
		probeSurface: c.probeSurface,
		popBias: round4(popTags.get(tag) ?? 0),
		impBias: round4(impTags.get(tag) ?? 0),
		probeTag: tag,
		...(c.expectID === undefined ? {} : { expectPlaceID: `wof:${c.expectID}` }),
		...(point ? { expectPlaceName: point.name } : {}),
		...(point && c.toleranceM
			? {
					expectLat: round4(point.latitude),
					expectLon: round4(point.longitude),
					expectToleranceM: c.toleranceM,
				}
			: {}),
		source: "hard-slice-board:2026-08-06",
		addedAt: ADDED_AT,
		...(c.bugRef ? { bugRef: c.bugRef } : {}),
		note: c.note,
	})
}

for (const s of SWEEP_ROWS) {
	const row = await sweepRow(s.cc, s.caseID)
	const cc = String(row["country"] ?? s.cc).toUpperCase()
	const lat = row["expectLat"] as number | undefined
	const lon = row["expectLon"] as number | undefined
	const tol = row["expectToleranceM"] as number | undefined
	const hasCoord = lat !== undefined && lon !== undefined && tol !== undefined
	// Sweep rows grade under the base package: no overlay ships for these countries.
	const locale = "en-us"
	// MEASURED, never declared. The first cut of this builder wrote `popBias: 0, impBias: 0` here on the
	// reasoning that "no FST covers Botswana", and that was WRONG in the way this repo keeps finding: the
	// arm loads the FST by LOCALE, not by answer-country, so an en-us row's surface is scored against the
	// US gazetteer whatever the answer's country is. "Moscow" carries 0.3411 → 0.5465 from 33 US bearers
	// and "Nassau" 0.0755 → 0.4234 from 8 — real bias, on rows whose correct answer is in RU and BS. A
	// declared zero would have hidden the single most interesting thing about this class, which is that
	// the gazetteer can only pull these rows toward the WRONG place.
	const { pop, imp } = await matchers(locale)
	const popTags = biasOf(pop, s.probeSurface)
	const impTags = biasOf(imp, s.probeSurface)

	out.push({
		id: `sweep-${s.caseID}`,
		input: String(row["input"]),
		locale,
		country: cc,
		class: s.class,
		fstReach: "out",
		probeSurface: s.probeSurface,
		popBias: round4(popTags.get("locality") ?? 0),
		impBias: round4(impTags.get("locality") ?? 0),
		probeTag: "locality",
		...(hasCoord ? { expectLat: round4(lat), expectLon: round4(lon), expectToleranceM: tol } : {}),
		source: `hard-slice-board:2026-08-06 (verbatim from cases/${s.cc}/regression.jsonl:${s.caseID})`,
		addedAt: ADDED_AT,
		bugRef: "#1513",
		note: `${s.note} Input, coordinate and tolerance are the corpus row's, unchanged.`,
	})
}

const sorted = out.toSorted((a, b) => a.id.localeCompare(b.id))
await writeLocalTextFile(`${sorted.map((c) => JSON.stringify(canonicalizeHardSliceCase(c))).join("\n")}\n`, OUT)

const inReach = sorted.filter((c) => c.fstReach === "in").length
const moved = sorted.filter((c) => c.popBias !== c.impBias).length

console.error(`wrote ${sorted.length} rows → ${OUT}`)
console.error(`  fstReach in=${inReach} out=${sorted.length - inReach}`)
console.error(`  rows whose probe surface has a DIFFERENT bias between arms: ${moved}`)

//#endregion
