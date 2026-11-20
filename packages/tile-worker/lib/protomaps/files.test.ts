// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { expect, test } from "vitest"

import { TileFileExtensionMap, TileTypeFileExtensionMap } from "#protomaps/files"

test("each tile type maps back to the extension that names it", () => {
	for (const [extension, tileType] of TileFileExtensionMap) {
		expect(TileTypeFileExtensionMap.get(tileType)).toBe(extension)
	}
})
