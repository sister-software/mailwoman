/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests for {@linkcode buildFilerDatabase} — the stage/materialize/seal build of `filer.db` (3a Task
 *   5). Feeds the loader synthetic {@link Form499Row}/{@link ProviderListRow} sources directly (the
 *   `form499Rows`/`providerRows` seams), so the suite exercises the whole build WITHOUT touching the
 *   filesystem — matches `build-bdc.test.ts`'s injected-row convention.
 */

import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { describe, expect, it } from "vitest"

import { FilerIdentifierType, readFilerManifest, type FilerDatabase } from "../schema.ts"
import { buildFilerDatabase, type BuildFilerResult } from "./build-filer.ts"
import type { Form499Row } from "./form499.ts"
import { toFRN } from "./frn.ts"
import type { ProviderListRow } from "./provider-list.ts"

const FRN_ACME = toFRN("0001753557")!
const FRN_BDC_ONLY = toFRN("0009999999")!
const FRN_GAMMA = toFRN("0005555555")!

/**
 * Row A: a fully-populated 499 filing — FRN present, both company fields present, every attribute-bearing field
 * populated. Row B: an unregistered filer (no FRN — legitimate per decision 3, NOT malformed) with most optional fields
 * blank.
 */
function form499FixtureRows(): Form499Row[] {
	return [
		{
			form499ID: "899901",
			frn: FRN_ACME,
			lastFiledAt: "2026-01-15",
			usfContributor: true,
			legalNameOfCarrier: "Acme Telecom LLC",
			doingBusinessAs: "Acme Fiber",
			principalCommType: "Incumbent Local Exchange Carrier",
			holdingCompany: "Acme Holdings Inc",
			managementCompany: "Acme Management Co",
			hqAddress: "123 Main St",
			customerInquiriesTelephone: "555-1000",
			customerInquiriesAddress: "123 Main St",
			dcAgentDisplayName: "John Doe",
			dcAgentOrganizationName: "CT Corporation",
			dcAgentTelephone: "555-2000",
			dcAgentEmailAddress: "agent@ctcorp.com",
			dcAgentAddress: "456 Agent Ave",
		},
		{
			form499ID: "899902",
			frn: null,
			lastFiledAt: "2026-02-01",
			usfContributor: false,
			legalNameOfCarrier: "Beta Networks",
			doingBusinessAs: "",
			principalCommType: "CLEC",
			holdingCompany: "",
			managementCompany: "",
			hqAddress: "789 Beta Blvd",
			customerInquiriesTelephone: "",
			customerInquiriesAddress: "",
			dcAgentDisplayName: "",
			dcAgentOrganizationName: "",
			dcAgentTelephone: "",
			dcAgentEmailAddress: "",
			dcAgentAddress: "",
		},
	]
}

/**
 * `providerID` 130077 carries TWO rows with different FRNs (decision 6 cardinality — must survive as two distinct
 * edges, never folded/last-wins). Row 2's `holdingCompany` is `null` (legitimate — must be counted as `skipped`, never
 * thrown). `providerID` 130080 is a second, independent provider.
 */
function providerFixtureRows(): ProviderListRow[] {
	return [
		{ providerID: 130_077, frn: FRN_ACME, holdingCompany: "Acme Holdings Inc" },
		{ providerID: 130_077, frn: FRN_BDC_ONLY, holdingCompany: null },
		{ providerID: 130_080, frn: FRN_GAMMA, holdingCompany: "Gamma Corp" },
	]
}

let scratch: string
let out: string

async function setupScratch(): Promise<void> {
	scratch = await mkdtemp(join(tmpdir(), "filer-build-"))
	out = join(scratch, "filer.db")
}

async function teardownScratch(): Promise<void> {
	await rm(scratch, { recursive: true, force: true })
}

function openFilerDB(path: string): DatabaseClient<FilerDatabase> {
	return new DatabaseClient<FilerDatabase>({ database: new DatabaseSync(path, { readOnly: true }) })
}

