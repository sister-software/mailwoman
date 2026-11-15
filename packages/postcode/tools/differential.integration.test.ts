// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `postcode_legacy` family's `knownFormats` equal the legacy list, field by field
 *   and in order, on 100,000 generated inputs.
 */

import { isPresent } from "@mailwoman/core/objects"
import { expect, it } from "vitest"

import { compareKnownFormats, generatedKnownFormatInputs } from "#tools/differential"

it("equals the legacy output on 100,000 generated inputs", { timeout: 600_000 }, () => {
	const differences = generatedKnownFormatInputs(100_000, 7).map(compareKnownFormats).filter(isPresent)

	expect(differences.slice(0, 5)).toEqual([])
})
