/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node↔browser candidate-reader PARITY over the REAL artifact (the #861 server↔demo contract, run
 *   for the 2026-08-11 staging repoint): the same probes through the Node `WOFCandidateTableLookup`
 *   (`@mailwoman/resolver-wof-sqlite`) and the browser twin (`httpvfs-resolver.ts` over a
 *   node:sqlite-backed stub worker), asserting the SAME top answer — id, coordinate, exact-tier flag,
 *   and the #28 importance carry.
 *
 *   Skipped byte-for-byte when the data-root artifact is absent (CI runners don't mount it); the
 *   staging receipt records the run against the exact artifact md5 it graded.
 */

import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

import { dataRootPath } from "@mailwoman/core/utils"
import { WOFCandidateTableLookup as BrowserCandidateLookup } from "@mailwoman/docs/shared/httpvfs-resolver"
import { WOFCandidateTableLookup as NodeCandidateLookup } from "@mailwoman/resolver-wof-sqlite"
import { afterAll, describe, expect, test } from "vitest"

const CANDIDATE_DB = dataRootPath("wof", "candidate.db")
const present = existsSync(CANDIDATE_DB)

/**
 * The minimal httpvfs worker handle over node:sqlite (async exec, sql.js result shape) — the same stub
 * `httpvfs-resolver.test.ts` uses, pointed at the real artifact.
 */
function stubWorker(db: DatabaseSync) {
	return {
		db: {
			async exec(sql: string) {
				const rows = db.prepare(sql).all() as Record<string, unknown>[]

				if (!rows.length) return []
				const columns = Object.keys(rows[0]!)

				return [{ columns, values: rows.map((r) => columns.map((c) => r[c])) }]
			},
		},
		bytesRead: async () => 0,
	}
}

/**
 * The bare-name panel: every primary-preference contest the ranker's docstring names, the Zabiče production case the
 * staging repoint exists for, and the Moscow exact-tier rows (both readers must agree even where the answer is a known
 * defect). "NYC" is deliberately NOT here: the artifact carries no `nyc` key, so Node answers from its trigram FUZZY
 * tier — which the browser reader does not implement — and that one structural divergence has its own test below.
 */
const PANEL = [
	"Cancun",
	"Los Angeles",
	"Las Vegas",
	"Frisco",
	"Zabiče",
	"Moscow",
	"Springfield",
	"Auckland",
	"Paris",
] as const

describe.skipIf(!present)("Node↔browser candidate parity over the real artifact", () => {
	const raw = present ? new DatabaseSync(CANDIDATE_DB, { readOnly: true }) : undefined
	const node = present ? new NodeCandidateLookup({ databasePath: CANDIDATE_DB }) : undefined
	const browser = raw ? new BrowserCandidateLookup(stubWorker(raw) as never) : undefined

	afterAll(() => {
		raw?.close()
		node?.close?.()
	})

	test.each(PANEL)("'%s' — same top candidate through both readers", async (name) => {
		const nodeHits = await node!.findPlace({ text: name, placetype: "locality", limit: 5 })
		const browserHits = await browser!.findPlace({ text: name, placetype: "locality", limit: 5 })

		expect(browserHits).toHaveLength(nodeHits.length)

		if (!nodeHits.length) return

		const n = nodeHits[0]!
		const b = browserHits[0]! as typeof n

		expect(Number(b.id)).toBe(Number(n.id))
		expect(b.lat).toBeCloseTo(n.lat, 6)
		expect(b.lon).toBeCloseTo(n.lon, 6)
		expect(b.exactMatch ?? false).toBe(n.exactMatch ?? false)
		// The #28 fame prior: both readers either carry it (same value) or both leave it absent.
		expect(b.importance).toBe(n.importance)
		// The two-score split's referential carry agrees too.
		expect(b.referential).toBe(n.referential)
	})

	test("'NYC' — the one structural divergence: Node's fuzzy tier answers, the browser abstains", async () => {
		const nodeHits = await node!.findPlace({ text: "NYC", placetype: "locality", limit: 5 })
		const browserHits = await browser!.findPlace({ text: "NYC", placetype: "locality", limit: 5 })

		// The artifact carries no `nyc` key: every Node hit is a typo-corrector row (exactMatch=false),
		// and the browser — which has no fuzzy tier — returns nothing. If THIS test starts failing with
		// browser hits, the browser gained a fuzzy tier: extend the parity panel to cover it.
		expect(nodeHits.every((h) => h.exactMatch !== true)).toBe(true)
		expect(browserHits).toEqual([])
	})
})
