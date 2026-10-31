/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The evaluation coverage register: for one dataset version, one row per intended country with its
 *   requirement status from the release specification, its available and sampled addresses and place names,
 *   its independent groups, its source composition, its provenance-class counts and its evaluation status.
 *
 *   The country set is every country the specification names (a country requirement, the objective set, a
 *   capability selector) together with every country the dataset's availability count holds, so a required
 *   country with no test rows still gets a row. Evidence that was not measured is `null` and renders as
 *   insufficient evidence. It is never written as zero. A required or objective country with no sampled
 *   address rows is insufficient evidence. An experimental country stays visibly unqualified.
 */

import type { HeldoutDatasetManifest } from "#tools/eval-harness/heldout/dataset/manifest"
import type { HeldoutProvenance, ProvenanceRecord } from "#tools/eval-harness/heldout/per/country"
import type { ReleaseOutcome, ReleaseVerdict } from "#tools/eval-harness/release/evaluate"
import type { ReleaseRequirementSpec } from "#tools/eval-harness/release/requirements"

export type CoverageRequirementStatus = "required" | "objective" | "experimental"

export type CoverageEvaluationStatus = ReleaseOutcome | "not_evaluated" | "unqualified"

export interface CoverageRegisterRow {
	country: string
	status: CoverageRequirementStatus
	/**
	 * Whether the country is in the objective set C. A required country may also be.
	 */
	objective: boolean
	requirementIDs: string[]
	addresses: { available: number; sampled: number }
	places: { available: number; sampled: number }
	/**
	 * Distinct groups among the sampled address rows, or `null` when none was sampled.
	 */
	groups: number | null
	/**
	 * Sampled address rows per source, or `null` when none was sampled.
	 */
	sources: Record<string, number> | null
	/**
	 * Provenance classes over the sampled address rows, or `null` when no overlap audit was supplied.
	 */
	provenance: Record<HeldoutProvenance, number> | null
	evaluation: { status: CoverageEvaluationStatus; reasons: string[] }
}

export interface CoverageRegister {
	dataset: {
		datasetID: string
		version: string
		rowsSHA256: string
		corpusVersion: string | null
	}
	specVersion: string
	verdict: { outcome: ReleaseOutcome } | null
	provenanceAudit: string | null
	rows: CoverageRegisterRow[]
}

const SEVERITY: Record<ReleaseOutcome, number> = {
	pass: 0,
	insufficient_evidence: 1,
	fail: 2,
}

/**
 * Builds the register for a dataset version under a specification.
 *
 * @param provenance The overlap audit's `rows` map and its citation, when an audit was run.
 * @param verdict The evaluator's verdict for this specification, when one was run.
 */
export function buildCoverageRegister(input: {
	dataset: HeldoutDatasetManifest
	spec: ReleaseRequirementSpec
	provenance?: {
		source: string
		rows: Readonly<Record<string, ProvenanceRecord>>
	} | null
	verdict?: ReleaseVerdict | null
}): CoverageRegister {
	const { dataset, spec } = input
	const verdict = input.verdict ?? null

	if (verdict && verdict.specVersion !== spec.specVersion) {
		throw new Error(`the verdict is for spec ${verdict.specVersion}; the register reads spec ${spec.specVersion}`)
	}

	const required = new Map<string, string[]>()

	for (const requirement of spec.requirements) {
		if (requirement.kind !== "country") continue

		required.set(requirement.country, [...(required.get(requirement.country) ?? []), requirement.id])
	}

	const objective = new Set(spec.objective.countries)
	const countries = new Set<string>([...required.keys(), ...objective])

	for (const requirement of spec.requirements) {
		if (requirement.kind === "capability") {
			for (const country of requirement.select.countries ?? []) {
				countries.add(country)
			}
		}
	}

	for (const cell of dataset.cells) {
		countries.add(cell.country)
	}

	const checks = new Map((verdict?.checks ?? []).map((check) => [check.id, check]))

	const rows = [...countries].toSorted().map((country): CoverageRegisterRow => {
		const cell = (kind: "address" | "gazetteer") => {
			const found = dataset.cells.find((c) => c.country === country && c.kind === kind)

			return { available: found?.available ?? 0, sampled: found?.sampled ?? 0 }
		}

		const addresses = cell("address")
		const places = cell("gazetteer")
		const entries = dataset.rows.filter((entry) => entry.country === country && entry.kind === "address")

		if (entries.length !== addresses.sampled) {
			throw new Error(
				`${dataset.datasetID}@${dataset.version} lists ${entries.length} ${country} address rows; its count records ${addresses.sampled}`
			)
		}

		const requirementIDs = required.get(country) ?? []

		const status: CoverageRequirementStatus = requirementIDs.length
			? "required"
			: objective.has(country)
				? "objective"
				: "experimental"

		let sources: Record<string, number> | null = null
		let provenance: Record<HeldoutProvenance, number> | null = null

		if (entries.length) {
			sources = {}

			for (const entry of entries) {
				sources[entry.source] = (sources[entry.source] ?? 0) + 1
			}

			if (input.provenance) {
				provenance = { verified_unseen: 0, unseen_by_candidate: 0, known_overlap: 0, unknown: 0 }

				for (const entry of entries) {
					provenance[input.provenance.rows[entry.rowID]?.provenance ?? "unknown"]++
				}
			}
		}

		const reasons: string[] = []
		let evaluation: CoverageEvaluationStatus

		if (status === "experimental") {
			evaluation = "unqualified"
			reasons.push("experimental: no registered requirement")
		} else if (!entries.length) {
			evaluation = "insufficient_evidence"
			reasons.push(`no sampled address rows (${addresses.available} available)`)
		} else if (!verdict) {
			evaluation = "not_evaluated"
			reasons.push("no verdict supplied")
		} else if (status === "objective") {
			evaluation = verdict.checks.find((check) => check.check === "objective")?.outcome ?? "insufficient_evidence"
			reasons.push("objective member; status is the objective check's")
		} else {
			evaluation = "pass"

			for (const id of requirementIDs) {
				const check = checks.get(id)
				const outcome: ReleaseOutcome = check?.outcome ?? "insufficient_evidence"

				if (!check) {
					reasons.push(`${id}: no check in the verdict`)
				} else if (outcome !== "pass") {
					reasons.push(`${id}: ${outcome}${check.reasons.length ? ` (${check.reasons.join("; ")})` : ""}`)
				}

				if (SEVERITY[outcome] > SEVERITY[evaluation]) {
					evaluation = outcome
				}
			}
		}

		return {
			country,
			status,
			objective: objective.has(country),
			requirementIDs,
			addresses,
			places,
			groups: entries.length ? new Set(entries.map((entry) => entry.group)).size : null,
			sources,
			provenance,
			evaluation: { status: evaluation, reasons },
		}
	})

	return {
		dataset: {
			datasetID: dataset.datasetID,
			version: dataset.version,
			rowsSHA256: dataset.rowsFile.sha256,
			corpusVersion: dataset.drawnFrom.corpusVersion,
		},
		specVersion: spec.specVersion,
		verdict: verdict ? { outcome: verdict.outcome } : null,
		provenanceAudit: input.provenance?.source ?? null,
		rows,
	}
}

