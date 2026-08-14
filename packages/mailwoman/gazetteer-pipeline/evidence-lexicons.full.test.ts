/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The FULL-SCALE locality-surface build against the live WOF admin DB.
 *
 *   NOT ON THE PR PATH by default. Measured 2026-08-02 this pair of tests was 236.9s of a 253s CI
 *   leg (172s after the scan memoization), and it grows with the gazetteer. It runs in three places,
 *   each catching something the others cannot:
 *
 *   - `test.yml` job `lexicon-full`, path-gated — a PR that changes the builder or its inputs.
 *   - `lexicon-nightly.yml` — DATA drift. The gazetteer is rebuilt outside any PR, so no path filter
 *       can see it. This is the only layer that catches that, and it is the control for the fixture
 *       layer: if the fixture stops representing the real data, this is what says so.
 *   - `publish.yml` prepare — the release gate.
 *
 *   The every-PR law coverage lives in `evidence-lexicons.fixture.test.ts`, which asserts the same
 *   four laws against a seeded DB and is invariant to gazetteer size. What stays HERE is the
 *   coverage-scale claims — `entries > 10_000` and the nonzero skip counters — because those are
 *   claims about the gazetteer rather than about the laws.
 */

import { existsSync } from "node:fs"
import { tmpdir } from "node:os"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { dataRootPath } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"

const ADMIN_DB = String(dataRootPath("wof", "admin-global-priority.db"))

describe.skipIf(!existsSync(ADMIN_DB))("locality-surface build — integration (admin DB)", () => {
	it("applies all three laws end to end", async () => {
		const { buildLocalitySurfaceLexicon } = await import("./evidence-lexicons.ts")
		const tmp = `${tmpdir()}/locality-surface-lexicon-test.json`

		// v3-parity placetypes for run-to-run comparability with the probe chain's numbers.
		const built = buildLocalitySurfaceLexicon({
			countries: ["FR"],
			placetypes: ["locality", "localadmin"],
			output: tmp,
		})

		expect(built.entries).toBeGreaterThan(10_000)
		expect(built.skippedDegenerate).toBeGreaterThan(0)
		expect(built.skippedProminence).toBeGreaterThan(0)
		const { readFileSync } = await import("node:fs")
		const j = parseJSONStrict<{ entries: Record<string, number> }>(readFileSync(tmp, "utf8"))

		expect(j.entries.paris).toBe(3) // metro clears the person-name tier, homograph-flagged
		expect(j.entries.joseph).toBeUndefined() // law 3
		expect(j.entries["12"]).toBeUndefined() // letters-required
		expect(j.entries["de la"]).toBeUndefined() // law 1 compositional
	}, 600_000)

	it("v5: the census flip families are out, the legitimate entries stay", async () => {
		const { buildLocalitySurfaceLexicon } = await import("./evidence-lexicons.ts")
		const tmp = `${tmpdir()}/locality-surface-lexicon-v5-us-test.json`

		const built = buildLocalitySurfaceLexicon({
			countries: ["US"],
			placetypes: ["locality", "localadmin", "neighbourhood"],
			output: tmp,
		})

		expect(built.skippedRegionVocabulary).toBeGreaterThan(0)
		expect(built.skippedSubPhrase).toBeGreaterThan(0)
		const { readFileSync } = await import("node:fs")
		const j = parseJSONStrict<{ entries: Record<string, number> }>(readFileSync(tmp, "utf8"))

		// Family F2b — directionals (neighbourhoods literally named these; law-1 closure):
		for (const s of ["east", "west", "north", "south", "northeast", "southwest"]) {
			expect(j.entries[s], s).toBeUndefined()
		}

		// Family F2 — region vocabulary (the evidence→REGION rotation rows):
		for (const s of ["washington", "wyoming", "vermont", "missouri", "north dakota"]) {
			expect(j.entries[s], s).toBeUndefined()
		}

		// WOF data-noise carriers with census receipts (the evidence supplemental-degenerate set):
		expect(j.entries.school).toBeUndefined()
		expect(j.entries.state).toBeUndefined()

		// The lexicon still carries the ordinary locality surfaces the census rows NEED. (Not casper/
		// powell: Casper WY is a GIVEN-NAME homograph at 0.42 < the 0.45 law-3 tier, Powell WY is below
		// the law-2 floor — both were absent from v4 too; their census flips were family-F1 street-code
		// evidence, fixed in the street lexicon.)
		for (const s of ["fargo", "minot", "rutland", "plainfield", "cheyenne"]) {
			expect(j.entries[s], s).toBeDefined()
		}

		// Multi-token entries with a directional/state INSIDE survive (only whole-surface exclusion):
		expect(j.entries["east nashville"]).toBeDefined()
	}, 600_000)
})
