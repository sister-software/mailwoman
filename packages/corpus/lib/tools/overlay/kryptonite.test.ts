/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The kryptonite overlay's extract hash covers its whole jsonl, so the jsonl must hold one source.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { afterAll, describe, expect, it } from "vitest"

import { canonicalRows } from "#tools/overlay/kryptonite"

const root = await temporaryDirectory("mw-kryptonite-")

afterAll(() => root[Symbol.asyncDispose]())

const line = (source: string, id: string) =>
	stringifyJSON({ raw: "1 Main St", components: {}, source, source_id: id, surface: "composed" })

describe("canonicalRows", () => {
	it("refuses a jsonl whose rows name two sources", async () => {
		const jsonl = root.path("mixed.jsonl").toString()

		await writeLocalTextFile(`${line("deepseek-kryptonite", "k-1")}\n${line("deepseek-translit-cyrl", "t-1")}\n`, jsonl)

		await expect(Array.fromAsync(canonicalRows(jsonl))).rejects.toThrow(/must hold one source/u)
	})

	it("reads a jsonl of one source", async () => {
		const jsonl = root.path("one.jsonl").toString()

		await writeLocalTextFile(`${line("deepseek-kryptonite", "k-1")}\n${line("deepseek-kryptonite", "k-2")}\n`, jsonl)

		expect(await Array.fromAsync(canonicalRows(jsonl))).toHaveLength(2)
	})
})
