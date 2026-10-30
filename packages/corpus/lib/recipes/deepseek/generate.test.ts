/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Both generation modes end to end through the real client over a stub transport, and the refusal that comes
 *   before the key is read. No request leaves the process.
 */

import { createFakeClock } from "@mailwoman/core/api/test-clocks"
import { stubTransport, type StubResult } from "@mailwoman/core/api/test-transport"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { silentLogger } from "@mailwoman/core/logging"
import { JSONSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"

import { planKryptoniteBatches, planTranslitBatches } from "#recipes/deepseek/batches"
import { DeepSeekClient } from "#recipes/deepseek/client"
import {
	deepSeekOutputPaths,
	DeepSeekMode,
	type DeepSeekRunOptions,
	runDeepSeekGeneration,
} from "#recipes/deepseek/generate"
import type { TranslitSeed } from "#recipes/deepseek/prompts"
import { readAddressSourceRegister } from "#source-register"
import { createSourceRightsAdmission, readCorpusSourceInputs, SourceRightsError } from "#source-register/corpus-inputs"
import type { AddressSourceRegister } from "#source-register/types"

const SEEDS: TranslitSeed[] = [
	{
		raw: "350 5th Ave, New York, NY 10118",
		components: { house_number: "350", street: "5th Ave" },
		source_id: "seed-us-0001",
		country: "US",
		locale: "en-US",
	},
	{
		raw: "5 Avenue Anatole France, 75007 Paris",
		components: { house_number: "5", locality: "Paris" },
		source_id: "seed-fr-0002",
		country: "FR",
		locale: "fr-FR",
	},
]

const completion = (lines: unknown[], finish: string | null): StubResult => ({
	body: {
		choices: [
			{
				message: { content: lines.map((line) => (typeof line === "string" ? line : stringifyJSON(line))).join("\n") },
				finish_reason: finish,
			},
		],
		usage: { total_tokens: 11 },
	},
})

const readLines = async (path: string): Promise<Record<string, unknown>[]> =>
	(await pathExists(path)) ? Array.fromAsync(JSONSpliterator.fromAsync<Record<string, unknown>>(path)) : []

async function admitted(register?: AddressSourceRegister, unshippableReason: string | null = null) {
	const source = register ?? (await readAddressSourceRegister())
	const inputs = await readCorpusSourceInputs(source)

	return (context: string) =>
		Promise.resolve(createSourceRightsAdmission(source, inputs, { context, unshippableReason, log: () => {} }))
}

function options(mode: DeepSeekMode, outDir: string, seedPaths: string[] = []): DeepSeekRunOptions {
	return {
		mode,
		outDir,
		model: "deepseek-v4-flash",
		batchSize: 2,
		concurrency: 1,
		maxTokens: 100,
		seedPaths,
		scripts: ["cyrl", "hang"],
		limit: 0,
		targetCount: 0,
		log: () => {},
	}
}

describe("runDeepSeekGeneration", () => {
	it("writes validated transliterations, keeps a truncated batch pending, and asks only for it on a rerun", async () => {
		await using scratch = await temporaryDirectory("mailwoman-deepseek-generate-")
		const seedPath = scratch.path("seeds.jsonl").toString()
		const outDir = scratch.path("out").toString()

		await writeLocalTextFile(SEEDS.map((seed) => stringifyJSON(seed) + "\n").join(""), seedPath)

		const [cyrl, hang] = planTranslitBatches(SEEDS, 2, ["cyrl", "hang"])

		const transport = stubTransport([
			completion(
				[
					{ i: 0, raw: "350 5-я авеню, Нью-Йорк", components: { street: "5-я авеню" } },
					{ i: "1", raw: "5 авеню Анатоля Франса, Париж", components: { locality: "Лондон" } },
					{ i: 7, raw: "x", components: { street: "x" } },
					{ i: 1, raw: "Париж", components: ["Париж"] },
					"```",
				],
				"stop"
			),
			completion([{ i: 0, raw: "350 5번가", components: { street: "5번가" } }], "length"),
			completion([{ i: 1, raw: "파리 아나톨 프랑스 대로 5", components: { locality: "파리" } }], "stop"),
		])

		// The committed register refuses the OpenAddresses rows the transliteration sources read,
		// so the run is a local experiment, and its rights record marks it not shippable.
		const dependencies = {
			openAdmission: await admitted(undefined, "generator test"),
			readAPIKey: () => "sk-test",
			createClient: (apiKey: string) =>
				new DeepSeekClient({ apiKey, axios: transport.axios, clock: createFakeClock(), logger: silentLogger() }),
		}

		const tally = await runDeepSeekGeneration(options(DeepSeekMode.Transliteration, outDir, [seedPath]), dependencies)

		expect(Object.fromEntries(tally)).toEqual({
			ok: 2,
			"reject:not-in-raw:locality": 1,
			"index-out-of-range": 1,
			"bad-shape": 1,
			expected: 4,
			"finish:stop": 1,
			"finish:length": 1,
		})

		const paths = deepSeekOutputPaths(DeepSeekMode.Transliteration, outDir)
		const rows = await readLines(paths.canonical)

		expect(rows.map((row) => [row.source, row.country, row.surface_script])).toEqual([
			["deepseek-translit-cyrl", "US", "Cyrl"],
			["deepseek-translit-hang", "US", "Hang"],
		])

		expect((await readLines(paths.rawLog)).map((entry) => [entry.batch_id, entry.finish_reason])).toEqual([
			[cyrl!.batchID, "stop"],
			[hang!.batchID, "length"],
		])

		expect(await readLocalJSONFile(paths.checkpoint)).toEqual({ done: [cyrl!.batchID] })

		expect(await readLocalJSONFile(scratch.path("out", "SOURCE_RIGHTS.json"))).toMatchObject({
			shippable: false,
			unshippable_reason: "generator test",
			sources_checked: ["deepseek-translit-cyrl", "deepseek-translit-hang"],
		})

		await runDeepSeekGeneration(options(DeepSeekMode.Transliteration, outDir, [seedPath]), dependencies)

		expect(transport.calls).toHaveLength(3)
		expect((await readLines(paths.canonical)).at(-1)).toMatchObject({ source: "deepseek-translit-hang", country: "FR" })

		expect(new Set((await readLocalJSONFile<{ done: string[] }>(paths.checkpoint)).done)).toEqual(
			new Set([cyrl!.batchID, hang!.batchID])
		)
	})

	it("leaves a kryptonite batch whose request failed pending and completes the rest", async () => {
		await using scratch = await temporaryDirectory("mailwoman-deepseek-generate-")
		const outDir = scratch.path("out").toString()
		const plan = planKryptoniteBatches(0, 50)

		const transport = stubTransport([
			{ status: 400 },
			completion(
				[{ raw: "Buffalo Buffalo, NY", components: { locality: "Buffalo" }, kind: "repeat" }, { raw: "y" }],
				"stop"
			),
		])

		const tally = await runDeepSeekGeneration(
			{ ...options(DeepSeekMode.Kryptonite, outDir), batchSize: 50 },
			{
				openAdmission: await admitted(),
				readAPIKey: () => "sk-test",
				createClient: (apiKey) =>
					new DeepSeekClient({ apiKey, axios: transport.axios, clock: createFakeClock(), logger: silentLogger() }),
			}
		)

		expect(transport.calls).toHaveLength(plan.length)
		expect(tally.get("api_error")).toBe(1)
		expect(tally.get("ok")).toBe(plan.length - 1)
		expect(tally.get("bad-shape")).toBe(plan.length - 1)

		const paths = deepSeekOutputPaths(DeepSeekMode.Kryptonite, outDir)
		const done = new Set((await readLocalJSONFile<{ done: string[] }>(paths.checkpoint)).done)

		expect(plan.filter((batch) => !done.has(batch.batchID)).map((batch) => batch.batchID)).toEqual([plan[0]!.batchID])

		const [row] = await readLines(paths.canonical)

		expect(row).toMatchObject({ source: "deepseek-kryptonite", _kryptonite_kind: "repeat" })
	})

	it("refuses a source before it reads the key or creates the output directory", async () => {
		await using scratch = await temporaryDirectory("mailwoman-deepseek-generate-")
		const outDir = scratch.path("out").toString()
		const register = structuredClone(await readAddressSourceRegister())
		const licenseID = register.sources.find((source) => source.sourceID === "cn-generated-text-1")!.license

		for (const decision of register.licenses) {
			if (decision.licenseID === licenseID) {
				;(decision as { state: string }).state = "refused"
			}
		}

		const run = runDeepSeekGeneration(options(DeepSeekMode.Kryptonite, outDir), {
			openAdmission: await admitted(register),
			readAPIKey: () => {
				throw new Error("the generator read the DeepSeek API key before the rights check refused it")
			},
			createClient: () => {
				throw new Error("the generator built a client before the rights check refused it")
			},
		})

		await expect(run).rejects.toThrow(SourceRightsError)
		await expect(run).rejects.toThrow("deepseek-kryptonite reads register source cn-generated-text-1")
		expect(await pathExists(outDir)).toBe(false)
	})

	it("refuses transliteration without seed files before admitting anything", async () => {
		await expect(
			runDeepSeekGeneration(options(DeepSeekMode.Transliteration, "/nonexistent"), {
				openAdmission: () => Promise.reject(new Error("admission opened")),
				readAPIKey: () => "sk-test",
				createClient: () => ({ complete: () => Promise.reject(new Error("requested")) }),
			})
		).rejects.toThrow("--seed-paths required for transliteration mode")
	})
})