const INSUFFICIENT = "insufficient evidence"

const EVALUATION_LABEL: Record<CoverageEvaluationStatus, string> = {
	pass: "pass",
	fail: "fail",
	insufficient_evidence: INSUFFICIENT,
	not_evaluated: "not evaluated",
	unqualified: "unqualified",
}

/**
 * Renders the register as the committed reference page.
 *
 * @param command The command that regenerates the page, quoted on it.
 */
export function renderCoverageRegisterMarkdown(register: CoverageRegister, command: string): string {
	const { dataset } = register
	const cellText = (value: string) => value.replaceAll("|", "\\|")

	const lines = [
		"---",
		"title: Evaluation coverage, per country",
		"role: reference",
		"audience: maintainer",
		"owner: operations",
		"---",
		"",
		"{/* Generated by packages/mailwoman/tools/eval-harness/heldout/dataset/coverage/register.run.ts. Edit that file. */}",
		"",
		"# Evaluation coverage, per country",
		"",
		`One row per intended country for evaluation dataset \`${dataset.datasetID}\` version \`${dataset.version}\` ` +
			`(rows sha256 \`${dataset.rowsSHA256}\`, drawn from corpus \`${dataset.corpusVersion ?? "unversioned"}\`), ` +
			`under release specification version \`${register.specVersion}\`. Regenerate with:`,
		"",
		"```sh",
		command,
		"```",
		"",
		`Provenance classes come from ${register.provenanceAudit ? `\`${register.provenanceAudit}\`` : "no overlap audit; every provenance cell is insufficient evidence"}. ` +
			`Evaluation status comes from ${register.verdict ? `a verdict whose outcome is ${EVALUATION_LABEL[register.verdict.outcome]}` : "no verdict"}. ` +
			"A cell that reads insufficient evidence was not measured; it is not zero.",
		"",
		"| Country | Status | Addresses available | Addresses sampled | Groups | Place names sampled | Sources | Unseen / unseen by candidate / overlap / unknown | Evaluation |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	]

	for (const row of register.rows) {
		const status = row.status === "required" && row.objective ? "required, objective" : row.status

		const sources = row.sources
			? Object.entries(row.sources)
					.toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b))
					.map(([source, n]) => `${source} ${n}`)
					.join(", ")
			: INSUFFICIENT

		const provenance = row.provenance
			? `${row.provenance.verified_unseen} / ${row.provenance.unseen_by_candidate} / ${row.provenance.known_overlap} / ${row.provenance.unknown}`
			: INSUFFICIENT

		const evaluation = `${EVALUATION_LABEL[row.evaluation.status]}${row.evaluation.reasons.length ? `: ${row.evaluation.reasons.join("; ")}` : ""}`

		lines.push(
			`| ${[
				row.country,
				status,
				String(row.addresses.available),
				String(row.addresses.sampled),
				row.groups == null ? INSUFFICIENT : String(row.groups),
				`${row.places.sampled} of ${row.places.available}`,
				sources,
				provenance,
				evaluation,
			]
				.map(cellText)
				.join(" | ")} |`
		)
	}

	return `${lines.join("\n")}\n`
}
