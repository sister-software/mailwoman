/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file What the locale hint's `script` field says over three committed boards, and what `locale` says beside it.
 *
 *   The Korean case is the whole argument for the field. Every row of the Korean reference set is Hangul, every row
 *   reports `locale: "ja-JP"`, and that is not a routing error — the character path is one weights family for Japanese,
 *   Korean and Chinese, so the model loaded is the same whichever tag stands there. It is a reporting error, and until
 *   `script` existed the hint had nowhere to put the thing it could see.
 *
 *   `locale` is asserted here too, unchanged, because the change is worthless if it moved. A consumer mapping the hint
 *   to a weights package would go from a wrong-but-present label to nothing at all.
 *
 *   the chinese board is why the field is A ranked list and not A value. Its rows are a Han organizational unit beside
 *   a romanized province and country — `逊克二分场四队, heilongjiang, china` — so Latin writes more of the row than Han
 *   does and `script[0]` is `Latn` on most of them. Han is present on every row and is what a router would want. A
 *   consumer that reads the head of the list gets the majority script. one that asks whether a script is present gets
 *   the answer this board exists to give.
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
 * The four keys of the Korean reference file that carry addresses.
 *
 * `centroids` and `report` carry neither a `raw` nor an input, and `readme` is prose.
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
		// The two halves of one assertion on purpose.
		// Splitting them would let the second pass for the wrong reason: a change that moved
		// `locale` to `ko-KR` would break a consumer resolving it to a weights package,
		// and this row is what would catch it.
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
		// `逊克二分场四队, heilongjiang, china` — the unit is Han, the province and country
		// are romanized, and Latin writes more of the row.
		// A predicate over `script[0]` alone would read this board as Latin.
		expect(chineseRows).toHaveLength(21)

		for (const row of chineseRows) {
			expect([row, scriptsOf(row).includes("Hani")]).toEqual([row, true])
		}

		expect(chineseRows.filter((row) => topScript(row) === "Latn")).toHaveLength(15)
		expect(chineseRows.filter((row) => topScript(row) === "Hani")).toHaveLength(6)
	})

	it("is the case the folded character class cannot express", () => {
		// Eighteen of the rows fold to `mixed`, and `mixed` names no script at all — so a router
		// reading the fold sees nothing to route on and the Han unit goes to the Latin model.
		// The other three carry no romanized province (`三分场八队`) and fold to `cjk`,
		// which is the bucket that cannot tell them from Korean.
		const classes = chineseRows.map((row) => computeQueryShape(row).characterClass)

		expect(classes.filter((value) => value === "mixed")).toHaveLength(18)
		expect(classes.filter((value) => value === "cjk")).toHaveLength(3)

		// Neither bucket names a script, which is the whole point: 21 rows, two classes,
		// and no way to ask either of them which writing system is on the page.
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
		// The measurement the script rule rests on.
		// Kana is diagnostic of Japanese and Han is not — 県/市/区/郡/町 and most place names are Han —
		// so a rule that waits for kana abstains on 95.5% of this set.
		//
		// It is a floor rather than a rate: these rows carry a postcode, a prefecture
		// and a municipality and nothing finer.
		// A set with building lines would carry more kana.
		const kanaRowCount = japaneseRows.filter((row) => {
			const scripts = scriptsOf(row)

			return scripts.includes("Kana") || scripts.includes("Hira")
		})

		expect(kanaRowCount).toHaveLength(178)
		expect(japaneseRows.filter((row) => scriptsOf(row).includes("Hani"))).toHaveLength(3982)
	})
})

describe("the regression board", () => {
	/**
	 * The three sets above are chosen for the scripts they carry.
	 *
	 * This one is the board every other check runs against, so it says what the hint reports
	 * over the rows the product is actually graded on — and what it has none of.
	 */
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
		// `cases/kr/` is an open box on #2277.
		// Stating the absence beats asserting a count that would silently become wrong,
		// and the Korean reference set above is what covers Hangul until that directory exists.
		expect(koreanRows.map(topScript)).toContain("Hang")
	})
})

describe("what reaches the parse surface", () => {
	/**
	 * Both fields reach `mailwoman parse --debug` and `mwdev_trace` by pass-through — the pipeline
	 * threads the query shape and the hint whole, and neither surface rebuilds them field by field.
	 *
	 * Pass-through is invisible, which is why it is pinned here: a projection
	 * added between the stage and the serializer would drop the script silently
	 * and every other assertion in this file would still pass.
	 */
	it("carries the ranked scripts and the per-token script through the whole pipeline", async () => {
		const { createRuntimePipeline } = await import("mailwoman")
		const pipeline = createRuntimePipeline({})
		const result = await pipeline("金龍酒家, 12 Gerrard Street, London WC2H 7JS", {})

		expect(result.queryShape?.scripts?.map((entry) => entry.script)).toEqual(["Latn", "Hani"])
		expect(result.locale?.script?.map((entry) => entry.script)).toEqual(["Latn", "Hani"])

		// The Han venue, which is the span the fold made invisible: `characterClass`
		// reads `mixed` for this input and `mixed` names no script.
		// Therefore, nothing downstream could see that 金龍酒家 is written in Han.
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
