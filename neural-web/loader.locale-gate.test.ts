/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #1278 phase 2 — the browser-side per-parse country selection. Two concerns, no ORT/classifier mock
 *   needed (the units under test are pure):
 *
 *   1. BROWSER-SAFETY SCOPE (the hard gate): the two Stage-2 modules the loader now imports —
 *      `@mailwoman/locale-gate` + `@mailwoman/query-shape` — must be free of any `node:*` / fs / path /
 *      process runtime import across their FULL non-test source, or they'd break the browser bundle. A
 *      static scan of the shipped source asserts it (a type-only re-export of `@mailwoman/core/pipeline`
 *      erases at compile and is explicitly allowed).
 *
 *   2. PER-PARSE SELECTION: `detectPairIndexCountry` maps an input's STRUCTURAL shape to a country subtag
 *      (postcode format / script only — never place names), and `resolvePairIndexForText` selects the
 *      loaded index whose header country matches (or the explicit `{ country }` override), returning the
 *      byte-stable `undefined` on no match.
 */

import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { PairIndexResolver, serializePairIndex, type PairIndexHeader } from "@mailwoman/neural/browser"
import { describe, expect, test } from "vitest"

import { detectPairIndexCountry, type LoadedPairIndex, resolvePairIndexForText } from "./loader.ts"

const here = dirname(fileURLToPath(import.meta.url))

// ── Browser-safety scope ─────────────────────────────────────────────────────────────────────────────

/** Every non-test `.ts` under `dir`, recursively (the runtime source the browser bundle would pull). */
function sourceFiles(dir: string): string[] {
	const out: string[] = []

	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "out" || entry.name === "node_modules") continue
		const full = join(dir, entry.name)

		if (entry.isDirectory()) {
			out.push(...sourceFiles(full))
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full)
		}
	}

	return out
}

