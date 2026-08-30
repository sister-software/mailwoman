import { pathExists } from "@mailwoman/core/fs/readers"
import { removePath, movePath, makeDirectories } from "@mailwoman/core/fs/writers"
import { dirname } from "@mailwoman/platform/path"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { sealDatabase } from "@mailwoman/sqlite/sealed-db"

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
} from "../schema.ts"
import { groupFRNsByCanonicalLegalName } from "./build/edgar-match.ts"
import { processEdgarSubsidiaryRow, type EdgarSubsidiaryRow } from "./build/edgar-rows.ts"
import { insertFamilyMembership } from "./build/family-membership.ts"
import {
	processForm499FRNRelationships,
	processForm499Lifecycle,
	type Form499LifecycleTotals,
} from "./build/form499-rows.ts"
import {
	assertLastFiledAt,
	assertProviderValidFrom,
	mintForm499NodeID,
	mintFRNNodeID,
	mintHoldingCompanyNodeID,
	mintProviderNodeID,
} from "./build/node-ids.ts"
import { createFilerBuildTables } from "./build/tables.ts"
import { classifyFiler, parseForm499, type Form499Row } from "./form499.ts"
import { assertISODate } from "./guards.ts"
import { parseProviderList, type ProviderListRow } from "./provider-list.ts"

// `@mailwoman/filer/sdk/build-filer` is EdgarSubsidiaryRow's published home — `edgar-ingest.ts` and every consumer
// building rows for the `edgarRows` seam import it from here, so it stays exported from this module even though its
// declaration sits with the writer that validates it.
export type { EdgarSubsidiaryRow } from "./build/edgar-rows.ts"

/**
 * Rows committed per `BEGIN`/`COMMIT` batch — matches `build-bdc.ts`'s `STAGE_BATCH_SIZE` discipline. Counted per
 * SOURCE ROW processed (a single 499 row can trigger several node/edge/attribute-stage inserts), not per individual
 * `.run()` call.
 */
const STAGE_BATCH_SIZE = 10_000

export interface BuildFilerOptions {
	/**
	 * Injected Form 499 row source — the test seam. When given, `form499Path` is ignored and no filesystem read happens
	 * for this source.
	 */
	form499Rows?: AsyncIterable<Form499Row> | Iterable<Form499Row>
	/**
	 * Injected provider-list row source — the test seam. When given, `providerListPath` is ignored and no filesystem read
	 * happens for this source.
	 */
	providerRows?: AsyncIterable<ProviderListRow> | Iterable<ProviderListRow>
	/**
	 * Injected EDGAR Exhibit 21 subsidiary-disclosure source — see the module docstring's "EDGAR Exhibit 21 ingest"
	 * section. Subsidiary-name→FRN corroboration is matched against THIS SAME call's `form499Rows` (their
	 * `legalNameOfCarrier`) — an `edgarRows` source with no accompanying `form499Rows` still writes every disclosure
	 * edge, just with no corroborating FRN link possible.
	 */
	edgarRows?: AsyncIterable<EdgarSubsidiaryRow> | Iterable<EdgarSubsidiaryRow>
	/**
	 * Form 499 filer TSV path — read via {@linkcode parseForm499}. Ignored when `form499Rows` is given.
	 */
	form499Path?: string
	/**
	 * BDC provider-list CSV path — read via {@linkcode parseProviderList}. Ignored when `providerRows` is given.
	 */
	providerListPath?: string
	/**
	 * Output `filer.db` path. Built at `${out}.building` and moved into place last — see the module docstring.
	 */
	out: string
	/**
	 * The build's overall vintage — becomes the manifest's `version` AND `source_vintage` (filer.db has no independent
	 * versioning yet, same deferral `build-bdc.ts` makes for `bdc.db`'s `release`), AND the `source_vintage` (only — see
	 * {@link BuildFilerOptions.validFrom} for `valid_from`) for every provider-list-derived edge (decision 7 — the
	 * provider list carries no per-row date of its own). A free-text human vintage LABEL (`"2026-Q2"`) is fine here —
	 * this field is never written into a temporal (`valid_from`/`valid_to`) column, so it carries no ISO-shape
	 * requirement of its own.
	 *
	 * SNAPSHOT semantics (see the module docstring's MINOR-B note): calling {@linkcode buildFilerDatabase} again against
	 * the SAME `out` with a DIFFERENT `sourceVintage` REPLACES the artifact — it does not accumulate the earlier
	 * vintage's rows alongside the new ones. There is no options-level way to build a multi-vintage archive in one
	 * artifact; that would require rows spanning multiple vintages passed into a SINGLE call.
	 */
	sourceVintage: string
	/**
	 * ISO `YYYY-MM-DD` date for `valid_from` on every provider-list-derived edge — deliberately a SEPARATE field from
	 * {@link BuildFilerOptions.sourceVintage}, never derived from it. The provider list carries no per-row date, which
	 * makes the whole-file `sourceVintage` the tempting single source for BOTH `source_vintage` and `valid_from` — but
	 * `sourceVintage` is a free-text human vintage label (e.g. `"2026-Q2"`), not guaranteed ISO-sortable, while
	 * `valid_from` participates in every downstream `asOf`-scoped predicate (`filer-lookup.ts`'s `valid_from <= asOf`) as
	 * a plain STRING comparison. `"2026-Q2"` sorts lexicographically ABOVE any ISO date in its own year (`"Q"` outranks
	 * every digit at the first position where the two differ) — writing it into `valid_from` silently breaks every
	 * `asOf`-scoped read against that edge (reviewer probe: a fully populated filer.db built with `sourceVintage:
	 * "2026-Q2"` returned `identifiers: []` from `filerLookup`). Validated via {@linkcode assertISODate}. REQUIRED when
	 * `providerRows`/`providerListPath` is supplied (thrown otherwise); ignored when no provider-list source is given.
	 * Deliberately NOT derived automatically from `sourceVintage` when omitted — guessing a specific date from an
	 * arbitrary label (which day inside "Q2"?) would be a fabrication this builder refuses to make; the caller, who knows
	 * the file's actual publish/effective date, supplies it explicitly.
	 */
	validFrom?: string
	/**
	 * `git rev-parse --short HEAD` — passed in by the command, not read from the repo here.
	 */
	buildSHA: string
	onProgress?: (message: string) => void
}

