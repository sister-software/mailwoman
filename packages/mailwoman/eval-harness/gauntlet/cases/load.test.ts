/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The corpus loader's gate, and the receipt for the 2026-08-05 TS-array → per-country-JSONL migration.
 *
 *   THE MIGRATION PROOF, in two legs. While both representations existed, this suite deep-equalled the
 *   loaded corpus against `REGRESSION_CASES` row for row — see the commit that added `cases/<cc>/*.jsonl`,
 *   where that test is green against both. That commit measured {@linkcode CORPUS_HASH} and
 *   {@linkcode BOARD_ID}; the commit that deleted the array kept the pins and dropped the array leg, so the
 *   content claim outlives the source it was checked against. The deep-equal is in the history, not in prose.
 *
 *   The board id is the load-bearing one. `ablationBoardID` fingerprints a SORTED `id`+`input` list, so it is
 *   content-addressed and NOT order-addressed: reorganizing 192 rows into 29 files is invisible to it, and
 *   every ablation artifact measured before the migration stays comparable to every one measured after.
 *   `gauntlet-regression@192:d753b86005a7` is the same string on both sides. The id is NOT versioned by this
 *   change, deliberately — versioning it would have declared a corpus that did not change to be a new board.
 *
 *   Everything else here is the loader's error surface. A corpus spread across 121 files earns its keep only
 *   if a bad row says WHICH file and WHICH line; a bare `SyntaxError` over 306 rows is a scavenger hunt.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { ablationBoardID } from "../ablation.ts"
import { CorpusRowError, loadRegressionCases, regressionCorpusHash } from "./load.ts"
import { canonicalizeSeedCase, SeedCaseSchema } from "./seed-case.ts"

/**
 * The corpus today — 538 curated regressions.
 *
 * 192 at the 2026-08-05 JSONL migration, plus the 114 `operator:country-sweep-2026-08-05` promotions (the
 * country-coverage sweep's measured FAILs; see `batch-notes.md`), plus 14 Google-reviewed operator addresses added
 * 2026-08-09 (12 GB venue/address boundaries and the same JP rooftop in English and Japanese), plus 170 locale-scoped
 * bare-street boundary cases from the operator's multilingual street-name audit, plus 24
 * `operator:world-structures-2026-08-10` cases — real-world addresses from eleven countries whose STRUCTURE the
 * `ComponentTag` union cannot fully express (Brasília's sector/quadra hierarchy, Colombian cross-street nomenclatura,
 * GhanaPostGPS digital codes, plus codes, Irish townland recursion, Mongolian district/khoroo nesting, Nicaraguan
 * relative addressing). Country dirs went 29 → 121 in the country-sweep batch, and 121 → 125 with this one (gh, mn, ne,
 * ng are new).
 */
const CORPUS_SIZE = 551

