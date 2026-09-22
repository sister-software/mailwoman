/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { InMemoryAdapterRegistry } from "@mailwoman/corpus/adapters/utils"
import { writeDelimitedFixture } from "@mailwoman/corpus/test-kit"
import {
	createUsgovNPPESAdapter,
	USGOV_NPPES_ADAPTER_ID,
	USGOV_NPPES_DEFAULT_LICENSE,
} from "@mailwoman/corpus/us/adapters/usgov/nppes/adapter"
import { join, type PathBuilderLike } from "path-ts"
import { afterAll, beforeEach, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const CSV_HEADER = [
	"NPI",
	"Entity Type Code",
	"Provider Organization Name (Legal Business Name)",
	"Provider Last Name (Legal Name)",
	"Provider First Name",
	"Provider First Line Business Practice Location Address",
	"Provider Second Line Business Practice Location Address",
	"Provider Business Practice Location Address City Name",
	"Provider Business Practice Location Address State Name",
	// CMS's own spelling.
	// This fixture carried `Postcode` after a vocabulary sweep rewrote both it and the adapter,
	// so the two agreed with each other and with no file CMS publishes.
	// Every test here passed while the adapter read 11.4 GB of real NPPES and emitted zero rows.
	"Provider Business Practice Location Address Postal Code",
].join(",")

let scratch: PathBuilderLike

beforeEach(async () => {
	scratch = fixtures.use(await temporaryDirectory("mailwoman-nppes-")).path
})

function writeCSV(...lines: string[]): Promise<string> {
	return writeDelimitedFixture(join(scratch, "test.csv"), CSV_HEADER, lines)
}

describe("usgov-nppes adapter", () => {
	it("has the expected id and license", () => {
		const a = createUsgovNPPESAdapter()
		expect(a.id).toBe(USGOV_NPPES_ADAPTER_ID)
		expect(a.defaultLicense).toBe(USGOV_NPPES_DEFAULT_LICENSE)
	})

	it("refuses a file whose practice-location column it cannot find, rather than emitting zero rows", async () => {
		// The shape that cost a corpus build its NPPES source: a vocabulary sweep rewrote
		// `Postal Code` to `Postcode` in the adapter on 2026-09-11.
		// `record[…]` then read `undefined` on every row, the row filter dropped all of them,
		// and the run reported `yielded: 0` after reading 11.4 GB in 354 seconds without raising.
		// A rename now names the column it broke.
		const swept = CSV_HEADER.replace(
			"Provider Business Practice Location Address Postal Code",
			"Provider Business Practice Location Address Postcode"
		)

		const path = await writeDelimitedFixture(join(scratch, "swept.csv"), swept, [
			"1000000001,2,METRO HEALTH SYSTEM,,,1234 MAIN ST,SUITE 200,NASHVILLE,TN,37203",
		])

		const adapter = createUsgovNPPESAdapter()

		await expect(async () => {
			for await (const _row of adapter.rows({ inputPath: path })) {
				// The refusal lands on the first record, so the loop body never runs.
			}
		}).rejects.toThrow(/Postal Code/)
	})

	it("emits a row for a provider organization with full address", async () => {
		const p = await writeCSV("1000000001,2,METRO HEALTH SYSTEM,,,1234 MAIN ST,SUITE 200,NASHVILLE,TN,37203")
		const a = createUsgovNPPESAdapter()
		const rows = []

		for await (const r of a.rows({ inputPath: p, limit: 5 })) {
			rows.push(r)
		}

		expect(rows).toHaveLength(1)
		const r = rows[0]!
		expect(r.country).toBe("US")
		expect(r.source).toBe(USGOV_NPPES_ADAPTER_ID)
		expect(r.components.venue).toBe("METRO HEALTH SYSTEM")
		expect(r.components.locality).toBe("NASHVILLE")
		expect(r.components.region).toBe("TN")
		expect(r.components.postcode).toBe("37203")
		expect(r.components.house_number).toBe("1234")
		expect(r.components.street).toContain("MAIN ST")
	})

	it("emits a row for an individual provider", async () => {
		const p = await writeCSV("1000000002,1,,SMITH,JANE,5678 OAK AVE,,PORTLAND,OR,97201")
		const a = createUsgovNPPESAdapter()
		const rows = []

		for await (const r of a.rows({ inputPath: p, limit: 5 })) {
			rows.push(r)
		}

		expect(rows).toHaveLength(1)
		const r = rows[0]!
		expect(r.country).toBe("US")
		expect(r.components.venue).toBe("JANE SMITH")
		expect(r.components.locality).toBe("PORTLAND")
	})

	it("skips rows with missing city or postcode", async () => {
		const p = await writeCSV(
			"1000000003,1,,DOE,JOHN,999 NOWHERE LN,,,OR,",
			"1000000004,2,ACME CORP,,,100 REAL ST,,REALTOWN,CA,90210"
		)

		const a = createUsgovNPPESAdapter()
		const rows = []

		for await (const r of a.rows({ inputPath: p, limit: 5 })) {
			rows.push(r)
		}

		expect(rows).toHaveLength(1)
		expect(rows[0]!.components.venue).toBe("ACME CORP")
	})

	it("skips rows with unrecognized state", async () => {
		const p = await writeCSV("1000000005,2,BAD CORP,,,1 FAKE ST,,NOWHERE,ZZ,00000")
		const a = createUsgovNPPESAdapter()
		const rows = []

		for await (const r of a.rows({ inputPath: p, limit: 5 })) {
			rows.push(r)
		}

		expect(rows).toHaveLength(0)
	})

	it("rejects non-US country filter", async () => {
		const a = createUsgovNPPESAdapter()

		await expect(
			(async () => {
				for await (const _ of a.rows({ inputPath: "/dev/null", country: "FR" }));
			})()
		).rejects.toThrow(/only US supported/)
	})

	it("registers cleanly with an InMemoryAdapterRegistry", () => {
		const registry = new InMemoryAdapterRegistry()
		registry.register(createUsgovNPPESAdapter())
		expect(registry.get(USGOV_NPPES_ADAPTER_ID)?.id).toBe(USGOV_NPPES_ADAPTER_ID)
	})

	it("honors limit", async () => {
		const p = await writeCSV(
			"1000000001,2,A CORP,,,1 A ST,,CITYA,CA,90001",
			"1000000002,2,B CORP,,,2 B ST,,CITYB,CA,90002",
			"1000000003,2,C CORP,,,3 C ST,,CITYC,CA,90003"
		)

		const a = createUsgovNPPESAdapter()
		const rows = []

		for await (const r of a.rows({ inputPath: p, limit: 2 })) {
			rows.push(r)
		}

		expect(rows).toHaveLength(2)
	})
})
