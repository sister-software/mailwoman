/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   No code here loads a model, so this layer runs in CI.
 *   `renderLines` must reproduce a child's stdout byte-for-byte.
 *   Per-leg error handling must match the previous child processes.
 */

import { describe, expect, test } from "vitest"

import { deOrderEval } from "#tools/eval-harness/de-order-eval"
import { demoCascadeSmoke } from "#tools/eval-harness/demo/cascade/smoke"
import { externalArenas } from "#tools/eval-harness/external-arenas"
import { frParseRecall } from "#tools/eval-harness/fr-parse-recall"
import { perLocaleF1 } from "#tools/eval-harness/per/locale-f1"
import { renderLines } from "#tools/eval-harness/promotion/eval"
import { scoreAffix } from "#tools/eval-harness/score/affix"
import { scoreCountryHomograph } from "#tools/eval-harness/score/country-homograph"

describe("renderLines — child stdout parity", () => {
	test("one record per console.log call, each with its trailing newline", () => {
		expect(renderLines(["a", "b"])).toBe("a\nb\n")
	})

	test("a multi-line argument stays ONE record and gains ONE newline", () => {
		// score-affix prints its table header in one call containing an embedded newline,
		// so recording it as two lines would add a byte.
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
		expect(renderLines(["\nbare failures:"])).toBe("\nbare failures:\n")
	})

	test("concatenating two sinks reproduces `${stdout}${stderr}`", () => {
		// de-order, arena and fr-recall each merged both streams into one .md, in that order.
		expect(renderLines(["out"]) + renderLines(["err"])).toBe("out\nerr\n")
	})
})

/**
 * Each row records behavior from the former child process.
 * The migration must preserve it.
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
		// Eight spawns, seven distinct modules: score-affix accounted for six of the call sites.
		expect(LEG_SEMANTICS).toHaveLength(7)
		expect(LEG_SEMANTICS.filter((row) => row.spawn.includes("nothrow"))).toHaveLength(4)
	})

	test("every leg is a callable module, not a command string", () => {
		for (const row of LEG_SEMANTICS) {
			expect(typeof row.call, row.leg).toBe("function")
		}
	})

	test("the legs that merge stderr into their .md declare a SECOND sink", () => {
		// `Function.length` cannot see a `reportError` parameter that has a default,
		// so the check reads the declaration and fails loudly if someone drops the error sink.
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
