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

import { existsSync, readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { listGateSpecs, resolveGateSpecPath } from "./promotion-gate.ts"

/**
 * Minimal npm-`files`-glob matcher (`**` crosses directories, `*` stays in one), segment-based so no dynamic RegExp is
 * ever constructed. The package.json globs use no character classes or braces, so this covers the whole array — a
 * fuller matcher would be a dependency for nothing.
 */
function filesGlobMatches(pattern: string, path: string): boolean {
	const segments = pattern.split("/")
	const parts = path.split("/")

	const matchFrom = (si: number, pi: number): boolean => {
		for (let s = si, p = pi; ; s++, p++) {
			const segment = segments[s]

			if (segment === "**") {
				// `**` consumes zero or more whole path segments; try every split.
				for (let skip = p; skip <= parts.length; skip++) {
					if (matchFrom(s + 1, skip)) return true
				}

				return false
			}

			if (segment === undefined) return p === parts.length

			if (p >= parts.length || !segmentMatches(segment, parts[p]!)) return false
		}
	}

	return matchFrom(0, 0)
}

/** One path segment against one glob segment — `*` matches any in-segment run, everything else is literal. */
function segmentMatches(glob: string, segment: string): boolean {
	const pieces = glob.split("*")
	let at = 0

	for (let i = 0; i < pieces.length; i++) {
		const piece = pieces[i]!

		if (piece === "") continue
		const found = segment.indexOf(piece, at)

		if (found < 0) return false

		// A literal after the leading `*` may start anywhere; a leading literal must anchor at 0.
		if (i === 0 && found !== 0) return false
		at = found + piece.length
	}

	// A trailing literal must anchor the end ("*.json" matches "a.json", not "a.json.bak").
	const last = pieces[pieces.length - 1]!

	return last === "" || segment.endsWith(last)
}

/** Whether `path` (package-root-relative) ships in the tarball per package.json `files` (negations applied in order). */
function shipsInPackage(files: string[], path: string): boolean {
	let included = false

	for (const pattern of files) {
		if (pattern.startsWith("!")) {
			if (filesGlobMatches(pattern.slice(1), path)) {
				included = false
			}
		} else if (filesGlobMatches(pattern, path)) {
			included = true
		}
	}

	return included
}

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

	it("SHIPS every resolvable spec in the npm tarball — an installed CLI resolves the shorthand too (#1056)", () => {
		// The source-tree fix alone left the packaged CLI broken: `files` covered only `**/*.ts` + `out/**`,
		// and tsc does not emit readFileSync'd JSON, so the tarball carried ZERO gate specs and the
		// installed `mailwoman eval gate --gate <name>` found an empty gates dir.
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] }

		for (const spec of listGateSpecs()) {
			const rel = `eval-harness/gates/${spec}`
			expect(shipsInPackage(pkg.files, rel), `${rel} must be covered by package.json files`).toBe(true)
		}

		// baselines.json resolves through the same source-tree-fallback pattern (baseline-assert.ts).
		expect(shipsInPackage(pkg.files, "eval-harness/baselines.json")).toBe(true)
	})
})
