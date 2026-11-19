// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The first recognition instantiates the embedded engine synchronously in a Chromium page, with no `init`.
 *
 *   Run with `yarn workspace @mailwoman/recognizer test:browser`.
 */

import { createRecognizer } from "@mailwoman/recognizer"
import { coordinates } from "@mailwoman/recognizer/coordinates"
import { primitives } from "@mailwoman/recognizer/primitives"
import { expect, it } from "vitest"

it("instantiates synchronously on the first call in Chromium", () => {
	const agent = (globalThis as { navigator?: { userAgent: string } }).navigator?.userAgent ?? ""

	expect(agent).toContain("Chrome")

	const recognizer = createRecognizer([primitives, coordinates])

	// No `await` precedes this call, so the compile and instantiate it makes are synchronous.
	const { recognitions } = recognizer.recognize("😀 40.7128, -74.0060")
	const pair = recognitions.find((recognition) => recognition.kind === "coordinate.decimal_pair")

	expect(pair).toMatchObject({ start: 3, end: 20, text: "40.7128, -74.0060" })

	expect(pair?.validation).toEqual({
		status: "validated",
		payload: { latitude: 40.7128, longitude: -74.006, order: "lat_lon" },
	})
})
