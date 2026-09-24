/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build and seal `filer.db` from Form 499, BDC provider-list, and optional EDGAR Exhibit 21 rows.
 *   Node, edge, and family tables deduplicate through their primary keys; attributes use a staging table
 *   keyed by `(node_id, key, value, source, source_vintage)` before materialization.
 *
 *   Form 499 and provider-list edges are authoritative. Exhibit 21 always contributes an authoritative
 *   disclosure edge; a unique canonical-name match may add an inferred FRN-to-CIK edge and family row.
 *   Registered-agent fields are stored as attributes only. Invalid identifiers and required dates fail
 *   loudly, while a missing optional FRN is counted as skipped.
 *
 *   Each build replaces the output with a complete single-vintage snapshot. The build uses a temporary
 *   file, writes the manifest, seals the database, then swaps it into place.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { removePath, movePath, makeDirectories } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { countRows } from "@mailwoman/sqlite"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"
import { dirname, type PathBuilderLike } from "path-ts"

import {
	createFilerAttributeNodeIndex,
	createFilerClusterIndex,
	createFilerEdgeToNodeIndex,
	createFilerFamilyIndex,
	FILER_SCHEMA_VERSION,
	FilerEdgeAssertion,
	FilerIdentifierType,
	FilerRelationship,
	type FilerDatabase,
} from "#schema"
import { groupFRNsByCanonicalLegalName } from "#sdk/build/edgar/match"
import { processEdgarSubsidiaryRow, type EdgarSubsidiaryRow } from "#sdk/build/edgar/rows"
import { insertFamilyMembership } from "#sdk/build/family-membership"
import {
	processForm499FRNRelationships,
	processForm499Lifecycle,
	type Form499LifecycleTotals,
} from "#sdk/build/form499-rows"
import {
	assertLastFiledAt,
	assertProviderValidFrom,
	mintForm499NodeID,
	mintFRNNodeID,
	mintHoldingCompanyNodeID,
	mintProviderNodeID,
} from "#sdk/build/node-ids"
import { createFilerBuildTables } from "#sdk/build/tables"
import { classifyFiler, parseForm499, type Form499Row } from "#sdk/form499/index"
import { assertISODate } from "#sdk/guards"
import { parseProviderList, type ProviderListRow } from "#sdk/provider-list"

// Keep the validated EDGAR row type available from the published build-filer entrypoint.
export type { EdgarSubsidiaryRow } from "#sdk/build/edgar/rows"

/**
 * Source rows per transaction batch; one row may execute multiple inserts.
 */
const STAGE_BATCH_SIZE = 10_000

export interface BuildFilerOptions {
	/**
	 * Injected Form 499 rows; takes precedence over `form499Path`.
	 */
	form499Rows?: AsyncIterable<Form499Row> | Iterable<Form499Row>
	/**
	 * Injected provider-list rows; takes precedence over `providerListPath`.
	 */
	providerRows?: AsyncIterable<ProviderListRow> | Iterable<ProviderListRow>
	/**
	 * Injected Exhibit 21 rows; Form 499 rows enable corroboration, otherwise only disclosures are linked.
	 */
	edgarRows?: AsyncIterable<EdgarSubsidiaryRow> | Iterable<EdgarSubsidiaryRow>
	/**
	 * Form 499 TSV path; ignored when `form499Rows` is supplied.
	 */
	form499Path?: string
	/**
	 * BDC provider-list CSV path; ignored when `providerRows` is supplied.
	 */
	providerListPath?: string
	/**
	 * Output path for the completed build.
	 */
	out: PathBuilderLike
	/**
	 * Build vintage for the manifest and provider-list edges; rebuilding replaces the prior snapshot.
	 */
	sourceVintage: string
	/**
	 * ISO `valid_from` date for provider-list edges; required with that input.
	 *
	 * Ignored otherwise and never inferred from the free-form `sourceVintage`.
	 */
	validFrom?: string
	/**
	 * Short Git revision supplied by the caller.
	 */
	buildSHA: string
	onProgress?: (message: string) => void
}