describe("buildFilerDatabase", () => {
	it("builds a sealed file at `out`", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				form499Rows: form499FixtureRows(),
				providerRows: providerFixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				validFrom: "2026-01-31",
				buildSHA: "deadbeef",
			})

			expect(existsSync(out)).toBe(true)
			expect(existsSync(`${out}.building`)).toBe(false)
			expect(existsSync(`${out}.prev`)).toBe(false)
		} finally {
			await teardownScratch()
		}
	})

	it("emits FRN↔form499ID, FRN↔holdingCompanyName, and FRN↔managementCompanyName (both) for a filed 499 row", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				form499Rows: form499FixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)
			const frnNodeID = `${FilerIdentifierType.FRN}:${FRN_ACME}`

			const edges = await db.selectFrom("filer_edge").selectAll().where("from_node_id", "=", frnNodeID).execute()
			const toIDs = edges.map((e) => e.to_node_id).toSorted()

			expect(toIDs).toEqual(
				[
					`${FilerIdentifierType.Form499ID}:899901`,
					`${FilerIdentifierType.HoldingCompanyName}:Acme Holdings Inc`,
					`${FilerIdentifierType.ManagementCompanyName}:Acme Management Co`,
				].toSorted()
			)

			for (const edge of edges) {
				expect(edge.source).toBe("form-499")
				expect(edge.source_vintage).toBe("2026-01-15")
				expect(edge.valid_from).toBe("2026-01-15")
				expect(edge.assertion).toBe("authoritative")
			}
		} finally {
			await teardownScratch()
		}
	})

	it("records a 499 row with no FRN as a form499ID node with attributes, never throwing", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				form499Rows: form499FixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)

			const node = await db
				.selectFrom("filer_node")
				.selectAll()
				.where("node_id", "=", `${FilerIdentifierType.Form499ID}:899902`)
				.executeTakeFirst()

			expect(node).toBeDefined()

			const legalName = await db
				.selectFrom("filer_attribute")
				.selectAll()
				.where("node_id", "=", `${FilerIdentifierType.Form499ID}:899902`)
				.where("key", "=", "legal_name")
				.executeTakeFirstOrThrow()

			expect(legalName.value).toBe("Beta Networks")

			const classification = await db
				.selectFrom("filer_attribute")
				.selectAll()
				.where("node_id", "=", `${FilerIdentifierType.Form499ID}:899902`)
				.where("key", "=", "classification")
				.executeTakeFirstOrThrow()

			expect(classification.value).toBe("clec")
		} finally {
			await teardownScratch()
		}
	})

	it("a bdcProviderID with two FRNs yields two distinct bdcProviderID↔FRN edges (decision 6)", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				providerRows: providerFixtureRows(),
				out,
				sourceVintage: "2026-06-30",
				validFrom: "2026-06-30",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)
			const providerNodeID = `${FilerIdentifierType.BDCProviderID}:130077`

			const frnEdges = await db
				.selectFrom("filer_edge")
				.selectAll()
				.where("from_node_id", "=", providerNodeID)
				.where("to_node_id", "like", `${FilerIdentifierType.FRN}:%`)
				.execute()

			expect(frnEdges).toHaveLength(2)

			expect(frnEdges.map((e) => e.to_node_id).toSorted()).toEqual(
				[`${FilerIdentifierType.FRN}:${FRN_ACME}`, `${FilerIdentifierType.FRN}:${FRN_BDC_ONLY}`].toSorted()
			)
		} finally {
			await teardownScratch()
		}
	})

	it("emits bdcProviderID↔holdingCompanyName only when holdingCompany is present, counting the rest as skipped", async () => {
		await setupScratch()

		try {
			const result = await buildFilerDatabase({
				providerRows: providerFixtureRows(),
				out,
				sourceVintage: "2026-06-30",
				validFrom: "2026-06-30",
				buildSHA: "deadbeef",
			})

			// Row 2 (providerID 130077, frn FRN_BDC_ONLY) has holdingCompany: null — no edge, counted as skipped.
			expect(result.skipped).toBe(1)

			using db = openFilerDB(out)

			const holdingEdges = await db
				.selectFrom("filer_edge")
				.selectAll()
				.where("to_node_id", "like", `${FilerIdentifierType.HoldingCompanyName}:%`)
				.execute()

			// Only providerID 130077 (row 1, Acme Holdings Inc) and providerID 130080 (Gamma Corp).
			expect(holdingEdges).toHaveLength(2)
		} finally {
			await teardownScratch()
		}
	})

	it("every edge carries non-empty provenance (source, source_vintage, assertion, valid_from), and valid_from is always ISO YYYY-MM-DD even when sourceVintage is a non-ISO label", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				form499Rows: form499FixtureRows(),
				providerRows: providerFixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				validFrom: "2026-01-31",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)
			const edges = await db.selectFrom("filer_edge").selectAll().execute()

			expect(edges.length).toBeGreaterThan(0)

			for (const edge of edges) {
				expect(edge.source.length).toBeGreaterThan(0)
				expect(edge.source_vintage.length).toBeGreaterThan(0)
				expect(edge.assertion).toBe("authoritative")
				expect(edge.valid_from.length).toBeGreaterThan(0)
				// sourceVintage above ("2026-Q1") is deliberately NOT ISO — valid_from must never inherit that shape
				// (review fix, CRITICAL): every edge's valid_from is ISO YYYY-MM-DD regardless of source.
				expect(edge.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
			}
		} finally {
			await teardownScratch()
		}
	})

	it("never emits an edge derived from a DC-agent field", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				form499Rows: form499FixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				buildSHA: "deadbeef",
			})

			using db = openFilerDB(out)
			const edges = await db.selectFrom("filer_edge").selectAll().execute()

			for (const edge of edges) {
				expect(edge.from_node_id).not.toContain("CT Corporation")
				expect(edge.to_node_id).not.toContain("CT Corporation")
				expect(edge.from_node_id).not.toContain("John Doe")
				expect(edge.to_node_id).not.toContain("John Doe")
			}

			// DC-agent fields still recorded — but ONLY as plain attributes, never as relationship evidence.
			const dcAgentAttr = await db
				.selectFrom("filer_attribute")
				.selectAll()
				.where("key", "=", "dc_agent_organization_name")
				.executeTakeFirstOrThrow()

			expect(dcAgentAttr.value).toBe("CT Corporation")
		} finally {
			await teardownScratch()
		}
	})

	it("the manifest carries the build's source vintage and the sources actually used", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				form499Rows: form499FixtureRows(),
				providerRows: providerFixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				validFrom: "2026-01-31",
				buildSHA: "cafebabe",
			})

			using db = openFilerDB(out)
			const manifest = await readFilerManifest(db)

			expect(manifest.name).toBe("filer")
			expect(manifest.source_vintage).toBe("2026-Q1")
			expect(manifest.version).toBe("2026-Q1")
			expect(manifest.build_sha).toBe("cafebabe")
			expect(manifest.source).toBe("form-499,bdc-provider-list")
		} finally {
			await teardownScratch()
		}
	})

	it("the manifest's source lists only the sources actually supplied", async () => {
		await setupScratch()

		try {
			await buildFilerDatabase({
				providerRows: providerFixtureRows(),
				out,
				sourceVintage: "2026-Q1",
				validFrom: "2026-01-31",
				buildSHA: "cafebabe",
			})

			using db = openFilerDB(out)
			const manifest = await readFilerManifest(db)

			expect(manifest.source).toBe("bdc-provider-list")
		} finally {
			await teardownScratch()
		}
	})

	it("a malformed row (empty form499ID) is loud, and no artifact is left behind", async () => {
		await setupScratch()

		try {
			const malformedRows: Form499Row[] = [
				{
					...form499FixtureRows()[0]!,
					form499ID: "",
				},
			]

			await expect(
				buildFilerDatabase({
					form499Rows: malformedRows,
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})
			).rejects.toThrow(/malformed.*form499ID/i)

			expect(existsSync(out)).toBe(false)
		} finally {
			await teardownScratch()
		}
	})

	it("an empty lastFiledAt is loud — never produces a blank-provenance edge (decision 7 / gate 1, fix round 1)", async () => {
		await setupScratch()

		try {
			const malformedRows: Form499Row[] = [
				{
					...form499FixtureRows()[0]!,
					lastFiledAt: "",
				},
			]

			await expect(
				buildFilerDatabase({
					form499Rows: malformedRows,
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})
			).rejects.toThrow(/malformed.*lastFiledAt/i)

			expect(existsSync(out)).toBe(false)
		} finally {
			await teardownScratch()
		}
	})

	it("a blank provider-list frn is loud — never mints a shared degenerate FRN node (fix round 1)", async () => {
		await setupScratch()

		try {
			const malformedRows: ProviderListRow[] = [
				// Two DIFFERENT, unrelated providers, both with a blank frn — without the guard these would
				// silently share ONE degenerate `frn:` node, falsely asserting they are the same filer.
				{ providerID: 900_001, frn: "" as ProviderListRow["frn"], holdingCompany: null },
				{ providerID: 900_002, frn: "" as ProviderListRow["frn"], holdingCompany: null },
			]

			await expect(
				buildFilerDatabase({
					providerRows: malformedRows,
					out,
					sourceVintage: "2026-Q1",
					validFrom: "2026-01-31",
					buildSHA: "deadbeef",
				})
			).rejects.toThrow(/malformed.*empty frn/i)

			expect(existsSync(out)).toBe(false)
		} finally {
			await teardownScratch()
		}
	})

	it("throws when neither a 499 nor a provider-list source is supplied", async () => {
		await setupScratch()

		try {
			await expect(
				buildFilerDatabase({
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})
			).rejects.toThrow(/pass at least one/)
		} finally {
			await teardownScratch()
		}
	})

	describe("idempotent write path (carried from Task 4's review)", () => {
		/**
		 * A single fully-populated row, deliberately small so every count below is hand-verifiable: 3 nodes (form499ID,
		 * FRN, holdingCompanyName — managementCompany is blank, so NO management-company node/edge), 2 edges
		 * (FRN↔form499ID, FRN↔holdingCompanyName), 2 attributes (legal_name, classification), 1 skip (the blank
		 * managementCompany).
		 */
		function idempotencyFixtureRow(): Form499Row {
			return {
				form499ID: "700001",
				frn: toFRN("0001111111")!,
				lastFiledAt: "2026-03-01",
				usfContributor: true,
				legalNameOfCarrier: "Idem Co",
				doingBusinessAs: "",
				principalCommType: "",
				holdingCompany: "Idem Holdings",
				managementCompany: "",
				hqAddress: "",
				customerInquiriesTelephone: "",
				customerInquiriesAddress: "",
				dcAgentDisplayName: "",
				dcAgentOrganizationName: "",
				dcAgentTelephone: "",
				dcAgentEmailAddress: "",
				dcAgentAddress: "",
			}
		}

		it("collapses a same-source/same-vintage duplicate row within one build (filer_attribute has no PK of its own)", async () => {
			await setupScratch()

			try {
				const row = idempotencyFixtureRow()

				// The SAME row twice — simulates a same-source/same-vintage double-insert opportunity.
				const result = await buildFilerDatabase({
					form499Rows: [row, row],
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})

				expect(result.nodes).toBe(3)
				expect(result.edges).toBe(2)
				expect(result.attributes).toBe(2)
				expect(result.skipped).toBe(2)

				using db = openFilerDB(out)
				const nodeCount = await db.selectFrom("filer_node").select(db.fn.countAll().as("c")).executeTakeFirstOrThrow()
				const edgeCount = await db.selectFrom("filer_edge").select(db.fn.countAll().as("c")).executeTakeFirstOrThrow()

				const attrCount = await db
					.selectFrom("filer_attribute")
					.select(db.fn.countAll().as("c"))
					.executeTakeFirstOrThrow()

				expect(Number(nodeCount.c)).toBe(3)
				expect(Number(edgeCount.c)).toBe(2)
				expect(Number(attrCount.c)).toBe(2)
			} finally {
				await teardownScratch()
			}
		})

		it("re-running the same build inputs against the same `out` does not grow row counts", async () => {
			await setupScratch()

			try {
				const row = idempotencyFixtureRow()

				const first: BuildFilerResult = await buildFilerDatabase({
					form499Rows: [row, row],
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})

				const second: BuildFilerResult = await buildFilerDatabase({
					form499Rows: [row, row],
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})

				expect(second.nodes).toBe(first.nodes)
				expect(second.edges).toBe(first.edges)
				expect(second.attributes).toBe(first.attributes)
				expect(second.skipped).toBe(first.skipped)

				expect(first.nodes).toBe(3)
				expect(first.edges).toBe(2)
				expect(first.attributes).toBe(2)

				// The rebuild-and-swap discipline: no `.prev` left lingering.
				expect(existsSync(`${out}.prev`)).toBe(false)
			} finally {
				await teardownScratch()
			}
		})

		it("two DIFFERENT classification values under the same key/source/vintage both survive (not collapsed by the stage PK)", async () => {
			await setupScratch()

			try {
				// usfContributor: true + an Incumbent principalCommType -> two classification values
				// ("usf_contributor", "incumbent_lec") sharing (node_id, key="classification", source, source_vintage) —
				// only `value` differs. Proves the stage table's dedup key includes `value`, not just
				// (node_id, key, source, source_vintage), or the second classification would be silently dropped.
				const row: Form499Row = {
					...idempotencyFixtureRow(),
					principalCommType: "Incumbent Local Exchange Carrier",
				}

				await buildFilerDatabase({
					form499Rows: [row],
					out,
					sourceVintage: "2026-Q1",
					buildSHA: "deadbeef",
				})

				using db = openFilerDB(out)

				const classifications = await db
					.selectFrom("filer_attribute")
					.selectAll()
					.where("node_id", "=", `${FilerIdentifierType.Form499ID}:700001`)
					.where("key", "=", "classification")
					.execute()

				expect(classifications.map((c) => c.value).toSorted()).toEqual(["incumbent_lec", "usf_contributor"])
			} finally {
				await teardownScratch()
			}
		})
	})

	describe("single-vintage snapshot semantics (review MINOR-B, fix round 1)", () => {
		it("rebuilding at a later sourceVintage REPLACES the artifact — earlier-vintage rows do not survive", async () => {
			await setupScratch()

			try {
				await buildFilerDatabase({
					providerRows: [{ providerID: 500_001, frn: toFRN("0007777777")!, holdingCompany: "Old Co" }],
					out,
					sourceVintage: "2026-Q1",
					validFrom: "2026-01-31",
					buildSHA: "deadbeef",
				})

				await buildFilerDatabase({
					providerRows: [{ providerID: 500_002, frn: toFRN("0008888888")!, holdingCompany: "New Co" }],
					out,
					sourceVintage: "2026-Q2",
					validFrom: "2026-04-30",
					buildSHA: "deadbeef",
				})

				using db = openFilerDB(out)
				const edges = await db.selectFrom("filer_edge").selectAll().execute()

				// Every edge belongs to the SECOND build's vintage — none of the first build's rows survived
				// alongside it as additional rows (that would be cross-build accumulation, which this artifact
				// deliberately does not support — see the module docstring's MINOR-B note).
				expect(edges.length).toBeGreaterThan(0)
				expect(edges.every((e) => e.source_vintage === "2026-Q2")).toBe(true)

				const providerNodeIDs = (await db.selectFrom("filer_node").selectAll().execute()).map((n) => n.node_id)
				expect(providerNodeIDs).not.toContain(`${FilerIdentifierType.BDCProviderID}:500001`)
				expect(providerNodeIDs).toContain(`${FilerIdentifierType.BDCProviderID}:500002`)

				const manifest = await readFilerManifest(db)
				expect(manifest.source_vintage).toBe("2026-Q2")
			} finally {
				await teardownScratch()
			}
		})
	})
})
