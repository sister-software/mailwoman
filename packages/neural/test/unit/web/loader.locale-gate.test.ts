import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { PairIndexResolver, serializePairIndex, type PairIndexHeaderInput } from "@mailwoman/neural/pair"
import { detectPairIndexCountry, type LoadedPairIndex, resolvePairIndexForText } from "@mailwoman/neural/web-loader"
import type { PathBuilder } from "path-ts"
import { TextSpliterator } from "spliterator"
import { Globerator } from "spliterator/node/fs"
import { describe, expect, test } from "vitest"

const browserSafePackageRoots = {
	"locale-hint": resolvePackageDirectory("@mailwoman/locale-hint"),
	"query-shape": resolvePackageDirectory("@mailwoman/query-shape"),
} as const

async function sourceFiles(dir: PathBuilder): Promise<PathBuilder[]> {
	const out: PathBuilder[] = []

	for await (const entry of Globerator.from("*", { cwd: dir, withFileTypes: true, onlyFiles: false })) {
		if (entry.name === "out" || entry.name === "node_modules") continue
		const full = dir(entry.name)

		if (entry.isDirectory()) {
			out.push(...(await sourceFiles(full)))
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full)
		}
	}

	return out
}

function isRuntimeImportLine(line: string): boolean {
	const trimmed = line.trim()

	if (!/\bfrom\s+["']/.test(trimmed)) return false

	if (!/^(import|export)\b/.test(trimmed)) return false

	return !/^(import|export)\s+type\b/.test(trimmed)
}

function specifierOf(line: string): string {
	return /from\s+["']([^"']+)["']/.exec(line)?.[1] ?? ""
}

describe("Browser-safe locale packages exclude Node dependencies", () => {
	for (const pkg of ["locale-hint", "query-shape"]) {
		test(`@mailwoman/${pkg} omits Node runtime imports from its transitive source`, async () => {
			const files = await sourceFiles(browserSafePackageRoots[pkg as keyof typeof browserSafePackageRoots])

			expect(files.length).toBeGreaterThan(0)
			const offenders: string[] = []

			for (const file of files) {
				const text = await readLocalTextFile(file)

				if (/\brequire\s*\(/.test(text) || /\bprocess\.\w/.test(text) || /\b__dirname\b|\b__filename\b/.test(text)) {
					offenders.push(`${file}: bare node global (require/process/__dirname)`)
				}

				for (const line of TextSpliterator.from(text)) {
					if (!isRuntimeImportLine(line)) continue
					const spec = specifierOf(line)

					if (
						spec.startsWith("node:") ||
						["fs", "path", "os", "crypto", "url", "child_process", "worker_threads"].includes(spec)
					) {
						offenders.push(`${file}: runtime import of "${spec}"`)
					}

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
		expect(detectPairIndexCountry("Shoreditch London")).toBe("us")
	})
})

function indexFor(country: string): LoadedPairIndex {
	const header: PairIndexHeaderInput = {
		country,
		delta: 5,
		foldVersion: 1,
		sourceMD5s: [],
		buildDate: "2026-07-24",
	}

	const bytes = serializePairIndex(header, [
		{ child: "shoreditch", parent: "london", tag: "dependent_locality", parentTag: "locality" },
	])

	return { url: `https://cdn.example/pair-index-${country}.bin`, country, resolver: new PairIndexResolver(bytes) }
}

describe("resolvePairIndexForText — per-parse selection among the loaded indexes", () => {
	const gb = indexFor("gb")
	const us = indexFor("us")
	const loaded = [gb, us]

	test("GB text selects the gb index; the returned opt is `{ index }` alone (probe chain 'auto', header carries delta/beta)", () => {
		const opt = resolvePairIndexForText(loaded, "10 Downing Street, London SW1A 2AA")

		expect(opt).toEqual({ index: gb.resolver })
		expect(opt!.index).toBe(gb.resolver)
	})

	test("US text selects the us index", () => {
		expect(resolvePairIndexForText(loaded, "350 5th Ave, New York, NY 10118")).toEqual({ index: us.resolver })
	})

	test("A detected country with NO loaded index → undefined (byte-stable no-prior)", () => {
		expect(resolvePairIndexForText(loaded, "東京都千代田区丸の内1-9-1")).toBeUndefined()

		expect(resolvePairIndexForText([gb], "350 5th Ave, New York, NY 10118")).toBeUndefined()
	})

	test("The explicit { country } override bypasses detection (pins a posture the text shape can't reveal)", () => {
		expect(resolvePairIndexForText(loaded, "Shoreditch London", { country: "en-gb" })).toEqual({ index: gb.resolver })
		expect(resolvePairIndexForText(loaded, "Shoreditch London", { country: "gb" })).toEqual({ index: gb.resolver })
	})

	test("No indexes loaded → undefined regardless of text", () => {
		expect(resolvePairIndexForText([], "10 Downing Street, London SW1A 2AA")).toBeUndefined()
		expect(resolvePairIndexForText([], "Shoreditch London", { country: "en-gb" })).toBeUndefined()
	})
})
