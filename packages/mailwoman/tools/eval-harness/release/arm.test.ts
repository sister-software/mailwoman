// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { describe, expect, it } from "vitest"

import { releaseArmModelPath } from "#tools/eval-harness/release/arm"

describe("releaseArmModelPath", () => {
	it("reads the en-us package's model under a weights cache root", () => {
		expect(releaseArmModelPath("/mnt/mw/models/arms/v832/roots/v42-i8")).toBe(
			"/mnt/mw/models/arms/v832/roots/v42-i8/node_modules/@mailwoman/neural-weights-en-us/model.onnx"
		)
	})
})
