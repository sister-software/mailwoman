// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import { decodeAsOutline } from "#decoder/serialize/outline"
import type { AddressNode } from "#decoder/types"

function node(tag: AddressNode["tag"], value: string, start: number, children: AddressNode[] = []): AddressNode {
	return { tag, value, start, end: start + value.length, confidence: 1, children }
}

test("indents each child two spaces under its parent and quotes each value", () => {
	const tree = {
		raw: "New York NY",
		roots: [node("region", "NY", 9, [node("locality", "New York", 0)])],
	}

	expect(decodeAsOutline(tree)).toBe('region [9, 11): "NY"\n  locality [0, 8): "New York"')
})
