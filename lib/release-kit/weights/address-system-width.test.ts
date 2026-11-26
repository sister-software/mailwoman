// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file A candidate whose address-system head is wider than the published card's table gets the committed
 *   registry's table at its head's width, so the staged card matches the graph it describes.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { fitAddressSystemTable } from "#release-kit/weights/address-system-width"

// The trainer export's tiny bundle has a 4-wide `address_system_logits` head.
const TINY_GRAPH = repoRootPath(
	"packages",
	"trainer",
	"crates",
	"trainer-export",
	"tests",
	"fixtures",
	"tiny-bundle",
	"reference-fp32.onnx"
)

const cardWithTable = (count: number): Record<string, unknown> => ({
	address_systems: { count, no_hint: count, members: { "US/Latn": 0 } },
	candidate: { published_card: "published" },
})

describe("fitAddressSystemTable", () => {
	it("replaces a narrower table with the registry's at the head's width and records the replacement", async () => {
		const card = cardWithTable(2)

		expect(await fitAddressSystemTable(card, TINY_GRAPH, "card.json")).toBe(4)

		const table = card["address_systems"] as { count: number; no_hint: number; members: Record<string, number> }
		const candidate = card["candidate"] as Record<string, unknown>

		expect(table.count).toBe(4)
		expect(table.no_hint).toBe(4)
		expect(Object.values(table.members).every((system) => system < 4)).toBe(true)
		expect(candidate["published_card"]).toBe("published")
		expect(candidate["address_systems"]).toMatchObject({ count: 4 })
	})

	it("leaves a table already the head's width unchanged", async () => {
		const card = cardWithTable(4)
		const before = structuredClone(card)

		expect(await fitAddressSystemTable(card, TINY_GRAPH, "card.json")).toBeNull()
		expect(card).toEqual(before)
	})
})