/** A runtime `import`/`export … from` line (not a `type`-only one, which erases). */
function isRuntimeImportLine(line: string): boolean {
	const trimmed = line.trim()

	if (!/\bfrom\s+["']/.test(trimmed)) return false

	if (!/^(import|export)\b/.test(trimmed)) return false

	// `import type … ` / `export type … ` erase entirely — not a runtime import.
	return !/^(import|export)\s+type\b/.test(trimmed)
}

/** The module specifier of an import/export-from line. */
function specifierOf(line: string): string {
	return /from\s+["']([^"']+)["']/.exec(line)?.[1] ?? ""
}

describe("browser-safety scope — locale-gate + query-shape are node-free (#1278 hard gate)", () => {
	for (const pkg of ["locale-gate", "query-shape"]) {
		test(`@mailwoman/${pkg}: no node:* / fs / path / process runtime import in the transitive source`, () => {
			const files = sourceFiles(join(here, "..", pkg))

			expect(files.length).toBeGreaterThan(0)
			const offenders: string[] = []

			for (const file of files) {
				const text = readFileSync(file, "utf8")

				// Named node builtins must never appear as a value in browser-portable source.
				if (/\brequire\s*\(/.test(text) || /\bprocess\.\w/.test(text) || /\b__dirname\b|\b__filename\b/.test(text)) {
					offenders.push(`${file}: bare node global (require/process/__dirname)`)
				}

				for (const line of text.split("\n")) {
					if (!isRuntimeImportLine(line)) continue
					const spec = specifierOf(line)

					if (
						spec.startsWith("node:") ||
						["fs", "path", "os", "crypto", "url", "child_process", "worker_threads"].includes(spec)
					) {
						offenders.push(`${file}: runtime import of "${spec}"`)
					}

					// A VALUE import of @mailwoman/core would drag the ~9MB data package into the bundle;
					// only a type-only re-export (erased) is allowed.
					if (spec.startsWith("@mailwoman/core")) {
						offenders.push(
							`${file}: runtime import of "${spec}" (only \`export type\`/\`import type\` is browser-safe)`
						)
					}
				}
			}

			expect(offenders).toEqual([])
		})
	}
})

// ── Per-parse country detection ──────────────────────────────────────────────────────────────────────

describe("detectPairIndexCountry — structural country from the input shape", () => {
	test("a UK postcode drives a gb detection", () => {
		expect(detectPairIndexCountry("10 Downing Street, London SW1A 2AA")).toBe("gb")
		expect(detectPairIndexCountry("221B Baker Street, London NW1 6XE")).toBe("gb")
	})

	test("a US ZIP drives a us detection", () => {
		expect(detectPairIndexCountry("350 5th Ave, New York, NY 10118")).toBe("us")
	})

	test("a Canadian postcode drives a ca detection", () => {
		expect(detectPairIndexCountry("100 Queen St W, Toronto, ON M5H 2N2")).toBe("ca")
	})

	test("CJK script drives a jp detection", () => {
		expect(detectPairIndexCountry("東京都千代田区丸の内1-9-1")).toBe("jp")
	})

	test("bitter-lesson-safe: a bare place name with NO postcode is NOT read as gb — it falls through to the us fallback", () => {
		// locale-gate keys off structural cues (postcode/script) only, never place-name dictionaries, so
		// "Shoreditch London" — a real GB dependent_locality/locality pair — detects `us`, not `gb`. The pair
		// prior is additive, so a conservative miss (no bias) is the safe failure mode; a caller who KNOWS the
		// posture uses the `{ country }` override on resolvePairIndexForText.
		expect(detectPairIndexCountry("Shoreditch London")).toBe("us")
	})
})

// ── Per-parse index selection ────────────────────────────────────────────────────────────────────────

function indexFor(country: string): LoadedPairIndex {
	const header: PairIndexHeader = {
		country,
		delta: 5,
		schemaVersion: 1,
		foldVersion: 1,
		sourceMD5s: [],
		buildDate: "2026-07-24",
	}
	const bytes = serializePairIndex(header, [{ child: "shoreditch", parent: "london", tag: "dependent_locality" }])

	return { url: `https://cdn.example/pair-index-${country}.bin`, country, resolver: new PairIndexResolver(bytes) }
}

describe("resolvePairIndexForText — per-parse selection among the loaded indexes", () => {
	const gb = indexFor("gb")
	const us = indexFor("us")
	const loaded = [gb, us]

	test("GB text selects the gb index; the returned opt is `{ index }` alone (probe chain 'auto', header carries delta/beta)", () => {
		const opt = resolvePairIndexForText(loaded, "10 Downing Street, London SW1A 2AA")

		expect(opt).toEqual({ index: gb.resolver })
		expect(opt!.index).toBe(gb.resolver) // the SAME retained instance, not a copy
	})

	test("US text selects the us index", () => {
		expect(resolvePairIndexForText(loaded, "350 5th Ave, New York, NY 10118")).toEqual({ index: us.resolver })
	})

	test("a detected country with NO loaded index → undefined (byte-stable no-prior)", () => {
		// CJK detects `jp`, but only gb + us are loaded → no bias.
		expect(resolvePairIndexForText(loaded, "東京都千代田区丸の内1-9-1")).toBeUndefined()
		// gb-only load, US input → no us index → undefined.
		expect(resolvePairIndexForText([gb], "350 5th Ave, New York, NY 10118")).toBeUndefined()
	})

	test("the explicit { country } override bypasses detection (pins a posture the text shape can't reveal)", () => {
		// "Shoreditch London" detects `us`; the override forces the gb pick.
		expect(resolvePairIndexForText(loaded, "Shoreditch London", { country: "en-gb" })).toEqual({ index: gb.resolver })
		expect(resolvePairIndexForText(loaded, "Shoreditch London", { country: "gb" })).toEqual({ index: gb.resolver })
	})

	test("no indexes loaded → undefined regardless of text", () => {
		expect(resolvePairIndexForText([], "10 Downing Street, London SW1A 2AA")).toBeUndefined()
		expect(resolvePairIndexForText([], "Shoreditch London", { country: "en-gb" })).toBeUndefined()
	})
})
