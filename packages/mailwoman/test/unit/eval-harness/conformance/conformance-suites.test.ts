/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The register of law suites, checked against the directory it claims to describe.
 *
 *   THE CHECK THAT MATTERS IS THE DIRECTORY WALK. Everything else here restates something a suite's own test
 *   already asserts; the walk is the only one that can see a suite file nobody registered, and an unregistered
 *   suite does not run unaudited — it never runs at all, which reports as an absence rather than a failure.
 *   That is the shape a law suite exists to refuse, so the register gets the same treatment.
 *
 *   Artifact-free by construction: the register imports the law modules and the fixture contract, never the
 *   Gauntlet harness, so this leg runs wherever the repo does.
 */

import { readdirSync } from "@mailwoman/platform/fs"
import { basename } from "@mailwoman/platform/path"
import { type ConformanceFixture, loadConformanceFixtures } from "mailwoman/eval-harness/conformance/fixture"
import {
	CONFORMANCE_SUITE_DIR,
	CONFORMANCE_SUITES,
	describeLaw,
	suiteForLaw,
} from "mailwoman/eval-harness/conformance/suites"
import { describe, expect, it } from "vitest"

describe("the conformance suite register", () => {
	it("names every committed suite file in its own directory", () => {
		const committed = readdirSync(CONFORMANCE_SUITE_DIR).filter((entry) => entry.endsWith(".jsonl"))
		const registered = new Set(CONFORMANCE_SUITES.map((suite) => basename(suite.path)))

		expect(committed.length).toBeGreaterThan(0)

		for (const file of committed) {
			expect(
				registered.has(file),
				`${file} is committed but named by no register entry — it would never run, and never be audited`
			).toBe(true)
		}
	})

	it("gives each law exactly one entry", () => {
		const laws = CONFORMANCE_SUITES.map((suite) => suite.law)

		expect(new Set(laws).size).toBe(laws.length)

		for (const suite of CONFORMANCE_SUITES) {
			expect(suiteForLaw(suite.law)).toBe(suite)
		}
	})

	it("answers undefined for a law nobody registered, rather than another law's audit", () => {
		const unregistered: ConformanceFixture = {
			id: "unregistered",
			law: "no-such-law",
			base: "Portland, OR",
			variant: "Portland, OR",
			outcomeComparator: "resolution_identity",
			expect: "equivalent",
		}

		expect(suiteForLaw(unregistered.law)).toBeUndefined()
		expect(describeLaw(unregistered)).toBe("")
	})

	it.each(CONFORMANCE_SUITES.map((suite) => [suite.law, suite] as const))(
		"loads %s, states only its own law, and passes its own audit",
		async (law, suite) => {
			const fixtures = await loadConformanceFixtures(suite.path)

			expect(fixtures.length).toBeGreaterThan(0)
			expect(new Set(fixtures.map((fixture) => fixture.law))).toEqual(new Set([law]))
			expect(suite.audit(fixtures)).toEqual([])

			for (const fixture of fixtures) {
				expect(describeLaw(fixture), `${fixture.id}: no law detail`).not.toBe("")
			}
		}
	)

	it("keeps fixture ids unique ACROSS suites — an id names a row in failure output", async () => {
		const seen = new Map<string, string>()

		for (const suite of CONFORMANCE_SUITES) {
			for (const fixture of await loadConformanceFixtures(suite.path)) {
				expect(seen.get(fixture.id), `${fixture.id} is claimed by two suites`).toBeUndefined()
				seen.set(fixture.id, suite.law)
			}
		}

		expect(seen.size).toBeGreaterThan(0)
	})
})
