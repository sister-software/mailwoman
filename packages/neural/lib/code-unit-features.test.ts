import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { CODE_UNIT_FEATURE_DIM, codeUnitChannel } from "#code-unit-features"
import { packSoftChannelFeeds } from "#ort-feeds"

interface ParityCase {
	text: string
	spans: Array<[number, number]>
	features: number[][]
	confidence: number[]
}

const { cases } = await readLocalJSONFile<{ cases: ParityCase[] }>(
	repoRootPath("test", "fixtures", "code-unit-parity.json")
)

describe("codeUnitChannel", () => {
	it.each(cases.map((parity) => [parity.text, parity] as const))(
		"reproduces the parity fixture for %s",
		(_, parity) => {
			const channel = codeUnitChannel(parity.text, parity.spans)

			expect(channel.confidence).toEqual(parity.confidence)
			expect(channel.features).toEqual(parity.features)
		}
	)

	it("gives every piece of one code the code's features", () => {
		const text = "London SW1A 2AA"

		// `▁SW` + `1A` as a word-piece vocabulary splits it.
		const channel = codeUnitChannel(text, [
			[0, 6],
			[7, 9],
			[9, 11],
		])

		expect(channel.confidence).toEqual([0, 1, 1])
		expect(channel.features[1]).toEqual(channel.features[2])
	})
})

describe("packSoftChannelFeeds with the code-unit channel", () => {
	const channel = codeUnitChannel("NY 10118", [
		[0, 2],
		[3, 8],
	])

	it("feeds the channel to a graph that declares it", () => {
		const fed = packSoftChannelFeeds(["code_unit_features", "code_unit_confidence"], 4, 2, null, null, null, {
			codeUnit: channel,
		})

		expect(fed.map(([name]) => name)).toEqual(["code_unit_features", "code_unit_confidence"])
		expect(fed[0]![1].dims).toEqual([1, 4, CODE_UNIT_FEATURE_DIM])
	})

	it("feeds nothing to a graph without it", () => {
		expect(
			packSoftChannelFeeds(["anchor_features"], 4, 2, null, null, null, { codeUnit: channel }).map(([n]) => n)
		).toEqual(["anchor_features", "anchor_confidence"])
	})
})
