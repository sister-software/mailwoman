// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Which interpreter the hillshade build runs `gdal_calc` through.
 */

import { expect, test } from "vitest"

import { resolveOSGeoInterpreter } from "#build/hillshade"

test("resolveOSGeoInterpreter refuses with each candidate it tried when none imports osgeo", async () => {
	await expect(resolveOSGeoInterpreter(["mailwoman-no-such-python-a", "mailwoman-no-such-python-b"])).rejects.toThrow(
		/tried mailwoman-no-such-python-a: .*; mailwoman-no-such-python-b: /
	)
})
