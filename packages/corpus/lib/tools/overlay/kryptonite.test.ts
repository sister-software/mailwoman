// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The kryptonite overlay's extract hash covers its whole jsonl, so the jsonl must hold one source.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/values/json"
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

		await expect(Array.fromAsync(canonicalRows(jsonl))).resolves.toHaveLength(2)
	})

	it("reads a french-saint row the generator tagged FR as the US address it is", async () => {
		const jsonl = root.path("french-saint.jsonl").toString()

		await writeLocalTextFile(
			stringifyJSON({
				raw: "1 Rue Saint-Denis, New York, NY 10001",
				components: { street: "Rue Saint-Denis", locality: "New York", region: "NY" },
				country: "FR",
				locale: "fr-FR",
				source: "deepseek-kryptonite",
				source_id: "k-fr",
				surface: "composed",
			}),
			jsonl
		)

		const [row] = await Array.fromAsync(canonicalRows(jsonl))

		expect(row).toMatchObject({ country: "US", locale: "en-US" })
	})

	it("keeps another source's own country", async () => {
		const jsonl = root.path("translit.jsonl").toString()

		await writeLocalTextFile(
			stringifyJSON({
				raw: "x",
				components: {},
				country: "FR",
				source: "deepseek-translit-cyrl",
				source_id: "t",
				surface: "composed",
			}),
			jsonl
		)

		const [row] = await Array.fromAsync(canonicalRows(jsonl))

		expect(row?.country).toBe("FR")
	})
})