/**
 * `regressionCorpusHash` of the corpus.
 *
 * Changing the corpus changes this. That is the point: an edit to a `.jsonl` row now needs a matching edit here, and
 * the diff says "the corpus changed" rather than "a 3,500-line file changed".
 *
 * Moved 2026-08-06 (#1507) — `ab541bba…` → `848548e6…` — when seven country-sweep family-A rows gained
 * `expectPlaceName`. Row COUNT was unchanged there, which is why the board id below did not move: those rows already
 * existed and their `id`+`input` were untouched. As of the same day this value also lives in every built
 * `regression.db` (the `gauntlet_meta` stamp), and a runner refuses to grade when the two disagree — so a corpus edit
 * leaves the DB stale until it is rebuilt, by design.
 *
 * Moved 2026-08-10 — `848548e6…` → `02026054…` — by the 24-row `operator:world-structures-2026-08-10` batch.
 *
 * Moved again 2026-08-11 — `02026054…` → `f87db0a9…` — when `mn-ws-gandantegchinlen-dual-script` gained the per-row
 * `expectComponentRenderings` contract (#34: the global dual-script grader relaxation became a per-row opt-in). Row
 * count and every `id`+`input` were untouched, so the board id there stayed.
 *
 * Moved 2026-08-11 (second) — `f87db0a9…` → `a379f1dc…` — by the 8-row `bug:#1589` bare-foreign-postcode board (cz ×3,
 * sk, gb, nl, us ×2): six improvement_target rows pinning the first-drop stages (query-shape's missing NNN NN format;
 * the resolver's US-only bare-postcode branch) and two US pass controls (90210; the 75008 locale-prior contract). Row
 * count moves 514 → 522, so the board id below moves too.
 *
 * Moved 2026-08-11 (third) — `a379f1dc…` → this — by the #1589 FIX landing: four rows flip improvement_target → pass
 * (cz ×2, sk, nl), the SW1A note narrows to the residual A-suffixed-outward drop, `gb-bare-postcode-n7-0bt` joins as
 * the GB green control (522 → 523, so the board id moves too), and the 75008 locale-prior row gains `defaultCountry:
 * US` — the locale prior reaches the library as the CLI's inferred defaultCountry, and without the field the harness
 * measured the no-locale arm, where the pin never held (baseline: unresolved).
 *
 * Moved 2026-08-11 (fourth) — `b639adfe…` → this — by the 7-row `bug:#1585` fuzzy-scope board (nz ×3, us, fr, ru ×2):
 * the cross-country typo-tier receipts (Stanmore Bay → Banmore IN under en-NZ; Sacremento → BE; Aucklnad → GB), the
 * in-country scrape (Gore Bay, pop 39), and the exact-match contract controls (Paris under en-US passes; bare Moscow
 * and structured 'Moscow, Russia' pin their separate exact-tier drops). First rows to carry the new `locale` and
 * `expectAbstain` fields. 523 → 530, so the board id moves too.
 *
 * Moved 2026-08-11 (fifth) — → this — by the #1585 MECHANISM landing: the sacremento row flips improvement_target →
 * pass with its measured receipt. Row count and every `id`+`input` untouched, so the board id stays.
 *
 * Moved 2026-08-11 (sixth) — → this — by the NZ re-pins after the LINZ shard promote (#1617): the two Stanmore Bay rows
 * flip improvement_target → pass with the shard's real coordinates replacing their pre-shard abstain pins. Row count
 * and every `id`+`input` untouched, so the board id stays.
 *
 * Moved 2026-08-11 (seventh) — → this — by the 2-row `fork_entity` board (the declared_fork → entity-probe wire's
 * freeze): the COMER primary (poi.db holds the worldwide-unique entity 6 m from truth; the fork abstains with no
 * consumer) and the Savile Row hijack tripwire, pinned to the true London street with its three wrong behaviors
 * receipted (the qualifier-strip Rhu scrape among them). 530 → 532, so the board id moves too.
 *
 * Moved 2026-08-11 (eighth) — → this — by the fork→entity WIRE landing: the COMER row flips improvement_target → pass
 * with its measured receipt (tier `venue`, 6 m). Row count and every `id`+`input` untouched, so the board id stays.
 *
 * Moved 2026-08-12 (night) — → this — by the 2-row `bare_capital_street_miss` board (Wellington, Antwerpen): the model
 * tags the lone token `street`, the street tier nulls, and the locality walk provably answers (the resolver bisect is
 * in each row's note). 532 → 534, so the board id moves too.
 *
 * Moved 2026-08-12 (second) — → this — by the street-miss FALLBACK landing: both bare-capital rows flip
 * improvement_target → pass with measured receipts. Row count and every `id`+`input` untouched, so the board id stays.
 *
 * Moved 2026-08-12 (third) — → this — by the #1626 strip guard landing: the Savile Row tripwire's note re-ledgers its
 * residual (strip scrape closed; the fuzzy-tier namesake remains, #1614's territory). Note-only; the board id stays.
 *
 * Moved 2026-08-12 (seventh) — → this — by the ANTI-ROT PROMOTION SWEEP: 218 improvement_target rows whose now-PASSES
 * flags were byte-identical across three same-corpus production boards (the sweep baseline, the register-scope-tags
 * board, and the range-fallback board) flip to pass in one reviewed batch. Status-only — every id, input, and note
 * untouched, so the board id stays; the gated set grows 107 → 325.
 *
 * Moved 2026-08-12 (sixth) — → this — by the range-surface fallback landing with its 1-row pin ('32-36 Osborne Drive,
 * Burpengary QLD 4505' — the reader's null-only low-end retry keys the register's NUMBER_FIRST). 537 → 538, so the
 * board id moves too.
 *
 * Moved 2026-08-12 (fifth) — → this — by the 2-row `au_rooftop` board riding the G-NAF lane: the WA state-slug
 * collision witness ('47 Renegade Way, Kingsley WA 6026' — the parsed region 'WA' opened the US Washington shard and
 * starved the AU rooftop until the non-US pre-resolve country learned to outrank the state-slug match) and the rural
 * LOT class ('LOT 373 Clifton Street, Sandstone WA 6639'). Both land status=pass with register-point receipts. 535 →
 * 537, so the board id moves too.
 *
 * Moved 2026-08-12 (fourth) — → this — by the #1614 word-level fuzzy measure landing plus the 1-row
 * `situs_wrong_village` board (#1631 Teichstraße, the wrong-village rooftop match panel-v2 surfaced): the aucklnad
 * measure-misalignment witness flips improvement_target → pass with its measured receipt (Auckland NZ, word-level 0.975
 * vs auckley 0.868), the board-flagged newly-passing `gb-street-name-savile-row` promotes to pass, and the Savile Row
 * tripwire's ledger closes its fuzzy residual (namesake corrections die under WORD_FUZZY_MIN 0.85) while opening #1632
 * for the span-rescore alias door its board print actually traces to. 534 → 535, so the board id moves too.
 */