export interface BuildFilerResult {
	out: string
	/**
	 * Distinct nodes after primary-key deduplication.
	 */
	nodes: number
	/**
	 * Distinct edges after primary-key deduplication.
	 */
	edges: number
	/**
	 * Distinct attributes after staging-table deduplication.
	 */
	attributes: number
	/**
	 * Distinct family memberships after primary-key deduplication.
	 */
	families: number
	/**
	 * Optional edge opportunities skipped because a source field was empty or null.
	 * Each occurrence counts.
	 */
	skipped: number
	/**
	 * Edges closed by a Form 499 cessation note.
	 */
	closedByCessation: number
	/**
	 * Cessations with `ceasedAt <= lastFiledAt` cannot close a valid temporal window.
	 * Their dates remain `ceased_at` attributes.
	 */
	cessationWindowAbstained: number
	/**
	 * `SupersededBy` edges from filer replacement notes.
	 */
	supersessions: number
}

/**
 * Build, seal, and install a `filer.db` snapshot from the configured row sources.
 */
export async function buildFilerDatabase(options: BuildFilerOptions): Promise<BuildFilerResult> {
	const progress = options.onProgress ?? (() => {})

	const hasForm499Source = Boolean(options.form499Rows ?? options.form499Path)
	const hasProviderSource = Boolean(options.providerRows ?? options.providerListPath)
	const hasEdgarSource = Boolean(options.edgarRows)

	if (!hasForm499Source && !hasProviderSource && !hasEdgarSource) {
		throw new Error(
			"buildFilerDatabase: pass at least one of form499Rows/form499Path, providerRows/providerListPath, or edgarRows"
		)
	}

	// Validate the date before I/O only when provider-list input is enabled.
	const providerValidFrom = hasProviderSource ? assertProviderValidFrom(options.validFrom) : null

	const buildingPath = `${options.out}.building`

	if (await pathExists(buildingPath)) {
		await removePath(buildingPath)
	}

	await makeDirectories(dirname(options.out))

	const form499Source: AsyncIterable<Form499Row> | Iterable<Form499Row> =
		options.form499Rows ?? (options.form499Path ? parseForm499(options.form499Path) : [])

	const providerSource: AsyncIterable<ProviderListRow> | Iterable<ProviderListRow> =
		options.providerRows ?? (options.providerListPath ? parseProviderList(options.providerListPath) : [])

	const edgarSource: AsyncIterable<EdgarSubsidiaryRow> | Iterable<EdgarSubsidiaryRow> = options.edgarRows ?? []

	const lifecycleTotals: Form499LifecycleTotals = { closed: 0, abstained: 0, supersessions: 0 }
	let skipped = 0

	/**
	 * Table counts retained after closing the build connection.
	 */
	let materialized: { nodes: number; edges: number; attributes: number; families: number }

	{
		using kdb = new DatabaseClient<FilerDatabase>(buildingPath)
		// Apply bulk-build SQLite settings.
		kdb.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")

		progress("creating manifest/node/edge/attribute/cluster/family/attribute-stage tables")
		await createFilerBuildTables(kdb)

		const insNode = kdb.prepare(
			`INSERT OR IGNORE INTO filer_node (node_id, identifier_type, identifier_value) VALUES (?, ?, ?)`
		)

		// Identity links use SameEntity; company links use their specific relationship types.
		const insEdge = kdb.prepare(
			`INSERT OR IGNORE INTO filer_edge (
				from_node_id, to_node_id, assertion, relationship, source, source_vintage, valid_from, valid_to, match_score, evidence
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)

		// The family table's composite primary key provides deduplication, including naming provenance.
		const insFamily = kdb.prepare(
			`INSERT OR IGNORE INTO filer_family (
				node_id, family_id, naming_node_id, assertion, relationship, source, source_vintage, valid_from, valid_to, match_score
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)

		const insAttrStage = kdb.prepare(
			`INSERT OR IGNORE INTO filer_attribute_stage (node_id, key, value, source, source_vintage) VALUES (?, ?, ?, ?, ?)`
		)

		let batch = 0

		function commitBatch(): void {
			batch++

			if (batch >= STAGE_BATCH_SIZE) {
				kdb.exec("COMMIT")
				kdb.exec("BEGIN")
				batch = 0
			}
		}

		function stageAttribute(nodeID: string, key: string, value: string, source: string, sourceVintage: string): void {
			if (!value) return

			insAttrStage.run(nodeID, key, value, source, sourceVintage)
		}

		progress("staging nodes/edges/attributes — raw prepared INSERT OR IGNORE")
		kdb.exec("BEGIN")

		// Retain each FRN's latest Form 499 legal name for the later EDGAR corroboration pass.
		const legalNameByFRN = new Map<string, { name: string; filedAt: string }>()

		let form499RowIndex = 0

		for await (const row of form499Source) {
			form499RowIndex++

			const form499NodeID = mintForm499NodeID(row.form499ID, form499RowIndex)
			insNode.run(form499NodeID, FilerIdentifierType.Form499ID, row.form499ID)

			// Validate the date before using it for source vintage and temporal fields.
			const lastFiledAt = assertISODate(
				assertLastFiledAt(row.lastFiledAt, row.form499ID, form499RowIndex),
				`form499 row #${form499RowIndex} (form499ID=${stringifyJSON(row.form499ID)}) lastFiledAt`
			)

			// Attributes attach to the always-present Form 499 node; DC-agent fields remain attributes, not edges.
			stageAttribute(form499NodeID, "legal_name", row.legalNameOfCarrier, "form-499", lastFiledAt)
			stageAttribute(form499NodeID, "dba", row.doingBusinessAs, "form-499", lastFiledAt)

			for (const classification of classifyFiler(row)) {
				stageAttribute(form499NodeID, "classification", classification, "form-499", lastFiledAt)
			}

			stageAttribute(form499NodeID, "hq_address", row.hqAddress, "form-499", lastFiledAt)

			stageAttribute(
				form499NodeID,
				"customer_inquiries_telephone",
				row.customerInquiriesTelephone,
				"form-499",
				lastFiledAt
			)

			stageAttribute(form499NodeID, "customer_inquiries_address", row.customerInquiriesAddress, "form-499", lastFiledAt)

			stageAttribute(form499NodeID, "dc_agent_display_name", row.dcAgentDisplayName, "form-499", lastFiledAt)

			stageAttribute(form499NodeID, "dc_agent_organization_name", row.dcAgentOrganizationName, "form-499", lastFiledAt)

			stageAttribute(form499NodeID, "dc_agent_telephone", row.dcAgentTelephone, "form-499", lastFiledAt)
			stageAttribute(form499NodeID, "dc_agent_email_address", row.dcAgentEmailAddress, "form-499", lastFiledAt)
			stageAttribute(form499NodeID, "dc_agent_address", row.dcAgentAddress, "form-499", lastFiledAt)

			// Lifecycle notes are available in workbook input, but not in the 17-column TSV.
			const relationshipValidTo = processForm499Lifecycle(insNode, insEdge, stageAttribute, lifecycleTotals, {
				lifecycle: row.lifecycle,
				form499NodeID,
				lastFiledAt,
			})

			if (row.frn) {
				skipped += processForm499FRNRelationships(insNode, insEdge, insFamily, legalNameByFRN, {
					row,
					frn: row.frn,
					form499NodeID,
					form499RowIndex,
					lastFiledAt,
					relationshipValidTo,
				})
			} else {
				// Missing FRNs are valid; the row cannot produce FRN-anchored edges.
				skipped++
			}

			commitBatch()
		}

		let providerRowIndex = 0

		for await (const row of providerSource) {
			providerRowIndex++

			const providerNodeID = mintProviderNodeID(row.providerID, providerRowIndex)
			insNode.run(providerNodeID, FilerIdentifierType.BDCProviderID, String(row.providerID))

			const frnNodeID = mintFRNNodeID(row.frn, `provider-list row #${providerRowIndex} (providerID=${row.providerID})`)
			insNode.run(frnNodeID, FilerIdentifierType.FRN, row.frn)

			// Keep the free-form source vintage separate from the validated temporal date.
			insEdge.run(
				providerNodeID,
				frnNodeID,
				FilerEdgeAssertion.Authoritative,
				FilerRelationship.SameEntity,
				"bdc-provider-list",
				options.sourceVintage,
				providerValidFrom!,
				null,
				null,
				null
			)

			if (row.holdingCompany) {
				const holdingNodeID = mintHoldingCompanyNodeID(row.holdingCompany)
				insNode.run(holdingNodeID, FilerIdentifierType.HoldingCompanyName, row.holdingCompany)

				insEdge.run(
					providerNodeID,
					holdingNodeID,
					FilerEdgeAssertion.Authoritative,
					FilerRelationship.HoldingCompany,
					"bdc-provider-list",
					options.sourceVintage,
					providerValidFrom!,
					null,
					null,
					null
				)

				insertFamilyMembership(insFamily, {
					memberNodeID: providerNodeID,
					namingNodeID: holdingNodeID,
					identifierType: FilerIdentifierType.HoldingCompanyName,
					name: row.holdingCompany,
					relationship: FilerRelationship.HoldingCompany,
					assertion: FilerEdgeAssertion.Authoritative,
					matchScore: null,
					source: "bdc-provider-list",
					sourceVintage: options.sourceVintage,
					validFrom: providerValidFrom!,
				})
			} else {
				skipped++
			}

			commitBatch()
		}

		// Build the canonical-name buckets after collecting all Form 499 names.
		const frnsByCanonicalLegalName = groupFRNsByCanonicalLegalName(legalNameByFRN)

		let edgarRowIndex = 0

		for await (const row of edgarSource) {
			edgarRowIndex++
			processEdgarSubsidiaryRow(insNode, insEdge, insFamily, frnsByCanonicalLegalName, row, edgarRowIndex)
			commitBatch()
		}

		kdb.exec("COMMIT")

		const stagedCountRow = kdb.prepare("SELECT COUNT(*) AS staged_count FROM filer_attribute_stage").get() as {
			staged_count: number
		}

		progress(`staged ${stagedCountRow.staged_count.toLocaleString()} distinct attribute fact(s)`)

		progress("materializing filer_attribute from the staged, deduped facts")

		kdb.exec(
			`INSERT INTO filer_attribute (node_id, key, value, source, source_vintage)
			 SELECT node_id, key, value, source, source_vintage FROM filer_attribute_stage`
		)

		await kdb.schema.dropTable("filer_attribute_stage").execute()

		progress("index-after-load")
		await createFilerEdgeToNodeIndex(kdb)
		await createFilerAttributeNodeIndex(kdb)
		await createFilerClusterIndex(kdb)
		await createFilerFamilyIndex(kdb)

		const sourcesUsed: string[] = []

		if (hasForm499Source) {
			sourcesUsed.push("form-499")
		}

		if (hasProviderSource) {
			sourcesUsed.push("bdc-provider-list")
		}

		if (hasEdgarSource) {
			sourcesUsed.push("edgar-exhibit-21")
		}

		progress("writing filer_manifest")

		await kdb
			.insertInto("filer_manifest")
			.values({
				name: "filer",
				// Use the source vintage until filer.db has independent versioning.
				version: options.sourceVintage,
				// Readers can use this version to detect temporal-schema support.
				schema_version: FILER_SCHEMA_VERSION,
				source: sourcesUsed.join(","),
				source_vintage: options.sourceVintage,
				// Record the API entrypoint that produced this artifact.
				build_cmd: "buildFilerDatabase (@mailwoman/filer/sdk)",
				build_sha: options.buildSHA,
				created_at: new Date().toISOString(),
			})
			.execute()

		materialized = {
			nodes: countRows(kdb, "filer_node"),
			edges: countRows(kdb, "filer_edge"),
			attributes: countRows(kdb, "filer_attribute"),
			families: countRows(kdb, "filer_family"),
		}

		progress(
			`materialized ${materialized.nodes.toLocaleString()} node(s), ${materialized.edges.toLocaleString()} edge(s), ` +
				`${materialized.attributes.toLocaleString()} attribute(s), ` +
				`${materialized.families.toLocaleString()} family membership(s) ` +
				`(${skipped.toLocaleString()} edge opportunity/ies skipped)`
		)

		progress("finalize: ANALYZE + VACUUM")
		kdb.exec("ANALYZE")
		// Set page size before VACUUM; node:sqlite initializes new files at 4096 bytes.
		kdb.exec("PRAGMA page_size=8192")
		kdb.exec("VACUUM")
	}

	progress("seal")
	await sealDatabase(buildingPath)

	// Move the previous artifact aside before installing the sealed build.
	if (await pathExists(options.out)) {
		await movePath(options.out, `${options.out}.prev`)
	}

	await movePath(buildingPath, options.out)

	if (await pathExists(`${options.out}.prev`)) {
		await removePath(`${options.out}.prev`)
	}

	return {
		out: options.out.toString(),
		nodes: materialized.nodes,
		edges: materialized.edges,
		attributes: materialized.attributes,
		families: materialized.families,
		skipped,
		closedByCessation: lifecycleTotals.closed,
		cessationWindowAbstained: lifecycleTotals.abstained,
		supersessions: lifecycleTotals.supersessions,
	}
}
