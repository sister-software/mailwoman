/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeEach, describe, expect, it } from "vitest"

import type { CanonicalRow } from "../../types.ts"
import { createUsgovIrsBmfAdapter, USGOV_IRS_BMF_ADAPTER_ID, USGOV_IRS_BMF_DEFAULT_LICENSE } from "./adapter.ts"

const HEADER = "EIN,NAME,STREET,CITY,STATE,ZIP"

let scratch: string
beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "mailwoman-irsbmf-"))
})

function writeCSV(...lines: string[]): string {
	const p = join(scratch, "eo.csv")
	writeFileSync(p, HEADER + "\n" + lines.join("\n") + "\n", "utf8")

	return p
}

async function collect(p: string, extra?: Record<string, unknown>): Promise<CanonicalRow[]> {
	const out: CanonicalRow[] = []

	for await (const r of createUsgovIrsBmfAdapter().rows({ inputPath: p, ...extra })) {
		out.push(r)
	}

	return out
}

describe("usgov-irs-bmf adapter", () => {
	it("has the expected id and license", () => {
		const a = createUsgovIrsBmfAdapter()
		expect(a.id).toBe(USGOV_IRS_BMF_ADAPTER_ID)
		expect(a.defaultLicense).toBe(USGOV_IRS_BMF_DEFAULT_LICENSE)
	})

	it("tags a PO-box street line as po_box (not street)", async () => {
		const rows = await collect(writeCSV("010674605,IGLESIA FUENTE DE AGUA VIVA,PO BOX 3869,CAROLINA,PR,00984-3869"))
		expect(rows).toHaveLength(1)
		const r = rows[0]!
		expect(r.components.po_box).toBe("PO BOX 3869")
		expect(r.components.street).toBeUndefined()
		expect(r.components).toMatchObject({
			venue: "IGLESIA FUENTE DE AGUA VIVA",
			locality: "CAROLINA",
			region: "PR",
			postcode: "00984",
		})
		expect(r.country).toBe("US")
		expect(r.source).toBe(USGOV_IRS_BMF_ADAPTER_ID)
		expect(r.source_id).toBe("usgov-irs-bmf-010674605")
	})

	it("splits a numbered street into house_number + street", async () => {
		const rows = await collect(writeCSV("123456789,COMMUNITY FOUNDATION INC,1234 MAIN ST,SAN JUAN,PR,00901"))
		const r = rows[0]!
		expect(r.components).toMatchObject({
			house_number: "1234",
			street: "MAIN ST",
			locality: "SAN JUAN",
			region: "PR",
			postcode: "00901",
		})
		expect(r.components.po_box).toBeUndefined()
	})

	it("drops the +4 from a ZIP+4 postcode", async () => {
		const rows = await collect(writeCSV("111,ORG A,PO BOX 1,PONCE,PR,00731-1234"))
		expect(rows[0]?.components.postcode).toBe("00731")
	})

	it("skips rows missing city or zip", async () => {
		const rows = await collect(
			writeCSV("1,NO CITY,PO BOX 1,,PR,00901", "2,NO ZIP,PO BOX 2,SAN JUAN,PR,", "3,OK ORG,PO BOX 3,SAN JUAN,PR,00901")
		)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.components.locality).toBe("SAN JUAN")
	})

	it("honors the row limit", async () => {
		const rows = await collect(writeCSV("1,A,PO BOX 1,SAN JUAN,PR,00901", "2,B,PO BOX 2,SAN JUAN,PR,00901"), {
			limit: 1,
		})
		expect(rows).toHaveLength(1)
	})

	it("rejects a non-US country filter", async () => {
		const p = writeCSV("1,A,PO BOX 1,SAN JUAN,PR,00901")
		await expect(async () => {
			for await (const _ of createUsgovIrsBmfAdapter().rows({ inputPath: p, country: "FR" })) {
				void _
			}
		}).rejects.toThrow(/only US/)
	})
})
