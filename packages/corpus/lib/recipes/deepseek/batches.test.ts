/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The DeepSeek generator's deterministic halves reproduce the Python module's prompts, batch ids, rows,
 *   parses and validations, as `fixtures/builders/deepseek/deepseek-reference.json` recorded them. No request is made.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { asPythonFloat, pythonJSONDumps } from "@mailwoman/core/strings/python-json"
import { describe, expect, it } from "vitest"

import {
	canonicalKryptoniteRow,
	canonicalTranslitRow,
	deterministicID,
	emittedDeepSeekSources,
	loadTranslitSeeds,
	parseJSONLResponse,
	planKryptoniteBatches,
	planTranslitBatches,
	type TranslitBatch,
	validateComponents,
} from "#recipes/deepseek/batches"
import {
	buildKryptoniteUserPrompt,
	buildTranslitUserPrompt,
	KRYPTONITE_CATEGORIES,
	KRYPTONITE_SYSTEM,
	KRYPTONITE_USER_TEMPLATE,
	TRANSLIT_SCRIPTS,
	TRANSLIT_SYSTEM,
	type TranslitSeed,
} from "#recipes/deepseek/prompts"

const REFERENCE = resolvePackagePath("@mailwoman/corpus", "fixtures", "builders", "deepseek", "deepseek-reference.json")

interface Reference {
	translit_system: string
	kryptonite_system: string
	kryptonite_user_template: string
	translit_scripts: string
	kryptonite_categories: string
	translit_prompt: string
	kryptonite_prompts: string
	translit_plan: [string, string, number][]
	kryptonite_plan: { batches: number; digest: string }
	small_plan_ids: string[]
	translit_row: string
	kryptonite_row: string
	parsed: unknown[][]
	validations: [boolean, string | null][]
	emitted: string[][]
}

const digest = (value: unknown) =>
	sha256Hex(typeof value === "string" ? value : pythonJSONDumps(value, { ensureASCII: false }))

const SEEDS: TranslitSeed[] = [
	{
		raw: "350 5th Ave, New York, NY 10118",
		components: { house_number: "350", street: "5th Ave", locality: "New York", region: "NY" },
		source_id: "seed-us-0001",
		country: "US",
		locale: "en-US",
	},
	{
		raw: "5 Avenue Anatole France, 75007 Paris",
		components: { house_number: "5", street: "Avenue Anatole France", locality: "Paris" },
		source_id: "seed-fr-0002",
		country: "FR",
		locale: "fr-FR",
	},
	{
		raw: "1 Rue de l'Église, Saint-Étienne",
		components: { house_number: "1", street: "Rue de l'Église", locality: "Saint-Étienne" },
		source_id: "seed-fr-0003",
		country: "FR",
		locale: "fr-FR",
	},
]

const CONTENTS = [
	'{"i": 0, "raw": "a"}\n{"i": 1, "raw": "b"}',
	'```jsonl\n{"i": 0, "raw": "a"}\n```',
	"not json at all\n{bad json}\n",
	"",
	'  {"i": 0, "raw": "a"}  \r\n {"i": 2, "raw": "ü"}',
]

const VALIDATIONS: [string, Record<string, string>][] = [
	["350 5th Ave", { house_number: "350", street: "5th Ave" }],
	["350 5th Ave", {}],
	["350 5th Ave", { street: "" }],
	["350 5th Ave", { street: "6th Ave" }],
	["x".repeat(251), { street: "x" }],
	["𠮷".repeat(250), { street: "𠮷" }],
	["", { street: "" }],
]