export interface BuildFilerResult {
	out: string
	/**
	 * Distinct `filer_node` rows after the build (PK-deduped — a node minted by multiple rows counts once).
	 */
	nodes: number
	/**
	 * Distinct `filer_edge` rows after the build (PK-deduped on `(from_node_id, to_node_id, source, valid_from)` — the
	 * SAME assertion re-inserted, e.g. by a repeated source row, counts once).
	 */
	edges: number
	/**
	 * Distinct `filer_attribute` rows after the build (staging-table-deduped on `(node_id, key, value, source,
	 * source_vintage)` — see the module docstring for why `value` is part of that key).
	 */
	attributes: number
	/**
	 * Distinct `filer_family` rows after the build — PK-deduped on `(node_id, family_id, naming_node_id, source,
	 * valid_from)`, the identical composite shape as `filer_edge`'s own PK plus the naming provenance. One row per
	 * `HoldingCompany`/`ManagementCompany` edge whose target name canonicalized to something non-empty (see
	 * {@linkcode mintFamilyID}), so two DIFFERENT spellings of one family under one source at one instant count as two
	 * rows here, not one.
	 */
	families: number
	/**
	 * Count of edge OPPORTUNITIES declined because a legitimately-optional source field was empty/null — NOT an error
	 * condition, and NOT deduped (every occurrence counts, even if two rows independently miss the same field): a 499 row
	 * with `frn: null` (+1 — none of that row's three FRN-anchored edges can be minted), a 499 row with `frn` present but
	 * an empty `holdingCompany` (+1) or `managementCompany` (+1), and a provider-list row with `holdingCompany: null`
	 * (+1).
	 */
	skipped: number
	/**
	 * `filer_edge` rows whose `valid_to` was closed from a Form 499 cessation note — see `closeableCessationDate`
	 * (`build/form499-rows.ts`) for which ones qualify.
	 */
	closedByCessation: number
	/**
	 * Cessation dates that could NOT close a window because doing so would produce an inverted or empty one, i.e.
	 * `ceasedAt <= lastFiledAt` — 1,440 of the 3,261 ceased filers naming a holding or management company in the
	 * 2025-12-07 vintage. The date is still recorded as a `ceased_at` attribute; only the temporal window abstains.
	 *
	 * NOT an error. See `closeableCessationDate` (`build/form499-rows.ts`) for why these two dates disagree so often.
	 */
	cessationWindowAbstained: number
	/**
	 * `SupersededBy` edges written from `Replaced by filer <id>` notes.
	 */
	supersessions: number
}

/**
 * Build `filer.db`: create tables → stage+materialize `filer_attribute` (dedup) → direct PK-deduped `INSERT OR IGNORE`
 * into `filer_node`/`filer_edge` → index-after-load → manifest → seal → atomic move-into-place. See the module
 * docstring for the full flow rationale and the edges/attributes emitted.
 */
