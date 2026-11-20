// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { manifestSourceNames } from "@mailwoman/core/layers/manifest"
import { describe, expect, it } from "vitest"

import { US_ADDRESS_LAYER_SOURCE, US_ADDRESS_LAYER_SOURCE_LOCATIONS } from "#us/address-records/sources"

describe("US_ADDRESS_LAYER_SOURCE_LOCATIONS", () => {
	it("locates every source name the US address layer build writes", () => {
		const names = manifestSourceNames(US_ADDRESS_LAYER_SOURCE)

		expect(names.filter((name) => !US_ADDRESS_LAYER_SOURCE_LOCATIONS[name])).toEqual([])
	})
})