const CORPUS_HASH = "b494ca942daaa548ab5e1f6a87ec7776cb7532f13af4409a23f20abf82b3e81d"

/**
 * `ablationBoardID` of the corpus.
 *
 * The id is content-addressed and not order-addressed, which is what carried it UNCHANGED across the 2026-08-05 array →
 * JSONL migration. The country sweep is the opposite kind of change — it adds 114 rows — so this one moves, and it
 * should: the ablation board is genuinely a different board. Same again for the 24-row world-structures batch on
 * 2026-08-10 (`@490:c7bd678905d0` → `@514:5c5fca20db47`), for the 8-row bare-foreign-postcode board on 2026-08-11
 * (`@514:5c5fca20db47` → `@522:da202fa6e714`), and for the N7 0BT control the #1589 fix added the same day
 * (`@522:da202fa6e714` → `@523:08b0b462cb23`), for the 7-row fuzzy-scope board (`@523:08b0b462cb23` →
 * `@534:ee145335c825`), for the Teichstraße situs row (`@534:ee145335c825` → `@535:b54fe280134e`), and for the 2-row
 * G-NAF au_rooftop board (`@535:b54fe280134e` → `@537:61edb19b8e64`), and for the range-surface pin
 * (`@537:61edb19b8e64` → this).
 */
const BOARD_ID = "gauntlet-regression@551:4beb2dd83272"

/**
 * A minimal well-formed row, for the error-surface tests to mutate.
 */
const SAMPLE = {
	id: "xx-sample",
	input: "1 Test Street",
	source: "manual",
	addressKind: "test",
	country: "XX",
	status: "pass",
	addedAt: "2026-08-05",
}

/**
 * Write a throwaway corpus tree and return its root.
 */
function scratchCorpus(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "gauntlet-cases-"))

	for (const [relative, body] of Object.entries(files)) {
		const path = join(root, relative)

		mkdirSync(join(path, ".."), { recursive: true })
		writeFileSync(path, body, "utf8")
	}

	return root
}