function countRows(kdb: DatabaseClient<FilerDatabase>, table: string): number {
	return (kdb.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
}

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

	// Options-level guard, fails fast (before any file/DB I/O) — see assertProviderValidFrom's docstring. `null` when
	// no provider-list source was supplied: the provider-row loop below never runs in that case, so validFrom is never
	// read.
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
	 * Row tallies read off the built tables — the connection is gone by the time the summary is assembled.
	 */
	let materialized: { nodes: number; edges: number; attributes: number; families: number }

	{
		using kdb = new DatabaseClient<FilerDatabase>(buildingPath)
		// Build-tuning pragmas — identical to build-bdc.ts's discipline.
		kdb.exec("PRAGMA page_size=8192; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2000000;")

		progress("creating manifest/node/edge/attribute/cluster/family/attribute-stage tables")
		await createFilerBuildTables(kdb)

		const insNode = kdb.prepare(
			`INSERT OR IGNORE INTO filer_node (node_id, identifier_type, identifier_value) VALUES (?, ?, ?)`
		)

		// relationship: FRN<->form499ID and bdcProviderID<->FRN assert identity (SameEntity); the
		// holding-/management-company edges below assert HoldingCompany/ManagementCompany — see the module docstring's
		// "relationship is fully typed" section.
		const insEdge = kdb.prepare(
			`INSERT OR IGNORE INTO filer_edge (
				from_node_id, to_node_id, assertion, relationship, source, source_vintage, valid_from, valid_to, match_score, evidence
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)

		// filer_family — same "no staging table needed" discipline as filer_node/filer_edge above (module
		// docstring): the composite PK (node_id, family_id, naming_node_id, source, valid_from) already provides the
		// uniqueness a staging table would otherwise exist to give. naming_node_id belongs in that key —
		// see createFilerFamilyTable's docstring for why leaving it out would make THIS statement's OR IGNORE drop a
		// second, differently-spelled report of the same family.
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

		// EDGAR corroboration input — keyed by FRN, keeping the LATEST lastFiledAt's legal name per FRN, the
		// same "latest wins" convention cluster-filers.ts's readLatestLegalNames uses for the identical reason (a
		// re-filing under a new legal name is real). Built here (in-memory, from the SAME form499Source this call
		// already iterates) rather than by re-querying the DB, since the edgar loop runs later in this same function —
		// see the module docstring's "EDGAR Exhibit 21 ingest" section.
		const legalNameByFRN = new Map<string, { name: string; filedAt: string }>()

		let form499RowIndex = 0

		for await (const row of form499Source) {
			form499RowIndex++

			const form499NodeID = mintForm499NodeID(row.form499ID, form499RowIndex)
			insNode.run(form499NodeID, FilerIdentifierType.Form499ID, row.form499ID)

			// Guarded ONCE per row, before anything below writes it into source_vintage/valid_from — see the
			// docstring above assertLastFiledAt. ISO-validated too: this SAME value becomes valid_from on every edge this row emits, and valid_from must
			// always be ISO-sortable — see assertISODate's docstring.
			const lastFiledAt = assertISODate(
				assertLastFiledAt(row.lastFiledAt, row.form499ID, form499RowIndex),
				`form499 row #${form499RowIndex} (form499ID=${JSON.stringify(row.form499ID)}) lastFiledAt`
			)

			// Attributes attach to the form499ID node — the only identifier guaranteed present on every row
			// (frn can legitimately be null). See the module docstring's DC-agent doctrine: dcAgent* fields land
			// here as plain attributes ONLY, never as edges.
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

			// The FCC's own lifecycle notes, when the source carried them (workbook only — the 17-column TSV has
			// no note columns, so `lifecycle` is undefined there and this is a no-op).
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
				// No FRN on this row at all — legitimate (decision 3: not yet registered in CORES), not malformed.
				// None of the three FRN-anchored edges above can be minted for this row.
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

			// source_vintage stays the (possibly non-ISO) human vintage label; valid_from is the SEPARATE, always-ISO
			// providerValidFrom — see BuildFilerOptions.validFrom's docstring. Non-null
			// here by construction: this loop only runs when hasProviderSource is true, the same condition that made
			// providerValidFrom non-null above.
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

		// EDGAR Exhibit 21 ingest — see the module docstring's own section for the full rationale, and
		// processEdgarSubsidiaryRow's docstring (build/edgar-rows.ts) for the per-row edge/family logic. The
		// bucket map is built from THIS call's own form499 rows, so it must be grouped after that loop has run.
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
				// filer.db has no independent versioning yet — same deferral build-bdc.ts makes for bdc.db's `release`.
				version: options.sourceVintage,
				// The current schema version from filer/schema.ts — bumped to 3 when SupersededBy and
				// valid_to semantics landed. Every reader that needs temporal awareness should gate on this.
				schema_version: FILER_SCHEMA_VERSION,
				source: sourcesUsed.join(","),
				source_vintage: options.sourceVintage,
				// No `mailwoman filer build` CLI exists (filer.db has no CLI wiring in 3a — see the module docstring's
				// decision-2 note) — name the actual API entrypoint that produced this artifact instead of a command
				// that isn't there.
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
		// page_size MUST be set right before VACUUM — node:sqlite initializes the file at the 4096 default on
		// `new DatabaseSync`, so the earlier pragma is a no-op until a VACUUM rebuilds at the new size (matches
		// build-bdc.ts's same discipline).
		kdb.exec("PRAGMA page_size=8192")
		kdb.exec("VACUUM")
	}

	progress("seal")
	await sealDatabase(buildingPath)

	// Atomic move-into-place — the previous version is moved ASIDE FIRST, per the AGENTS.md database house
	// rule and build-bdc.ts's identical `${out}.prev` swap.
	if (await pathExists(options.out)) {
		await movePath(options.out, `${options.out}.prev`)
	}

	await movePath(buildingPath, options.out)

	if (await pathExists(`${options.out}.prev`)) {
		await removePath(`${options.out}.prev`)
	}

	return {
		out: options.out,
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
