// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { heldoutArmDecoderSettings, parseHeldoutArm } from "#tools/eval-harness/heldout/per/arm"
import { releaseArmModelPath } from "#tools/eval-harness/release/arm"

describe("parseHeldoutArm", () => {
	it("reads a bare root and a root with resolver pins, and hashes the same model for both", () => {
		const root = "/mnt/mw/models/arms/v870/roots/shipped-10.8.0"

		expect(parseHeldoutArm(root)).toEqual({ label: root, cacheRoot: root, pins: {} })

		const pinned = `${root}#countyDesignatorFallback=on,poiVenueTier=off`

		expect(parseHeldoutArm(pinned)).toEqual({
			label: pinned,
			cacheRoot: root,
			pins: { countyDesignatorFallback: "on", poiVenueTier: "off" },
		})

		expect(releaseArmModelPath(pinned)).toBe(releaseArmModelPath(root))
	})

	it("refuses an unknown switch, a value other than on or off, and a switch pinned twice", () => {
		expect(() => parseHeldoutArm("/r#gazetteerPrior=on")).toThrow(/the switches an arm may pin/u)
		expect(() => parseHeldoutArm("/r#countyDesignatorFallback=yes")).toThrow(/a pin is on or off/u)
		expect(() => parseHeldoutArm("/r#countyDesignatorFallback=on,countyDesignatorFallback=off")).toThrow(/twice/u)
		expect(() => parseHeldoutArm("#countyDesignatorFallback=on")).toThrow(/no weights cache root/u)
	})

	it("separates the decoder pins its parses take from the resolver pins, and refuses the FST routing it can't feed", () => {
		const arm = parseHeldoutArm("/r#pairPriorWordPieces=on,pairIndexOwnCountry=off,poiVenueTier=on")

		expect(heldoutArmDecoderSettings(arm)).toEqual({ pairPriorWordPieces: true, pairIndexOwnCountry: false })
		expect(heldoutArmDecoderSettings(parseHeldoutArm("/r#poiVenueTier=on"))).toEqual({})
		expect(() => parseHeldoutArm("/r#fstCountryRouting=on")).toThrow(/the switches an arm may pin/u)
	})
})
