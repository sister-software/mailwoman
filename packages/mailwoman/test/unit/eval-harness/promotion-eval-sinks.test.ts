/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The de-shell migration's safety net (2026-08-06). When `promotion-eval.ts` spawned its battery as
 *   eight child processes, two things were true for free: a child's stdout arrived as bytes, and a
 *   child's non-zero exit was a number the check could branch on. In-process, both are things this
 *   code now has to GET RIGHT, and neither shows up in a type error if it is wrong — the check would
 *   simply write a subtly different `.md`, or tolerate a leg it used to abort on.
 *
 *   So this file pins the two invariants the migration rests on:
 *
 *   1. `renderLines` reproduces a child's stdout byte-for-byte from the sink's line records.
 *   2. The per-leg error-semantics table — which leg tolerates a failure, which aborts the run, and
 *        which merges stderr into its `.md` — as EXECUTABLE structure rather than a comment, checked
 *        against the shape each migrated module actually presents.
 *
 *   Weightless by construction (#582): nothing here loads a model, so it runs in CI. The numeric
 *   equivalence proof is the twice-run check receipt, not a unit test.
 */

import { deOrderEval } from "mailwoman/eval-harness/de-order-eval"
import { demoCascadeSmoke } from "mailwoman/eval-harness/demo-cascade-smoke"
import { externalArenas } from "mailwoman/eval-harness/external-arenas"
import { frParseRecall } from "mailwoman/eval-harness/fr-parse-recall"
import { perLocaleF1 } from "mailwoman/eval-harness/per-locale-f1"
import { renderLines } from "mailwoman/eval-harness/promotion-eval"
import { scoreAffix } from "mailwoman/eval-harness/score-affix"
import { scoreCountryHomograph } from "mailwoman/eval-harness/score-country-homograph"
import { describe, expect, test } from "vitest"

describe("renderLines — child stdout parity", () => {
	test("one record per console.log call, each with its trailing newline", () => {
		// What `console.log("a"); console.log("b")` put on a pipe.
		expect(renderLines(["a", "b"])).toBe("a\nb\n")
	})

	test("a multi-line argument stays ONE record and gains ONE newline", () => {
		// score-affix prints its table header as a single call containing an embedded newline:
		// `console.log("| tag | … |\n| --- | … |")`. Recording it as two lines would add a byte.
		expect(renderLines(["| tag |\n| --- |"])).toBe("| tag |\n| --- |\n")
	})

	test("a bare console.log() is the empty string, and still a newline", () => {
		expect(renderLines([""])).toBe("\n")
		expect(renderLines(["a", "", "b"])).toBe("a\n\nb\n")
	})

	test("no records is no bytes — a skipped leg writes an empty file, not a stray newline", () => {
		expect(renderLines([])).toBe("")
	})

	test("a leading newline in the argument is preserved verbatim", () => {
		// Several probes open a section with `console.log("\nbare failures:")`.
		expect(renderLines(["\nbare failures:"])).toBe("\nbare failures:\n")
	})

	test("concatenating two sinks reproduces `${stdout}${stderr}`", () => {
		// de-order, arena and fr-recall each merged both streams into one .md, in that order.
		expect(renderLines(["out"]) + renderLines(["err"])).toBe("out\nerr\n")
	})
})

/**
 * How a leg's failure reaches the runner, and what the check does about it. Each row is the behavior the child-process
 * spawn had; the migration must not change any of them.
 */
const LEG_SEMANTICS = [
	{
		leg: "per-locale-f1",
		spawn: "$ (throws on non-zero)",
		onFailure: "propagates — aborts the check",
		artifact: "<tag>-per-locale.md",
		mergesStderr: false,
		call: perLocaleF1,
	},
	{
		leg: "score-affix ×6",
		spawn: "$ (throws on non-zero)",
		onFailure: "propagates — aborts the check",
		artifact: "<tag>-{affix,unit,pobox,intersection,watch-intersection-vt,watch-glue}.md",
		mergesStderr: false,
		call: scoreAffix,
	},
	{
		leg: "score-country-homograph",
		spawn: "$ (throws on non-zero)",
		onFailure: "propagates — aborts the check",
		artifact: "<tag>-country.md",
		mergesStderr: false,
		call: scoreCountryHomograph,
	},
	{
		leg: "de-order-eval",
		spawn: "$({ nothrow })",
		onFailure: "tolerated — check continues, exit code never read",
		artifact: "<tag>-deorder.md",
		mergesStderr: true,
		call: deOrderEval,
	},
	{
		leg: "demo-cascade-smoke",
		spawn: "$({ nothrow })",
		onFailure: "tolerated — check logs and continues; a floored spec FAILs on the missing sidecar",
		artifact: "cascade-smoke.md",
		mergesStderr: false,
		call: demoCascadeSmoke,
	},
	{
		leg: "external-arenas",
		spawn: "$({ nothrow })",
		onFailure: "non-zero ABORTS the check (return 1) before the verdict",
		artifact: "arenas.md",
		mergesStderr: true,
		call: externalArenas,
	},
	{
		leg: "fr-parse-recall",
		spawn: "$({ nothrow, env: childEnv() })",
		onFailure: "non-zero ABORTS the check (return 1) — the floor verdict",
		artifact: "fr-bare-street.md",
		mergesStderr: true,
		call: frParseRecall,
	},
] as const

describe("error semantics — the per-leg table", () => {
	test("all eight former spawns are accounted for", () => {
		// Eight spawns, seven distinct modules: score-affix carried six of the call sites.
		expect(LEG_SEMANTICS).toHaveLength(7)
		expect(LEG_SEMANTICS.filter((row) => row.spawn.includes("nothrow"))).toHaveLength(4)
	})

	test("every leg is a callable module, not a command string", () => {
		for (const row of LEG_SEMANTICS) {
			expect(typeof row.call, row.leg).toBe("function")
		}
	})

	test("the legs that merge stderr into their .md declare a SECOND sink", () => {
		// A module that merges must accept (options, report, reportError); one that does not may take
		// only (options, report). `Function.length` cannot see this — every one of these parameters has a
		// default, which zeroes it — so the check reads the declaration instead. Crude, but it fails
		// loudly if someone drops the error sink, and losing it would silently halve a merged .md.
		for (const row of LEG_SEMANTICS) {
			if (!row.mergesStderr) continue

			expect(row.call.toString(), `${row.leg} must accept an error sink`).toMatch(/\breportError\b/)
		}
	})

	test("the two legs that abort the check are the arena and the FR floor", () => {
		const aborting = LEG_SEMANTICS.filter((row) => row.onFailure.includes("ABORTS")).map((row) => row.leg)

		expect(aborting).toEqual(["external-arenas", "fr-parse-recall"])
	})

	test("every leg names the artifact the verdict assembler reads", () => {
		for (const row of LEG_SEMANTICS) {
			expect(row.artifact, row.leg).toMatch(/\.md$/)
		}
	})
})
