// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, makeDirectories, writeLocalFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { afterAll, describe, expect, it } from "vitest"

import { resolveWeights } from "#weights"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * A locale with no published package, so resolution reaches the overlay rung under test.
 */
const ABSENT = "xx-xx"

describe("resolveWeights — a dangling evidence-lexicon link", () => {
	it("names the link and its missing target rather than reporting a lexicon mismatch", async () => {
		const root = fixtures.use(await temporaryDirectory("mw-dangling-lexicon-")).path
		const overlay = root(ABSENT)
		const removedCheckout = root("removed-checkout", "data", "gazetteer", "street-type-lexicon-v3.json")

		await makeDirectories(overlay)
		await writeLocalFile("onnx", overlay("model.onnx"))
		await writeLocalFile("sp", overlay("tokenizer.model"))

		await writeLocalFile(
			stringifyJSON({ requires: { street_type: { required: true, lexicon: "street-type-lexicon-v3.json" } } }),
			overlay("model-card.json")
		)

		await createSymbolicLink(removedCheckout, overlay("street-type-lexicon-v3.json"))

		const resolving = resolveWeights({ locale: ABSENT, overlayRoot: root })

		await expect(resolving).rejects.toThrow(overlay("street-type-lexicon-v3.json").toString())
		await expect(resolving).rejects.toThrow(removedCheckout.toString())
		await expect(resolving).rejects.not.toThrow(/MISMATCH/)
	})
})
