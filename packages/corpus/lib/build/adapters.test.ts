// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { resolvePathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import { adapterRunInputs, reusableRun } from "#build/adapters"

const ROWS = '{"id":"a"}\n'

const IDENTITY = {
	corpusVersion: "0.1.0",
	inputs: adapterRunInputs({ extractHash: "extract-a", codeHash: "code-a" }),
}

/**
 * A finished adapter run on disk, as `runAdapter` leaves it, with the identity it records.
 */
async function finishedRun(root: string, recorded: { corpus_version: string; inputs: string | null }) {
	const adapterDir = resolvePathBuilder(root, "wof-admin")

	await writeLocalTextFile(ROWS, adapterDir("canonical.jsonl"))

	await writeLocalJSONFile(
		{ adapter_id: "wof-admin", bytes: ROWS.length, yielded: 1, ...recorded },
		adapterDir("MANIFEST.json")
	)

	return adapterDir
}

describe("reusableRun", () => {
	it("reuses a run made from the same inputs and code for the same corpus version", async () => {
		await using scratch = await temporaryDirectory("reusable-run-")

		const adapterDir = await finishedRun(scratch.path.toString(), {
			corpus_version: IDENTITY.corpusVersion,
			inputs: IDENTITY.inputs,
		})

		await expect(reusableRun("wof-admin", adapterDir, IDENTITY)).resolves.toMatchObject({ yielded: 1 })
	})

	it.each([
		[
			"other adapter options or input",
			{ corpus_version: "0.1.0", inputs: adapterRunInputs({ extractHash: "extract-b", codeHash: "code-a" }) },
		],
		[
			"other adapter code",
			{ corpus_version: "0.1.0", inputs: adapterRunInputs({ extractHash: "extract-a", codeHash: "code-b" }) },
		],
		["another corpus version", { corpus_version: "0.0.9", inputs: IDENTITY.inputs }],
		["no recorded inputs", { corpus_version: "0.1.0", inputs: null }],
	])("refuses a run made from %s, naming the flag that rebuilds it", async (_case, recorded) => {
		await using scratch = await temporaryDirectory("reusable-run-")
		const adapterDir = await finishedRun(scratch.path.toString(), recorded)

		await expect(reusableRun("wof-admin", adapterDir, IDENTITY)).rejects.toThrow(
			/resume refused for wof-admin.*--fresh/s
		)
	})
})
