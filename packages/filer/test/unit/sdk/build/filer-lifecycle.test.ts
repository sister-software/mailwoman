/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file `buildFilerDatabase`'s Form 499 lifecycle writes — cessation windows and supersession edges.
 *
 *   Kept out of `build-filer.test.ts` because every case here turns on `Form499Row.lifecycle`, which only
 *   the workbook reader populates. The 17-column TSV path leaves it `undefined`, and the last describe
 *   below pins that a TSV-shaped row still produces byte-identical output.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { toFRN } from "@mailwoman/filer/frn"
import { type FilerDatabase, FilerIdentifierType, FilerRelationship } from "@mailwoman/filer/schema"
import { buildFilerDatabase } from "@mailwoman/filer/sdk/build-filer"
import type { Form499Row } from "@mailwoman/filer/sdk/form499"
import { parseForm499Notes } from "@mailwoman/filer/sdk/form499-notes"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("filer-lifecycle-")
})

afterEach(() => scratch[Symbol.asyncDispose]())

const FRN_CEASED = toFRN("0000000101")!
const FRN_LIVE = toFRN("0000000102")!

function filerRow(overrides: Partial<Form499Row> & Pick<Form499Row, "form499ID">): Form499Row {
	return {
		frn: FRN_LIVE,
		lastFiledAt: "2020-04-01",
		usfContributor: true,
		legalNameOfCarrier: "Example Telecom LLC",
		doingBusinessAs: "",
		principalCommType: "Incumbent LEC",
		holdingCompany: "Example Holdings Inc",
		managementCompany: "",
		hqAddress: "",
		customerInquiriesTelephone: "",
		customerInquiriesAddress: "",
		dcAgentDisplayName: "",
		dcAgentOrganizationName: "",
		dcAgentTelephone: "",
		dcAgentEmailAddress: "",
		dcAgentAddress: "",
		...overrides,
	}
}

async function build(rows: Form499Row[]) {
	const out = scratch.resolve("filer.db")

	const result = await buildFilerDatabase({
		form499Rows: rows,
		out,
		sourceVintage: "test",
		validFrom: "2020-01-01",
		buildSHA: "deadbeef",
	})

	await using db = new DatabaseClient<FilerDatabase>(out, { readOnly: true })

	const edges = db
		.prepare("SELECT from_node_id, to_node_id, relationship, valid_from, valid_to FROM filer_edge ORDER BY 1, 2, 3")
		.all() as Array<{
		from_node_id: string
		to_node_id: string
		relationship: string
		valid_from: string
		valid_to: string | null
	}>

	const attributes = db.prepare("SELECT node_id, key, value FROM filer_attribute ORDER BY 1, 2, 3").all() as Array<{
		node_id: string
		key: string
		value: string
	}>

	return { result, edges, attributes }
}

describe("cessation closes a relationship window — when the two dates order coherently", () => {
	it("closes the holding-company edge at the cessation date", async () => {
		const { result, edges } = await build([
			filerRow({
				form499ID: "900001",
				frn: FRN_CEASED,
				lastFiledAt: "2018-04-01",
				lifecycle: parseForm499Notes(["No longer active as of 12/31/2018"]),
			}),
		])

		const holding = edges.find((edge) => edge.relationship === FilerRelationship.HoldingCompany)

		expect(holding).toMatchObject({ valid_from: "2018-04-01", valid_to: "2018-12-31" })
		expect(result.closedByCessation).toBe(1)
		expect(result.cessationWindowAbstained).toBe(0)
	})

	it("leaves the IDENTITY edge open — an identifier mapping does not expire when the company does", async () => {
		const { edges } = await build([
			filerRow({
				form499ID: "900001",
				frn: FRN_CEASED,
				lastFiledAt: "2018-04-01",
				lifecycle: parseForm499Notes(["No longer active as of 12/31/2018"]),
			}),
		])

		const identity = edges.find((edge) => edge.relationship === FilerRelationship.SameEntity)

		expect(identity?.valid_to).toBeNull()
	})
})

