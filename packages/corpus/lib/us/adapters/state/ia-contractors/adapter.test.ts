/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { workspacePath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { runAdapter } from "#runner"
import { readCanonicalRows, useScratchDir } from "#test-kit"
import {
	STATE_IA_CONTRACTORS_ADAPTER_ID,
	createStateIaContractorsAdapter,
} from "#us/adapters/state/ia-contractors/adapter"

const scratch = useScratchDir("state-ia-contractors")

const fixtureCSV = workspacePath("corpus", "fixtures", "state-ia-contractors", "sample.csv")

const loadRows = async () => {
	await runAdapter({
		adapter: createStateIaContractorsAdapter(),
		adapterOptions: { inputPath: fixtureCSV },
		outputDir: scratch.path,
		corpusVersion: "0.1.0",
	})

	return readCanonicalRows(scratch.path, STATE_IA_CONTRACTORS_ADAPTER_ID)
}

describe("state-ia-contractors adapter against fixture sample.csv", () => {
	it("keeps the city, state and ZIP line of Address 2 out of the street", async () => {
		const rows = await loadRows()
		const row = rows.find((r) => r.components.venue === "GARDNER-WATSON DECKING INC")!

		expect(row.components).toMatchObject({
			house_number: "300",
			street: "SCARLET BLVD",
			locality: "OLDSMAR",
			region: "FL",
			postcode: "34677",
		})

		expect(row.raw).toBe("GARDNER-WATSON DECKING INC, 300 SCARLET BLVD, OLDSMAR, FL 34677")
	})

	it("splits a trailing suite into unit and a PO box into po_box", async () => {
		const rows = await loadRows()
		const suite = rows.find((r) => r.components.venue === "PRAIRIE BUILDERS LLC")!

		expect(suite.components).toMatchObject({ house_number: "1200", street: "GRAND AVE", unit: "STE 210" })

		const box = rows.find((r) => r.components.venue === "HAWKEYE ELECTRIC INC")!

		expect(box.components.po_box).toBe("PO BOX 846")
		expect(box.components.street).toBeUndefined()
	})
})
