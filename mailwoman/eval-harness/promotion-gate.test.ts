/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for the promotion gate's spec resolution.
 *
 *   The `--gate` help has always said "a path, or a spec name resolved against eval-harness/gates/".
 *   The resolver never appended `.json`, so `--gate v5.3.0-family` — the spec NAME, exactly as
 *   advertised — fell through to `readFileSync("v5.3.0-family")` and died on a bare ENOENT naming a
 *   file nobody asked for. Cost: one confused re-run on 2026-07-16, mid gate battery.
 */

import { existsSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { listGateSpecs, resolveGateSpecPath } from "./promotion-gate.ts"

describe("listGateSpecs", () => {
	it("finds the shipped specs", () => {
		const specs = listGateSpecs()

		expect(specs.length).toBeGreaterThan(0)
		expect(specs).toContain("v5.3.0-family.json")

		for (const spec of specs) {
			expect(spec.endsWith(".json")).toBe(true)
		}
	})
})

describe("resolveGateSpecPath", () => {
	it("resolves a bare spec NAME — what the help advertises and what people type", () => {
		const path = resolveGateSpecPath("v5.3.0-family")

		expect(existsSync(path)).toBe(true)
		expect(path).toContain("v5.3.0-family.json")
	})

	it("resolves a spec name that already carries .json", () => {
		const path = resolveGateSpecPath("v5.3.0-family.json")

		expect(existsSync(path)).toBe(true)
	})

	it("resolves by basename, so legacy scripts/eval/gates/<spec>.json invocations keep working", () => {
		const path = resolveGateSpecPath("scripts/eval/gates/v5.3.0-family.json")

		expect(existsSync(path)).toBe(true)
	})

	it("prefers a real path verbatim", () => {
		const real = "mailwoman/eval-harness/gates/v5.3.0-family.json"

		expect(resolveGateSpecPath(real)).toBe(real)
	})

	it("throws a USEFUL error naming the known specs, not a bare ENOENT", () => {
		// The old behaviour returned the string and let readFileSync throw, which told the operator
		// nothing about what they could have typed instead.
		expect(() => resolveGateSpecPath("v9.9.9-nope")).toThrow(/Gate spec not found.*Known specs.*v5\.3\.0-family/s)
	})
})
