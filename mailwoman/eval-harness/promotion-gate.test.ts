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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { describe, expect, it } from "vitest"

import { listGateSpecs, resolveGateSpecPath, runPromotionGate } from "./promotion-gate.ts"

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

/**
 * One path segment against one glob segment — `*` matches any in-segment run, everything else is literal.
 */
function segmentMatches(glob: string, segment: string): boolean {
	const pieces = glob.split("*")
	let at = 0

	for (let i = 0; i < pieces.length; i++) {
		const piece = pieces[i]!

		if (piece === "") continue
		const found = segment.indexOf(piece, at)

		if (found === -1) return false

		// A literal after the leading `*` may start anywhere; a leading literal must anchor at 0.
		if (i === 0 && found !== 0) return false
		at = found + piece.length
	}

	// A trailing literal must anchor the end ("*.json" matches "a.json", not "a.json.bak").
	const last = pieces.at(-1)!

	return last === "" || segment.endsWith(last)
}

/**
 * Whether `path` (package-root-relative) ships in the tarball per package.json `files` (negations applied in order).
 */
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
		const pkg = parseJSONStrict<{ files: string[] }>(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

		for (const spec of listGateSpecs()) {
			const rel = `eval-harness/gates/${spec}`
			expect(shipsInPackage(pkg.files, rel), `${rel} must be covered by package.json files`).toBe(true)
		}

		// baselines.json resolves through the same source-tree-fallback pattern (baseline-assert.ts).
		expect(shipsInPackage(pkg.files, "eval-harness/baselines.json")).toBe(true)
	})
})

describe("paired weights-caches (#47)", () => {
	/**
	 * Lay out a fake package-shaped weights cache: `<root>/node_modules/@mailwoman/neural-weights-en-us/` with a
	 * model.onnx whose bytes do (int8) or don't (fp32) carry the DynamicQuantizeLinear needle the provenance guard scans
	 * for, plus the tokenizer + card the pre-battery reads touch. Every guard under test returns exit 2 BEFORE any
	 * battery, so no real ONNX is ever loaded.
	 */
	function stageFakeCache(kind: "fp32" | "int8", salt: string): string {
		const root = mkdtempSync(join(tmpdir(), `gate-pair-${kind}-`))
		const pkg = join(root, "node_modules", "@mailwoman", "neural-weights-en-us")

		mkdirSync(pkg, { recursive: true })

		writeFileSync(
			join(pkg, "model.onnx"),
			kind === "int8" ? `fake-onnx ${salt}\nDynamicQuantizeLinear\n` : `fake-onnx ${salt}\n`
		)

		writeFileSync(join(pkg, "tokenizer.model"), "fake-tokenizer")
		writeFileSync(join(pkg, "model-card.json"), JSON.stringify({ training: { tokenizer_version: "v0.6.0-a0" } }))

		return root
	}

	it("refuses --int8-weights-cache without --weights-cache", async () => {
		const int8 = stageFakeCache("int8", "a")

		expect(await runPromotionGate({ gate: "v9.0.0-base", int8WeightsCache: int8 })).toBe(2)
	})

	it("refuses --int8-weights-cache alongside the --model/--int8 flow", async () => {
		const wc = stageFakeCache("fp32", "b")
		const int8 = stageFakeCache("int8", "c")

		expect(
			await runPromotionGate({ gate: "v9.0.0-base", weightsCache: wc, int8WeightsCache: int8, model: "x.onnx" })
		).toBe(2)
	})

	it("refuses a paired fp32 arm that carries quant nodes — the arms are swapped or mislabeled", async () => {
		const wc = stageFakeCache("int8", "d")
		const int8 = stageFakeCache("int8", "e")
		const outDir = mkdtempSync(join(tmpdir(), "gate-pair-out-"))

		expect(await runPromotionGate({ gate: "v9.0.0-base", weightsCache: wc, int8WeightsCache: int8, outDir })).toBe(2)
	})

	it("refuses a paired int8 arm with no quant nodes", async () => {
		const wc = stageFakeCache("fp32", "f")
		const int8 = stageFakeCache("fp32", "g")
		const outDir = mkdtempSync(join(tmpdir(), "gate-pair-out-"))

		expect(await runPromotionGate({ gate: "v9.0.0-base", weightsCache: wc, int8WeightsCache: int8, outDir })).toBe(2)
	})

	it("refuses byte-identical paired arms", async () => {
		const wc = stageFakeCache("int8", "h")
		const int8 = stageFakeCache("int8", "h")
		const outDir = mkdtempSync(join(tmpdir(), "gate-pair-out-"))

		// Same salt, same bytes: dql alone cannot tell them apart, the md5 identity check must.
		const swapped = await runPromotionGate({ gate: "v9.0.0-base", weightsCache: wc, int8WeightsCache: int8, outDir })

		expect(swapped).toBe(2)
	})
})