describe("cessation ABSTAINS rather than asserting an incoherent window", () => {
	it("leaves the window open when the cessation date PREDATES the last filing", async () => {
		// Form 499 is an annual filing, so a carrier that ceased in September still files the next April.
		// 3,916 of 9,706 dated cessations in the 2025-12-07 vintage look like this.
		const { result, edges } = await build([
			filerRow({
				form499ID: "900002",
				frn: FRN_CEASED,
				lastFiledAt: "2014-04-01",
				lifecycle: parseForm499Notes(["No longer active as of 9/8/2013"]),
			}),
		])

		const holding = edges.find((edge) => edge.relationship === FilerRelationship.HoldingCompany)

		// An inverted window matches NOTHING under `valid_from <= t < valid_to` — the filer would vanish
		// from every asOf read with no error to notice. Open is visibly incomplete; inverted is invisible.
		expect(holding?.valid_to).toBeNull()
		expect(result.cessationWindowAbstained).toBe(1)
		expect(result.closedByCessation).toBe(0)
	})

	it("abstains on a same-day cessation, which would be an EMPTY window", async () => {
		const { result } = await build([
			filerRow({
				form499ID: "900003",
				frn: FRN_CEASED,
				lastFiledAt: "2018-12-31",
				lifecycle: parseForm499Notes(["No longer active as of 12/31/2018"]),
			}),
		])

		expect(result.cessationWindowAbstained).toBe(1)
		expect(result.closedByCessation).toBe(0)
	})

	it("still records the date as an attribute when the window abstains — the fact is never lost", async () => {
		const { attributes } = await build([
			filerRow({
				form499ID: "900002",
				frn: FRN_CEASED,
				lastFiledAt: "2014-04-01",
				lifecycle: parseForm499Notes(["No longer active as of 9/8/2013"]),
			}),
		])

		expect(attributes).toContainEqual({
			node_id: `${FilerIdentifierType.Form499ID}:900002`,
			key: "ceased_at",
			value: "2013-09-08",
		})
	})

	it("records the FCC's own cessation reasons as attributes", async () => {
		const { attributes } = await build([
			filerRow({
				form499ID: "900004",
				frn: FRN_CEASED,
				lifecycle: parseForm499Notes([
					"No longer active as of 12/31/2021",
					"All assets of this company have been sold to another party.",
				]),
			}),
		])

		const reasons = attributes.filter((attribute) => attribute.key === "cessation_reason").map((a) => a.value)

		expect(reasons).toContain("no-longer-active")
		expect(reasons).toContain("assets-sold")
	})
})

describe("supersession edges", () => {
	it("writes an edge from the OLDER registration to its successor", async () => {
		const { result, edges } = await build([
			filerRow({
				form499ID: "801004",
				frn: FRN_CEASED,
				lastFiledAt: "2014-04-01",
				lifecycle: parseForm499Notes(["No longer active as of 9/8/2013", "Replaced by filer 821002"]),
			}),
		])

		const superseded = edges.find((edge) => edge.relationship === FilerRelationship.SupersededBy)

		expect(superseded).toMatchObject({
			from_node_id: `${FilerIdentifierType.Form499ID}:801004`,
			to_node_id: `${FilerIdentifierType.Form499ID}:821002`,
			// Effective when the FCC said the filer ceased, not when it last filed.
			valid_from: "2013-09-08",
			valid_to: null,
		})

		expect(result.supersessions).toBe(1)
	})

	it("falls back to the filing date when no cessation date was stated", async () => {
		const { edges } = await build([
			filerRow({
				form499ID: "900005",
				frn: FRN_CEASED,
				lastFiledAt: "2016-04-01",
				lifecycle: parseForm499Notes(["Replaced by filer 900006"]),
			}),
		])

		expect(edges.find((edge) => edge.relationship === FilerRelationship.SupersededBy)?.valid_from).toBe("2016-04-01")
	})

	it("mints the successor node even when its own row never appears", async () => {
		// 6 of 2,826 targets in the real vintage dangle. The edge is still what the FCC stated.
		const { edges } = await build([
			filerRow({
				form499ID: "900007",
				frn: FRN_CEASED,
				lifecycle: parseForm499Notes(["Replaced by filer 999999"]),
			}),
		])

		expect(edges.some((edge) => edge.to_node_id === `${FilerIdentifierType.Form499ID}:999999`)).toBe(true)
	})

	it("does not write a supersession edge for a filer with no such note", async () => {
		const { result, edges } = await build([filerRow({ form499ID: "900008" })])

		expect(edges.some((edge) => edge.relationship === FilerRelationship.SupersededBy)).toBe(false)
		expect(result.supersessions).toBe(0)
	})
})

describe("a TSV-shaped row is unaffected", () => {
	it("writes no lifecycle attribute, no supersession, and closes no window", async () => {
		// `lifecycle` is undefined for every row parseForm499 produces — the TSV has no note columns.
		const { result, edges, attributes } = await build([filerRow({ form499ID: "900009" })])

		expect(result.closedByCessation).toBe(0)
		expect(result.cessationWindowAbstained).toBe(0)
		expect(result.supersessions).toBe(0)
		expect(edges.every((edge) => edge.valid_to === null)).toBe(true)
		expect(attributes.some((attribute) => attribute.key === "ceased_at")).toBe(false)
	})
})
