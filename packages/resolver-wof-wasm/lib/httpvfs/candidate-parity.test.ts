/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node↔browser candidate-reader parity over the real artifact, asserting the same top candidate and skipped when the artifact is absent.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { WOFCandidateTableLookup as NodeCandidateLookup } from "@mailwoman/resolver-wof-sqlite"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate-schema"
import { wofDatabasePath } from "@mailwoman/resolver-wof-sqlite/paths"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterAll, describe, expect, test } from "vitest"

import { WOFCandidateTableLookup as BrowserCandidateLookup } from "#httpvfs/resolver"
import { stubWorker } from "#test/httpvfs-stub-worker"

const CANDIDATE_DB = wofDatabasePath("candidate.db")
const present = await pathExists(CANDIDATE_DB)

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
	const raw = present ? new DatabaseClient<CandidateDatabase>(CANDIDATE_DB, { readOnly: true }) : undefined
	const node = present ? new NodeCandidateLookup({ databasePath: CANDIDATE_DB }) : undefined
	const browser = raw ? new BrowserCandidateLookup(stubWorker(raw)) : undefined

	afterAll(() => {
		raw?.destroy()
		node?.[Symbol.dispose]()
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
		expect(b.importance).toBe(n.importance)
		expect(b.referential).toBe(n.referential)
	})

	test("'NYC' — the one structural divergence: Node's fuzzy tier answers, the browser abstains", async () => {
		const nodeHits = await node!.findPlace({ text: "NYC", placetype: "locality", limit: 5 })
		const browserHits = await browser!.findPlace({ text: "NYC", placetype: "locality", limit: 5 })

		expect(nodeHits.every((h) => h.exactMatch !== true)).toBe(true)
		expect(browserHits).toEqual([])
	})
})