describe("the committed corpus", () => {
	it("loads every row, in country-dir then id order", async () => {
		const cases = await loadRegressionCases()

		expect(cases).toHaveLength(CORPUS_SIZE)

		const order = cases.map((c) => `${c.country.toLowerCase()}/${c.id}`)

		expect(order).toEqual(order.toSorted())
	})

	it("has the content the pins were measured against", async () => {
		expect(regressionCorpusHash(await loadRegressionCases())).toBe(CORPUS_HASH)
	})

	it("derives the pinned ablation board id", async () => {
		expect(ablationBoardID(await loadRegressionCases())).toBe(BOARD_ID)
	})

	it("assigns every case a unique id", async () => {
		const ids = (await loadRegressionCases()).map((c) => c.id)

		expect(new Set(ids).size).toBe(ids.length)
	})

	it("keys every row in the canonical order, so a diff shows content", async () => {
		for (const c of await loadRegressionCases()) {
			expect(Object.keys(c)).toEqual(Object.keys(canonicalizeSeedCase(c)))
		}
	})
})

describe("the row schema", () => {
	it("rejects an unknown key rather than ignoring it", () => {
		// A typo'd `expectLon` that parsed as "coordinate not asserted" is the failure this strictness is for:
		// the row still runs, still passes, and asserts half of what its author wrote.
		const result = SeedCaseSchema.safeParse({ ...SAMPLE, expectLonn: 2.3 })

		expect(result.success).toBe(false)
	})

	it("rejects a status outside the tracked three", () => {
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, status: "passing" }).success).toBe(false)
	})

	it("rejects a tier outside the resolution ladder", () => {
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectTier: "rooftop" }).success).toBe(false)
	})

	it("accepts the optional ablation pin (#1502), unused by the corpus today", () => {
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, ablationExpect: { country: "region" } }).success).toBe(true)
	})

	it("accepts the per-component rendering contract (#34)", () => {
		const contract = { venue: ["Gandantegchinlen Monastery", "Гандантэгчинлэн хийд"] }

		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectComponentRenderings: contract }).success).toBe(true)
	})

	it("rejects a rendering value that is not a string array", () => {
		// The `expectComponents` shape filed under the wrong key — the likeliest authoring slip.
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectComponentRenderings: { venue: "хийд" } }).success).toBe(false)
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectComponentRenderings: { venue: [42] } }).success).toBe(false)
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectComponentRenderings: ["хийд"] }).success).toBe(false)
	})

	it("rejects an empty rendering list — it would assert nothing while looking asserted", () => {
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectComponentRenderings: { venue: [] } }).success).toBe(false)
		expect(SeedCaseSchema.safeParse({ ...SAMPLE, expectComponentRenderings: { venue: [""] } }).success).toBe(false)
	})
})

describe("a malformed row names its file and line", () => {
	it("on invalid JSON", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${JSON.stringify(SAMPLE)}\n{ not json\n`,
		})

		await expect(loadRegressionCases(root)).rejects.toThrow(/regression\.jsonl:2 — not valid JSON/)
	})

	it("on a schema violation, naming the field", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${JSON.stringify({ ...SAMPLE, expectLat: "48.8" })}\n`,
		})

		await expect(loadRegressionCases(root)).rejects.toThrow(/regression\.jsonl:1 — .*expectLat/)
	})

	it("on a malformed rendering contract, naming the field", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${JSON.stringify({ ...SAMPLE, expectComponentRenderings: { venue: "хийд" } })}\n`,
		})

		await expect(loadRegressionCases(root)).rejects.toThrow(/regression\.jsonl:1 — .*expectComponentRenderings/)
	})

	it("counts blank lines, so the number matches the editor's", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${JSON.stringify(SAMPLE)}\n\n\n{ not json\n`,
		})

		await expect(loadRegressionCases(root)).rejects.toThrow(CorpusRowError)
		await expect(loadRegressionCases(root)).rejects.toThrow(/regression\.jsonl:4/)
	})

	it("on a country that disagrees with its directory", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${JSON.stringify({ ...SAMPLE, country: "FR" })}\n`,
		})

		await expect(loadRegressionCases(root)).rejects.toThrow(/does not match its directory "xx"/)
	})

	it("on a duplicate id across two files in the same dir", async () => {
		const root = scratchCorpus({
			"xx/regression.jsonl": `${JSON.stringify(SAMPLE)}\n`,
			"xx/extra.jsonl": `${JSON.stringify(SAMPLE)}\n`,
		})

		await expect(loadRegressionCases(root)).rejects.toThrow(/duplicate case id "xx-sample"/)
	})
})
