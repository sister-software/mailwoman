// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The frozen legacy shape table that postcode repair and `span_mode: "shaped"` read.
 *
 *   The training encoder reads the `postal` family and keeps no copy of this table.
 */

import { POSTCODE_SHAPES } from "@mailwoman/postcode/frozen-shapes"
import { describe, expect, it } from "vitest"

describe("the legacy postcode shape table", () => {
	it("compiles every shape, in the order the record declares", () => {
		// Priority is the index, so the catch-all has to stay last or it claims the spans the specific rows exist for.
		expect(POSTCODE_SHAPES.at(-1)?.label).toBe("NUM5")

		for (const shape of POSTCODE_SHAPES) {
			expect(shape.re.flags, `${shape.label} must scan the whole line`).toContain("g")
		}
	})
})
