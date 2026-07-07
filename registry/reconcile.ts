/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Coverage reconciliation (#621) — the library home for what `scripts/eval/record-matcher/
 *   coverage-reconciliation.ts` does inline, so the CLI (`registry --reconcile`) and any consumer
 *   can reuse it.
 *
 *   Given entities already resolved ACROSS sources (#618), classify each by which KIND of source its
 *   records come from. You tag each source label as either an **eligibility** source (it denotes
 *   membership in some base set — e.g. registered providers/facilities) or a **funding/enrollment**
 *   source (it denotes participation in a program). Three buckets fall out per entity:
 *
 *   - **enrolled** — resolves to BOTH an eligibility and a funding record.
 *   - **eligible, not enrolled** — an eligibility record with NO funding record resolving to it (the
 *       ANTI-JOIN).
 *   - **funded, not in the eligibility set** — a funding record with no eligibility record resolving to
 *       it.
 *
 *   This is strictly a **set-membership reconciliation, never a determination.** We produce the
 *   reconciled join and surface the candidate set; what a gap MEANS — and whether it is real, a
 *   sampling artifact, or actionable — is entirely the data consumer's call. Nothing here is an
 *   allegation. {@link reconciliationReport} bakes that caveat in by construction.
 *
 *   Pairs with {@link toMapHTML}: {@link reconciliationGeoJSON} tags each feature with its `bucket`,
 *   which the map auto-detects and colors categorically.
 */

import type { GeoFeature, GeoFeatureCollection, PointLiteral } from "@mailwoman/spatial"

import type { EntityGeoData, ReconciliationBucket, ResolvedEntity } from "./types.js"

/** Which source labels denote eligibility vs funding/enrollment. */
export interface ReconcileConfig {
	/** Source labels denoting membership in the base/eligibility set. */
	eligibilitySources: readonly string[]
	/** Source labels denoting enrollment / funding / program participation. */
	fundingSources: readonly string[]
}

/** One entity, classified. */
export interface ReconciledEntity {
	entity: ResolvedEntity
	/** Distinct provenance labels the entity's records span, sorted. */
	sources: string[]
	bucket: ReconciliationBucket
}

export interface ReconciliationResult {
	/** Entities that carry at least one eligibility- or funding-tagged source, each bucketed. */
	reconciled: ReconciledEntity[]
	counts: Record<ReconciliationBucket, number>
}

/**
 * Bucket an entity from the source labels its records span. Returns `null` when the entity carries NO eligibility- or
 * funding-tagged source (it is outside this reconciliation — e.g. a source the caller didn't assign a role) so callers
 * can exclude it rather than silently miscount it.
 */
export function bucketOf(sources: Iterable<string>, config: ReconcileConfig): ReconciliationBucket | null {
	const elig = new Set(config.eligibilitySources)
	const fund = new Set(config.fundingSources)
	let hasEligibility = false
	let hasFunding = false

	for (const s of sources) {
		if (elig.has(s)) {
			hasEligibility = true
		}

		if (fund.has(s)) {
			hasFunding = true
		}
	}

	if (hasEligibility && hasFunding) return "enrolled"

	if (hasEligibility) return "eligible-not-enrolled"

	if (hasFunding) return "funded-not-eligible"

	return null
}

/**
 * Classify resolved entities into reconciliation buckets. Entities with no eligibility- or funding-tagged source are
 * excluded (see {@link bucketOf}).
 */
export function reconcileCoverage(entities: readonly ResolvedEntity[], config: ReconcileConfig): ReconciliationResult {
	const reconciled: ReconciledEntity[] = []
	const counts: Record<ReconciliationBucket, number> = {
		enrolled: 0,
		"eligible-not-enrolled": 0,
		"funded-not-eligible": 0,
	}

	for (const entity of entities) {
		const sources = [...new Set(entity.records.map((r) => r.source).filter((s): s is string => !!s))].sort()
		const bucket = bucketOf(sources, config)

		if (!bucket) continue

		reconciled.push({ entity, sources, bucket })

		counts[bucket]++
	}

	return { reconciled, counts }
}

/** A display name for a reconciled entity's representative record. */
function repName(entity: ResolvedEntity): string {
	const rep = entity.representative
	const person = [rep.name?.given, rep.name?.family].filter(Boolean).join(" ")

	return rep.organization?.canonical ?? (person || rep.id)
}

/**
 * GeoJSON of every located reconciled entity, each feature tagged with its `bucket` + `sources` — the shape
 * {@link toMapHTML} colors categorically by bucket. Entities without a coordinate are skipped.
 */
export function reconciliationGeoJSON(result: ReconciliationResult): GeoFeatureCollection<PointLiteral, EntityGeoData> {
	return {
		type: "FeatureCollection",
		features: result.reconciled
			.filter((c) => c.entity.coordinate)
			.map((c) => {
				const foo: GeoFeature<PointLiteral, EntityGeoData> = {
					type: "Feature" as const,
					id: undefined,
					geometry: {
						type: "Point" as const,
						coordinates: [c.entity.coordinate!.longitude, c.entity.coordinate!.latitude] as [number, number],
					},
					properties: {
						entityID: c.entity.id,
						bucket: c.bucket,
						sources: c.sources,
						name: repName(c.entity),
						recordCount: c.entity.records.length,
					},
				}

				return foo
			}),
	}
}

export interface ReconciliationReportOptions {
	/** H1 title. Default: "Coverage reconciliation — eligibility ↔ enrollment". */
	title?: string
	/** An italic scope paragraph under the title (what the sources are, how they were scoped). */
	scopeNote?: string
	/** A paragraph about the scorer choice (e.g. why the FS baseline, not the dedup GBT). */
	scorerNote?: string
	/** A paragraph about sampling/capping, woven into the caveat. */
	sampleNote?: string
	/** How many "eligible, not enrolled" rows to spot-check. Default 15. */
	spotCheckLimit?: number
}

/**
 * A markdown reconciliation report: the bucket counts, the enrolled-rate floor, an anti-join spot-check, and — always,
 * by construction — the neutral caveat. The deliverable is the anti-join SET, not a rate, and never an allegation.
 */
export function reconciliationReport(result: ReconciliationResult, options: ReconciliationReportOptions = {}): string {
	const { counts, reconciled } = result
	const title = options.title ?? "Coverage reconciliation — eligibility ↔ enrollment"
	const spotCheckLimit = options.spotCheckLimit ?? 15
	const eligibleTotal = counts.enrolled + counts["eligible-not-enrolled"]
	const enrolledRate = eligibleTotal > 0 ? (100 * counts.enrolled) / eligibleTotal : 0

	const lines: string[] = []
	lines.push(`# ${title}`)
	lines.push("")

	if (options.scopeNote) {
		lines.push(`_${options.scopeNote}_`)
		lines.push("")
	}

	if (options.scorerNote) {
		lines.push(options.scorerNote)
		lines.push("")
	}
	lines.push(`## The reconciliation`)
	lines.push("")
	lines.push(`| bucket | entities | meaning |`)
	lines.push(`|---|---:|---|`)
	lines.push(`| **enrolled** | ${counts.enrolled} | resolves to an eligibility record AND a funding record |`)
	lines.push(
		`| **eligible, not enrolled** | ${counts["eligible-not-enrolled"]} | eligibility record, no funding record resolved (the **anti-join**) |`
	)
	lines.push(
		`| **funded, not in eligibility set** | ${counts["funded-not-eligible"]} | funding record, no eligibility record resolved |`
	)
	lines.push("")
	lines.push(
		`Of the ${eligibleTotal} entities with an eligibility record, ${enrolledRate.toFixed(1)}% also resolve to a ` +
			`funding record — a **floor**, not a coverage rate (imperfect resolution + any sampling only ever miss ` +
			`links, never invent them). The deliverable is the anti-join SET, not this percentage.`
	)
	lines.push("")
	lines.push(`## Anti-join spot-check — first ${spotCheckLimit} "eligible, not enrolled"`)
	lines.push("")
	lines.push(`| entity | sources | name | coordinate |`)
	lines.push(`|---|---|---|---|`)

	for (const c of reconciled.filter((x) => x.bucket === "eligible-not-enrolled").slice(0, spotCheckLimit)) {
		const coord = c.entity.coordinate
			? `${c.entity.coordinate.latitude.toFixed(4)}, ${c.entity.coordinate.longitude.toFixed(4)}`
			: "—"
		lines.push(`| ${c.entity.id} | ${c.sources.join(", ")} | ${repName(c.entity)} | ${coord} |`)
	}
	lines.push("")
	lines.push(`## The caveat that matters`)
	lines.push("")
	const sample = options.sampleNote ? `${options.sampleNote} ` : ""
	lines.push(
		`${sample}This is a **set-membership reconciliation, not a determination**. A missing funding record can mean ` +
			`the entity didn't apply, applied under a name we didn't resolve, is ineligible, or any number of things. We ` +
			`produce the reconciled join and surface the candidate set; **what a gap means, and whether to act on it, is ` +
			`entirely the data consumer's call.** Nothing here is an allegation.`
	)
	lines.push("")

	return lines.join("\n")
}
