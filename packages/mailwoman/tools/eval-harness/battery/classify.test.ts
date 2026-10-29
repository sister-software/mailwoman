import { describe, expect, it } from "vitest"

import {
	type BatterySpan,
	batteryFieldKey,
	batteryFieldMap,
	classifyBatteryError,
	parseBatteryFieldKey,
} from "#tools/eval-harness/battery/classify"

describe("batteryFieldMap", () => {
	it("joins street parts, lowercases and drops commas", () => {
		const fields = batteryFieldMap([
			["street", "Main"],
			["street_suffix", "St"],
			["venue", "Clas Ohlson Stavanger,"],
			["venue", "Madla"],
		])

		expect(batteryFieldKey(fields)).toBe("street=main st | venue=clas ohlson stavanger madla")
	})

	it("reads a field key back", () => {
		const key = "house_number=12 | street=main st"

		expect(batteryFieldKey(parseBatteryFieldKey(key))).toBe(key)
	})
})

describe("classifyBatteryError", () => {
	const classify = (raw: string, expected: Array<[string, string]>, spans: BatterySpan[]) =>
		classifyBatteryError(raw, batteryFieldMap(expected), spans)

	it("files a boundary inside a word as a word split", () => {
		expect(
			classify(
				"კოჯორი",
				[["locality", "კოჯორი"]],
				[
					["locality", 0, 1, "კ"],
					["locality", 1, 6, "ოჯორი"],
				]
			)
		).toBe("word-split")
	})

	it("files a house number read as a postcode as a number boundary", () => {
		const raw = "Zamin Bank, 1130 Babək prospekti"

		expect(
			classify(
				raw,
				[
					["venue", "Zamin Bank"],
					["house_number", "1130"],
					["street", "Babək prospekti"],
				],
				[
					["venue", 0, 10, "Zamin Bank"],
					["postcode", 12, 16, "1130"],
					["street", 17, 32, "Babək prospekti"],
				]
			)
		).toBe("number-boundary")
	})

	it("files a venue read as a locality as a venue error", () => {
		expect(
			classify(
				"Fito Club, 8 Main",
				[
					["venue", "Fito Club"],
					["house_number", "8"],
					["street", "Main"],
				],
				[
					["locality", 0, 9, "Fito Club"],
					["house_number", 11, 12, "8"],
					["street", 13, 17, "Main"],
				]
			)
		).toBe("venue")
	})

	it("files only place fields wrong as a place level", () => {
		expect(
			classify(
				"Löcken Waldfeucht",
				[
					["dependent_locality", "Löcken"],
					["locality", "Waldfeucht"],
				],
				[["locality", 0, 17, "Löcken Waldfeucht"]]
			)
		).toBe("place-level")
	})
})
