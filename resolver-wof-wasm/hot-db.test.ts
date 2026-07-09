/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Integration tests against a REAL production `wof-hot.db` (the slim DB the live demo serves) — the
 *   three resolution bugs measured on the live demo 2026-06-11:
 *
 *   1. "Brooklyn" resolved to Brooklyn Park, MN because the locality placetype filter excluded the
 *        `borough` row for Brooklyn (WOF id 421205765, pop 2.5M).
 *   2. "brooklyn, new york, ny" did the same because the region-bbox-constrained pass found nothing (the
 *        borough was filtered out) and the cascade silently fell back to unconstrained.
 *   3. "New York City" has no spr row under that name — it's a WOF ALIAS of the New York locality
 *        (85977539), reachable only through the FTS `alt_names` bag.
 *
 *   The 16 MB DB is NOT committed. Point `MAILWOMAN_WOF_HOT_DB` at a byte-copy of the live DB (e.g.
 *   `/tmp/v440-stage/en-us/v4.4.0/wof-hot.db`, or any `wof-hot.db` staged by build-demo-assets) and
 *   run `yarn vitest --run resolver-wof-wasm/hot-db.test.ts`. The whole suite SKIPS when the env
 *   var is unset, so CI stays green without the artifact.
 *
 *   Covers all three lookup backends that must agree: the WASM lookup (this package), the Node lookup
 *   (`@mailwoman/resolver-wof-sqlite`), and the demo cascade (`docs/src/shared/demo-helpers`, which
 *   the live demo drives through its httpvfs lookup — same SQL + ranking as the WASM lookup).
 */

import { readFile } from "node:fs/promises"

import { $public } from "@mailwoman/core/env"
import { WOFSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

import { runCascade } from "../docs/src/shared/demo-helpers.ts"
import { loadSlimWOFDatabase } from "./loader.ts"
import { WOFWasmPlaceLookup } from "./lookup.ts"

const HOT_DB_PATH = $public.MAILWOMAN_WOF_HOT_DB

const BROOKLYN_BOROUGH = 421205765
const NEW_YORK_LOCALITY = 85977539

describe.skipIf(!HOT_DB_PATH)("against the production wof-hot.db (MAILWOMAN_WOF_HOT_DB)", () => {
	let wasmLookup: WOFWasmPlaceLookup

	beforeAll(async () => {
		const bytes = await readFile(HOT_DB_PATH!)
		const { db } = await loadSlimWOFDatabase({ source: bytes })
		wasmLookup = new WOFWasmPlaceLookup({ db })
	})

	afterAll(() => {
		wasmLookup?.close()
	})

	describe("WASM lookup", () => {
		test('"Brooklyn" locality query → Brooklyn-the-borough (NYC), not Brooklyn Park MN', async () => {
			const matches = await wasmLookup.findPlace({ text: "Brooklyn", placetype: "locality", limit: 5 })
			expect(matches[0]).toMatchObject({ id: BROOKLYN_BOROUGH, name: "Brooklyn", placetype: "borough" })
			expect(matches[0]?.exactMatch).toBe(true)
		})

		test('"New York City" → the New York locality via its WOF alias', async () => {
			const matches = await wasmLookup.findPlace({ text: "New York City", placetype: "locality", limit: 5 })
			expect(matches[0]).toMatchObject({ id: NEW_YORK_LOCALITY, name: "New York", placetype: "locality" })
			expect(matches[0]?.exactMatch).toBe(true)
		})
	})

	describe("demo resolution (runCascade — the shared resolveTree over the WASM lookup, #861)", () => {
		const node = (tag: string, value: string, children: object[] = []) => ({
			tag,
			value,
			confidence: 0.95,
			children,
		})
		const tree = (raw: string, roots: object[]) => ({ raw, roots }) as { roots: unknown[] }

		test('locality "Brooklyn" alone → the borough', async () => {
			const hits = await runCascade(wasmLookup, tree("Brooklyn", [node("locality", "Brooklyn")]), "Brooklyn")

			expect(hits[0]?.id).toBe(BROOKLYN_BOROUGH)
		})

		test('locality "brooklyn" under region "new york" → the borough (parent scope narrows)', async () => {
			const hits = await runCascade(
				wasmLookup,
				tree("brooklyn, new york, ny", [node("region", "new york", [node("locality", "brooklyn")])]),
				"brooklyn, new york, ny"
			)

			expect(hits[0]?.id).toBe(BROOKLYN_BOROUGH)
		})

		test('locality "New York City" → the New York locality', async () => {
			const hits = await runCascade(
				wasmLookup,
				tree("New York City", [node("locality", "New York City")]),
				"New York City"
			)

			expect(hits[0]?.id).toBe(NEW_YORK_LOCALITY)
		})

		test("an unresolvable parsed region does not sink the locality (parentFallback recall)", async () => {
			// The old cascade warned-and-widened here; the shared walk's parentFallback retries the
			// locality unscoped when the parent scope yields nothing — recall over silence, no warning
			// contract. The locality must still resolve.
			const hits = await runCascade(
				wasmLookup,
				tree("Brooklyn, Zzyzx Nonexistia", [node("region", "Zzyzx Nonexistia", [node("locality", "Brooklyn")])]),
				"Brooklyn, Zzyzx Nonexistia"
			)

			expect(hits[0]?.id).toBe(BROOKLYN_BOROUGH)
		})
	})

	describe("Node lookup (resolver-wof-sqlite) — parity on the same DB", () => {
		test('"Brooklyn" locality query → the borough (placetype expansion + alias-bag exact tier)', async () => {
			const lookup = new WOFSqlitePlaceLookup({ databasePath: HOT_DB_PATH! })

			try {
				const matches = await lookup.findPlace({ text: "Brooklyn", placetype: "locality", limit: 5 })
				expect(matches[0]).toMatchObject({ id: BROOKLYN_BOROUGH, name: "Brooklyn", placetype: "borough" })
				expect(matches[0]?.exactMatch).toBe(true)
			} finally {
				lookup.close()
			}
		})

		test('"New York City" → the New York locality via the alias bag (no names table on the slim DB)', async () => {
			const lookup = new WOFSqlitePlaceLookup({ databasePath: HOT_DB_PATH! })

			try {
				const matches = await lookup.findPlace({ text: "New York City", placetype: "locality", limit: 5 })
				expect(matches[0]).toMatchObject({ id: NEW_YORK_LOCALITY, name: "New York" })
				expect(matches[0]?.exactMatch).toBe(true)
			} finally {
				lookup.close()
			}
		})
	})
})
