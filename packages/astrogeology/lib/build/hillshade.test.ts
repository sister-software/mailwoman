// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Which interpreter the hillshade build runs `gdal_calc` through.
 */

import { expect, test } from "vitest"

import { OSGEO_INTERPRETERS, resolveOSGeoInterpreter } from "#build/hillshade"

test("the interpreter search tries python3 before the distribution's python3.12", () => {
	expect(OSGEO_INTERPRETERS).toEqual(["python3", "python3.12"])
})

test("resolveOSGeoInterpreter refuses with each candidate it tried when none imports osgeo", async () => {
	await expect(resolveOSGeoInterpreter(["mailwoman-no-such-python-a", "mailwoman-no-such-python-b"])).rejects.toThrow(
		/tried mailwoman-no-such-python-a: .*; mailwoman-no-such-python-b: /
	)
})