describe("the DeepSeek generator's deterministic halves", async () => {
	const reference = await readLocalJSONFile<Reference>(REFERENCE)

	it("sends the Python module's prompt text and tables", () => {
		expect(digest(TRANSLIT_SYSTEM)).toBe(reference.translit_system)
		expect(digest(KRYPTONITE_SYSTEM)).toBe(reference.kryptonite_system)
		expect(digest(KRYPTONITE_USER_TEMPLATE)).toBe(reference.kryptonite_user_template)
		expect(digest(TRANSLIT_SCRIPTS)).toBe(reference.translit_scripts)

		expect(
			digest(
				KRYPTONITE_CATEGORIES.map(
					(category) =>
						new Map<string, unknown>([
							["category", category.category],
							["description", category.description],
							["examples", category.examples],
							["weight", asPythonFloat(category.weight)],
						])
				)
			)
		).toBe(reference.kryptonite_categories)

		expect(digest(buildTranslitUserPrompt("Russian Cyrillic", SEEDS))).toBe(reference.translit_prompt)

		expect(digest(KRYPTONITE_CATEGORIES.map((category) => buildKryptoniteUserPrompt(category, 12)))).toBe(
			reference.kryptonite_prompts
		)
	})

	it("plans the same batches under the same ids", () => {
		expect(
			planTranslitBatches(SEEDS, 2, null).map((batch) => [batch.batchID, batch.scriptSlug, batch.seeds.length])
		).toEqual(reference.translit_plan)

		const plan = planKryptoniteBatches(8000, 50)

		expect(plan).toHaveLength(reference.kryptonite_plan.batches)

		expect(digest(plan.map((batch) => [batch.batchID, batch.category.category, batch.n, batch.index]))).toBe(
			reference.kryptonite_plan.digest
		)

		expect(planKryptoniteBatches(300, 7).map((batch) => [batch.batchID, batch.n])).toEqual(
			KRYPTONITE_CATEGORIES.flatMap((category) =>
				reference.small_plan_ids.map((id, index) => [`krypt-${category.category}-${id}`, index === 7 ? 1 : 7])
			)
		)

		expect(deterministicID("translit-cyrl", '["seed-us-0001", "seed-fr-0002"]|cyrl')).toBe(
			"translit-cyrl-f9f2cedf899da917"
		)
	})

	it("writes the same rows", () => {
		const batch: TranslitBatch = {
			batchID: "translit-jpan-test",
			scriptLabel: "Japanese (Katakana + Kanji)",
			scriptSlug: "jpan",
			surfaceLanguage: "ja",
			surfaceScript: "Jpan",
			seeds: SEEDS,
		}

		expect(digest(canonicalTranslitRow(batch, SEEDS[2]!, "サンテティエンヌ", { locality: "サンテティエンヌ" }))).toBe(
			reference.translit_row
		)

		expect(
			digest(
				canonicalKryptoniteRow(
					KRYPTONITE_CATEGORIES[7]!,
					3,
					"1 Place Carnot",
					{ street: "Place Carnot" },
					"french-saint"
				)
			)
		).toBe(reference.kryptonite_row)
	})

	it("parses and validates as the Python module did", () => {
		expect(CONTENTS.map((content) => parseJSONLResponse(content))).toEqual(reference.parsed)

		expect(VALIDATIONS.map(([raw, components]) => [...validateComponents(raw, components)])).toEqual(
			reference.validations
		)

		expect([
			emittedDeepSeekSources("kryptonite", null),
			emittedDeepSeekSources("transliteration", null),
			emittedDeepSeekSources("transliteration", ["hang"]),
		]).toEqual(reference.emitted)
	})

	it("refuses a seed without a country at load, and a missing seed file, naming each", async () => {
		await using scratch = await temporaryDirectory("mailwoman-deepseek-")
		const path = scratch.path("seeds.jsonl").toString()

		await writeLocalTextFile(
			stringifyJSON({ raw: "350 5th Ave", components: {}, source_id: "seed-x", locale: "en-US" }),
			path
		)

		await expect(loadTranslitSeeds([path], 0)).rejects.toThrow("seed 'seed-x' carries no 'country'")
		await expect(loadTranslitSeeds([`${path}.absent`], 0)).rejects.toThrow(`${path}.absent`)
	})
})
