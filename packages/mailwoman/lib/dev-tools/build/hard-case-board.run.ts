/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coordinates, place names and FST biases are machine-filled from primary data, so a row's truth is never a
 *   hand-typed decimal.
 *
 *   The sweep-derived classes are lifted verbatim from `gauntlet/cases/<cc>/regression.jsonl`, so the board and the
 *   corpus cannot drift apart on a row they share.
 *
 *   Run: node packages/mailwoman/lib/dev-tools/build/hard-case-board.run.ts [--out <path>]
 */

import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { getRow } from "@mailwoman/core/utils"
import { collapseFSTBias } from "@mailwoman/neural/fst-prior"
import { normalizeTokens, deserializeFST } from "@mailwoman/resolver-wof-sqlite/fst"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { JSONSpliterator } from "spliterator"

import { FRAGMENT_ROWS } from "#dev-tools/hard-case-board/rows/index"
import { TOPONYM_ROWS } from "#dev-tools/hard-case-board/rows/toponym"
import { SWEEP_ROWS } from "#dev-tools/hard-case-board/sweep-rows"
import { canonicalizeHardCase, type HardCase, HARD_CASE_BOARD_PATH } from "#eval-harness/hard-case-board"

const { values } = parseArguments({ options: { out: { type: "string" } } })
const OUT = values.out ?? HARD_CASE_BOARD_PATH

const ADDED_AT = "2026-08-06"
const WOF_DB = wofDatabasePath("fst-staging-2026-08-05", "admin-global-priority-importance.db")
const POP_FST_DIR = wofDatabasePath("fst-per-locale")
const IMP_FST_DIR = wofDatabasePath("fst-staging-2026-08-05-importance-fanoutfix")

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
		pop: deserializeFST(await readLocalBuffer(POP_FST_DIR(`fst-${locale}.bin`))),
		imp: deserializeFST(await readLocalBuffer(IMP_FST_DIR(`fst-${locale}.bin`))),
	}

	matcherCache.set(locale, pair)

	return pair
}

/**
 * The per-BIO-tag max collapse `applyBias` performs, where a surface the FST does
 * not accept returns an empty map (absence) rather than a zero.
 */
function biasOf(matcher: unknown, surface: string): Map<string, number> {
	const walk = (matcher as { walk(t: string[]): { stateID: number; accepted: boolean } | null }).walk(
		normalizeTokens(surface)
	)

	if (!walk?.accepted) return new Map()

	const entries = (matcher as { accepting(id: number): Array<{ placetype: string; importance: number }> }).accepting(
		walk.stateID
	)

	return collapseFSTBias(entries, normalizeTokens(surface))
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4

// #region Emit

const CASES_ROOT = new URL("../eval-harness/gauntlet/cases/", import.meta.url)

async function sweepRow(cc: string, caseID: string): Promise<Record<string, unknown>> {
	const path = new URL(`${cc}/regression.jsonl`, CASES_ROOT)

	const row = await JSONSpliterator.fromAsync<Record<string, unknown>>(path.pathname).find(
		(candidate) => candidate["id"] === caseID
	)

	if (!row) throw new Error(`sweep case ${caseID} not found in ${path.pathname}`)

	return row
}

const out: HardCase[] = []

for (const c of [...FRAGMENT_ROWS, ...TOPONYM_ROWS]) {
	const { pop, imp } = await matchers(c.locale)
	const popTags = biasOf(pop, c.probeSurface)
	const impTags = biasOf(imp, c.probeSurface)
	// Report on the tag the row is about — locality unless the curator named another,
	// with an unaccepted surface reading as a declared zero on that tag.
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
		source: "hard-case-board:2026-08-06",
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
	// Measured, never declared: the arm loads the FST by locale rather than by answer-country,
	// so a hard-coded zero would hide the bias these surfaces carry.
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
		source: `hard-case-board:2026-08-06 (verbatim from cases/${s.cc}/regression.jsonl:${s.caseID})`,
		addedAt: ADDED_AT,
		bugRef: "#1513",
		note: `${s.note} Input, coordinate and tolerance are the corpus row's, unchanged.`,
	})
}

const sorted = out.toSorted((a, b) => a.id.localeCompare(b.id))
await writeLocalTextFile(`${sorted.map((c) => stringifyJSON(canonicalizeHardCase(c))).join("\n")}\n`, OUT)

const inReach = sorted.filter((c) => c.fstReach === "in").length
const moved = sorted.filter((c) => c.popBias !== c.impBias).length

console.error(`wrote ${sorted.length} rows → ${OUT}`)
console.error(`  fstReach in=${inReach} out=${sorted.length - inReach}`)
console.error(`  rows whose probe surface has a DIFFERENT bias between arms: ${moved}`)

// #endregion
