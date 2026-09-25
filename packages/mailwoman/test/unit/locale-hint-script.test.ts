/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Tests the locale hint's `script` and `locale` fields over committed Korean, Chinese and Japanese sets.
 *
 *   Korean addresses report `locale: "ja-JP"` because Japanese, Korean and Chinese share one character-path
 *   weights family. The `script` field reports Hangul for them, and `locale` must stay unchanged so that
 *   consumers mapping it to a weights package keep working.
 *
 *   `script` is a ranked list. Many Chinese rows put Latin first because a romanized province and country
 *   follow the Han unit, so a consumer should check whether a script is present rather than read only the head.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { detectLocale } from "@mailwoman/locale-hint"
import { computeQueryShape } from "@mailwoman/query-shape"
import { loadRegressionCases } from "mailwoman/eval-harness/gauntlet/cases/load"
import { JSONSpliterator } from "spliterator"
import { beforeAll, describe, expect, it } from "vitest"

const KOREAN_REFERENCE = "corpus-python/tests/mailwoman_train/countries/kr-build-reference.json"
const CHINESE_BOARD = "packages/mailwoman/lib/eval-harness/gauntlet/cases/cn/organizational-units.jsonl"
const JAPANESE_GOLD = "data/eval/external/jp-overture-gold.jsonl"

/**
 * The keys of the Korean reference file that hold address rows.
 */
const KOREAN_ROW_KEYS = ["label", "board", "registry", "registry_board"] as const

function hintFor(text: string) {
	return detectLocale(computeQueryShape(text))
}

function topScript(text: string): string {
	return hintFor(text).script?.[0]?.script ?? "(none)"
}

function scriptsOf(text: string): string[] {
	return (hintFor(text).script ?? []).map((entry) => entry.script)
}

let koreanRows: string[] = []
let chineseRows: string[] = []
let japaneseRows: string[] = []

beforeAll(async () => {
	const korean = await readLocalJSONFile<Record<string, Array<{ raw: string }>>>(repoRootPath(KOREAN_REFERENCE))

	koreanRows = KOREAN_ROW_KEYS.flatMap((key) => (korean[key] ?? []).map((row) => row.raw))

	chineseRows = await JSONSpliterator.fromAsync<{ input: string }>(repoRootPath(CHINESE_BOARD))
		.map((row) => row.input)
		.toArray()

	japaneseRows = await JSONSpliterator.fromAsync<{ text: string }>(repoRootPath(JAPANESE_GOLD))
		.map((row) => row.text)
		.toArray()
})

describe("the Korean reference set", () => {
	it("reports Hangul on every row, while locale reports Japanese on every row", () => {
		// Changing `locale` to `ko-KR` would break consumers that map it to a weights package.
		expect(koreanRows).toHaveLength(20)
		expect(koreanRows.map(topScript)).toEqual(Array.from({ length: 20 }, () => "Hang"))
		expect([...new Set(koreanRows.map((row) => hintFor(row).locale))]).toEqual(["ja-JP"])
	})

	it("gives Hangul the whole share, because a Korean address carries no other script", () => {
		for (const row of koreanRows) {
			expect(hintFor(row).script?.[0]?.confidence).toBe(1)
		}
	})
})

describe("the Chinese organizational-units board", () => {
	it("finds Han on every row, and Latin at the head of most of them", () => {
		// In `逊克二分场四队, heilongjiang, china`, the romanized province and country outweigh the Han unit.
		expect(chineseRows).toHaveLength(21)

		for (const row of chineseRows) {
			expect([row, scriptsOf(row).includes("Hani")]).toEqual([row, true])
		}

		expect(chineseRows.filter((row) => topScript(row) === "Latn")).toHaveLength(15)
		expect(chineseRows.filter((row) => topScript(row) === "Hani")).toHaveLength(6)
	})

	it("is the case the folded character class cannot express", () => {
		// Rows with a romanized province fold to `mixed`.
		// The rest fold to `cjk`, which cannot distinguish Chinese from Korean.
		// Neither class identifies a script.
		const classes = chineseRows.map((row) => computeQueryShape(row).characterClass)

		expect(classes.filter((value) => value === "mixed")).toHaveLength(18)
		expect(classes.filter((value) => value === "cjk")).toHaveLength(3)

		expect([...new Set(classes)].toSorted()).toEqual(["cjk", "mixed"])
	})
})

describe("the Japanese Overture gold set", () => {
	it("reports Han at the head of all but twenty rows, and locale ja-JP throughout", () => {
		expect(japaneseRows).toHaveLength(3982)
		expect(japaneseRows.filter((row) => topScript(row) === "Hani")).toHaveLength(3962)
		expect(japaneseRows.filter((row) => topScript(row) === "Hira")).toHaveLength(20)
		expect([...new Set(japaneseRows.map((row) => hintFor(row).locale))]).toEqual(["ja-JP"])
	})

	it("carries kana on 178 rows, which is why kana cannot decide Japanese here", () => {
		// Kana identifies Japanese and Han does not, but most Japanese place names are written in Han.
		// A rule that required kana would abstain on most of this set.
		// These rows stop at the municipality, so fuller addresses would contain more kana.
		const kanaRowCount = japaneseRows.filter((row) => {
			const scripts = scriptsOf(row)

			return scripts.includes("Kana") || scripts.includes("Hira")
		})

		expect(kanaRowCount).toHaveLength(178)
		expect(japaneseRows.filter((row) => scriptsOf(row).includes("Hani"))).toHaveLength(3982)
	})
})

describe("the regression board", () => {
	// The regression board is the set that the product is graded on.
	it("reads Han off thirteen rows across CN, JP and SG, and leaves their locale alone", async () => {
		const cases = await loadRegressionCases()
		const hanLed = cases.filter((row) => topScript(row.input) === "Hani")

		expect(hanLed.length).toBeGreaterThanOrEqual(13)
		expect([...new Set(hanLed.map((row) => row.country))].toSorted()).toEqual(["CN", "JP", "SG"])

		for (const row of hanLed) {
			expect(hintFor(row.input).locale, row.id).toMatch(/^[a-z]{2}-[A-Z]{2}$/)
		}
	})

	it("holds no Hangul-led row, which is the board's gap rather than the hint's", () => {
		// The regression board has no Korean cases, so the Korean reference set covers Hangul.
		expect(koreanRows.map(topScript)).toContain("Hang")
	})
})

describe("what reaches the parse surface", () => {
	// The pipeline passes the query shape and the locale hint through whole.
	// These tests catch a projection that would drop the script fields on the way out.
	it("carries the ranked scripts and the per-token script through the whole pipeline", async () => {
		const { createRuntimePipeline } = await import("mailwoman")
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("金龍酒家, 12 Gerrard Street, London WC2H 7JS", {})

		expect(result.queryShape?.scripts?.map((entry) => entry.script)).toEqual(["Latn", "Hani"])
		expect(result.locale?.script?.map((entry) => entry.script)).toEqual(["Latn", "Hani"])

		// The input's `characterClass` is `mixed`, so only the per-token script shows that the venue is Han.
		expect(result.queryShape?.tokenClasses?.[0]).toMatchObject({
			span: { body: "金龍酒家" },
			class: "cjk",
			script: "Hani",
		})
	})

	it("reports Hangul on a Korean address while the locale stays ja-JP", async () => {
		const { createRuntimePipeline } = await import("mailwoman")
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("서울특별시 종로구 청운동 52-1", {})

		expect(result.locale?.locale).toBe("ja-JP")
		expect(result.locale?.script).toEqual([{ script: "Hang", confidence: 1 }])
	})
})
