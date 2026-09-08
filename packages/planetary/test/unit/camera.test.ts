// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { framingZoom } from "@mailwoman/planetary/map/camera"
import { expect, test } from "vitest"

test.each([
	[1250, 3], // Mare Imbrium
	[300, 3],
	[299.9, 5],
	[100, 5],
	[85.29, 7], // Tycho
	[30, 7],
	[29.9, 9],
	[1.2, 9],
	[0, 9],
	[undefined, 9],
])("a %s km feature is framed at zoom %d", (diameterKm, zoom) => {
	expect(framingZoom(diameterKm)).toBe(zoom)
})
