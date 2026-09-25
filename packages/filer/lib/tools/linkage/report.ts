/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { renderMarkdownTable } from "@mailwoman/core/strings/markdown-table"

import type { FRN } from "#frn"
import type { Form499Row } from "#sdk/form499/index"
import type { ProviderListRow } from "#sdk/provider-list"
import { LINKAGE_EVAL_AS_OF, type LinkageEvalInputs, type LinkageEvalRegistrant } from "#tools/linkage/corpus"
import type { LinkageEvalRun, TruthPositivePairOutcome } from "#tools/linkage/eval"

/**
 * Joins sentences into one Markdown paragraph, so that each sentence can sit on its own source line.
 */
function paragraph(...sentences: string[]): string {
	return sentences.join(" ")
}

function formatScore(value: number | null): string {
	return value === null ? "N/A" : value.toFixed(3)
}

const ATTRIBUTE_ONLY = "Stored as an attribute. Neither the family path nor the entity-resolution path reads it."
const AGENT_ATTRIBUTE = "Stored as an attribute. It never becomes an edge input."

const FORM_499_FIELD_NOTES: Record<keyof Form499Row, string> = {
	form499ID: "",
	frn: "The truth key. It is never withheld.",
	lastFiledAt: "",
	usfContributor: "",
	legalNameOfCarrier: "The entity-resolution pass uses it as the blocking key and as a score input.",
	doingBusinessAs: "",
	principalCommType: "",
	holdingCompany: "The field under test.",
	managementCompany:
		"Records control rather than ownership. It stays in the input and is excluded from the prediction.",
	hqAddress: ATTRIBUTE_ONLY,
	customerInquiriesTelephone: ATTRIBUTE_ONLY,
	customerInquiriesAddress: ATTRIBUTE_ONLY,
	dcAgentDisplayName: AGENT_ATTRIBUTE,
	dcAgentOrganizationName: AGENT_ATTRIBUTE,
	dcAgentTelephone: AGENT_ATTRIBUTE,
	dcAgentEmailAddress: AGENT_ATTRIBUTE,
	dcAgentAddress: AGENT_ATTRIBUTE,
	lifecycle: paragraph(
		"Workbook-only. It holds the FCC's cessation date and successor filer, which close `valid_to` on a real build.",
		"The synthetic corpus does not set it, so this eval does not read it."
	),
	operatingStates: "Workbook-only registered footprint. It is stored as an attribute, and edges never read it.",
}

const PROVIDER_FIELD_NOTES: Record<keyof ProviderListRow, string> = {
	providerID: "Registrant identity. Two FRNs under one provider ID are one registrant.",
	frn: "The truth key. It is never withheld.",
	holdingCompany: "The field under test.",
}

function isPopulated(value: unknown): boolean {
	return value !== null && value !== undefined && value !== "" && value !== false
}

function describeFieldCoverage<Row>(rows: readonly Row[], field: keyof Row, withheld: boolean): string {
	if (withheld) return "**withheld**"

	const populated = rows.filter((row) => isPopulated(row[field])).length

	return populated === 0 ? `**0 of ${rows.length}** (never set)` : `${populated} of ${rows.length}`
}

/**
 * Renders one row per field, marking a field withheld when any control row
 * differs from its withheld counterpart.
 */
function renderFieldTable<Row>(
	title: string,
	notes: Record<keyof Row, string>,
	withheldRows: readonly Row[],
	controlRows: readonly Row[]
): string[] {
	const rows = (Object.keys(notes) as Array<keyof Row>).map((field) => {
		const withheld = controlRows.some((row, index) => row[field] !== withheldRows[index]![field])

		return [
			`\`${String(field)}\``,
			withheld ? "**no**" : "yes",
			describeFieldCoverage(withheldRows, field, withheld),
			notes[field],
		]
	})

	return renderMarkdownTable([title, "in the withheld input?", "populated in the corpus", "note"], rows)
}

function renderCorpusTable(
	rows: readonly Form499Row[],
	registrants: readonly LinkageEvalRegistrant[],
	truthGroupOf: ReadonlyMap<FRN, string>
): string[] {
	const representativeOf = new Map<FRN, FRN>()

	for (const registrant of registrants) {
		for (const frn of registrant.frns) {
			representativeOf.set(frn, registrant.representative)
		}
	}

	return renderMarkdownTable(
		[
			"FRN",
			"legal name (always given)",
			"registrant",
			"holding company (withheld)",
			"management company",
			"truth family",
		],
		rows.map((row) => {
			const frn = row.frn!
			const representative = representativeOf.get(frn)!
			const group = truthGroupOf.get(representative) ?? ""

			return [
				frn,
				row.legalNameOfCarrier,
				representative === frn ? "itself" : representative,
				row.holdingCompany || "_(none)_",
				row.managementCompany || "_(none)_",
				group.startsWith("singleton:") ? "_(no family)_" : `\`${group}\``,
			]
		})
	)
}

/**
 * Renders a table with one row per metric and one column per run.
 */
function renderRunTable(
	header: string[],
	withheld: LinkageEvalRun,
	control: LinkageEvalRun,
	metrics: Array<[label: string, read: (run: LinkageEvalRun) => string | number]>
): string[] {
	return renderMarkdownTable(
		header,
		metrics.map(([label, read]) => [label, String(read(withheld)), String(read(control))])
	)
}

function renderResultsTable(withheld: LinkageEvalRun, control: LinkageEvalRun): string[] {
	return renderRunTable(["metric", "withheld (the measurement)", "control (parent disclosed)"], withheld, control, [
		["precision", (run) => formatScore(run.score.precision)],
		["recall", (run) => formatScore(run.score.recall)],
		["F1", (run) => formatScore(run.score.f1)],
		["true-positive pairs", (run) => run.score.truePositivePairs],
		["false-positive pairs", (run) => run.score.falsePositivePairs],
		["false-negative pairs", (run) => run.score.falseNegativePairs],
		["truth-positive pairs", (run) => run.score.truthPositivePairs],
		["predicted-positive pairs", (run) => run.score.predictedPositivePairs],
		["total registrant pairs scored", (run) => run.score.totalPairs],
		["input SHA-256", (run) => `\`${run.inputsSHA256.slice(0, 16)}…\``],
	])
}

function renderCensusTable(withheld: LinkageEvalRun, control: LinkageEvalRun): string[] {
	return renderRunTable(["what the built artifact contains", "withheld", "control"], withheld, control, [
		["`holding_company_name` nodes", (run) => run.census.holdingCompanyNodes],
		["ownership `filer_edge` rows (relationship asserts ownership)", (run) => run.census.ownershipEdges],
		[
			"`filer_family` rows the prediction scores (relationship asserts ownership)",
			(run) => run.census.scoredFamilyRows,
		],
		[
			"`filer_family` rows the prediction ignores (recognized, but not ownership)",
			(run) => run.census.nonOwnershipFamilyRows,
		],
		[
			"`filer_family` rows with an unrecognized relationship (the check refuses these)",
			(run) => run.census.unrecognizedFamilyRows,
		],
		["`filer_family` rows, total", (run) => run.census.familyRows],
		["entity-resolution records scored", (run) => run.inferred.recordsConsidered],
		["entity-resolution links written", (run) => run.inferred.links],
	])
}

function renderPairsTable(withheld: LinkageEvalRun, control: LinkageEvalRun): string[] {
	const recoveredInControl = (pair: TruthPositivePairOutcome) =>
		control.truthPositivePairs.find((other) => other.a === pair.a && other.b === pair.b)?.recovered ?? false

	const yesNo = (value: boolean) => (value ? "yes" : "no")

	return renderMarkdownTable(
		["registrant A", "registrant B", "truth family", "recovered?"],
		withheld.truthPositivePairs.map((pair) => [
			pair.a,
			pair.b,
			`\`${pair.familyID}\``,
			`withheld: ${yesNo(pair.recovered)} · control: ${yesNo(recoveredInControl(pair))}`,
		])
	)
}

interface RenderLinkageEvalReportInput {
	date: string
	withheld: LinkageEvalRun
	control: LinkageEvalRun
	withheldInputs: LinkageEvalInputs
	controlInputs: LinkageEvalInputs
	registrants: readonly LinkageEvalRegistrant[]
	truthForm499Rows: readonly Form499Row[]
	truthGroupOf: ReadonlyMap<FRN, string>
}

function renderSummary({ withheld, control }: RenderLinkageEvalReportInput): string[] {
	return [
		paragraph(
			"**`filer.db` recovers corporate-family membership when a filer discloses its parent, and recovers none when it does not.**",
			`With \`holdingCompany\` present, the build places all ${control.score.truthPositivePairs} same-family registrant pairs`,
			`in the same family and adds no false pairs: precision ${formatScore(control.score.precision)},`,
			`recall ${formatScore(control.score.recall)}.`,
			"With that one field removed from the same corpus, the build makes no family predictions.",
			`It recovers ${withheld.score.truePositivePairs} of ${withheld.score.truthPositivePairs} pairs for a recall of`,
			`${formatScore(withheld.score.recall)}, and precision and F1 are undefined because there are no positive predictions to score.`,
			"This pipeline takes family membership from the disclosed parent name after canonicalizing it,",
			"and nothing in the build infers membership from other evidence."
		),
	]
}

function renderQuestion(): string[] {
	return [
		"## The question",
		"",
		paragraph(
			"A corporate family is a set of operating companies under one parent.",
			"`filer.db` builds families from the parent name that a filer discloses on its Form 499 or on the broadband",
			"provider list, and both sources contribute rows to the control build below.",
			"This eval sets a baseline for whether membership can be recovered for a filer that discloses no parent,",
			"using names, identifiers or any other signal already in the pipeline.",
			"Today it cannot, and the withheld score below records that result so that a later build with more evidence",
			"has a number to beat."
		),
	]
}

function renderRuns({ control }: RenderLinkageEvalReportInput): string[] {
	return [
		"## The two runs",
		"",
		paragraph(
			"Both runs build a scratch `filer.db` from the same authored corpus with the same shipped code,",
			"and both read the prediction the same way.",
			"They differ in one field."
		),
		"",
		"- **withheld**: `holdingCompany` is cleared on every Form 499 row and every provider-list row before the " +
			"builder reads them. This run is the measurement.",
		"- **control**: the corpus keeps that field. This run checks the harness.",
		"",
		paragraph(
			"The control score is expected rather than impressive.",
			"A pipeline that groups filers by the canonicalized parent name they reported should score",
			`${formatScore(control.score.f1)} when it is given that name.`,
			"The control run shows that the harness reads a table the truth can reach.",
			"Without it, the withheld score of zero could not be falsified, because an eval that reads the wrong table",
			"also reports zero.",
			"The two runs differ in exactly one field, and their input hashes differ accordingly."
		),
		"",
		"### What counts as a prediction",
		"",
		paragraph(
			"Two registrants are predicted to share a family when the built `filer.db` places them in a common family",
			`as of ${LINKAGE_EVAL_AS_OF}.`,
			"The eval reads each membership with the shipped corporate-family reader that product callers use.",
			"That reader answers for one node at a time, and a registrant can own several nodes (its FRN registrations",
			"and its provider ID), so the eval takes the union of the families across those nodes.",
			"The union is the eval's own step, and it is why a parent disclosed on only one of a registrant's two filings",
			"still counts."
		),
		"",
		paragraph(
			"Memberships that exist only because two filers reported the same management company are excluded from both",
			"the prediction and the truth.",
			"Management is operational control rather than ownership, and the eval does not withhold that field.",
			"Counting it would let a field the eval provides decide a question about the field the eval withholds.",
			"The corpus includes two filers that report the same manager so that the exclusion is exercised."
		),
		"",
		"### What counts as a registrant",
		"",
		paragraph(
			"The eval scores registrants rather than FRNs.",
			"One operator can hold several FRN registrations, and the corpus has one registrant that holds two,",
			"joined by a shared provider ID.",
			"A parent disclosed on one registration describes the whole company.",
			"Scoring FRNs separately would let the truth partition put one legal entity in two families at once."
		),
		"",
		paragraph(
			"Treating a shared provider ID as proof of one registrant is a modelling choice.",
			"Real provider-list rows that share a provider ID have been observed reporting different parents,",
			"which would mean the fold joins companies that should stay apart.",
			"That failure would be visible here.",
			"Folding two registrants from different families puts a truth-negative pair inside one truth group,",
			"the control run cannot recover that pair, control recall falls below 1.000, and the test that asserts",
			"a perfect control fails."
		),
	]
}

function renderCorpus(input: RenderLinkageEvalReportInput): string[] {
	const { registrants, truthForm499Rows, truthGroupOf } = input

	return [
		"## Corpus",
		"",
		paragraph(
			`The corpus has ${truthForm499Rows.length} Form 499 filers folded into ${registrants.length} registrants.`,
			"It is authored rather than sampled, so every truth fact can be audited on this page instead of trusted",
			"from an external source.",
			"It contains the following filers."
		),
		"",
		"- Two multi-member families whose members spell the parent name inconsistently.",
		"- Four standalone filers.",
		"- Two unrelated companies with identical canonical names.",
		"- One registrant that holds two FRNs, where only the second filing discloses the parent.",
		"- One filer that discloses no parent but reports the same management company as a member of the first " +
			"family. The prediction must not treat that as ownership.",
		"",
		...renderCorpusTable(truthForm499Rows, registrants, truthGroupOf),
	]
}

function renderInputShape({ withheldInputs, controlInputs }: RenderLinkageEvalReportInput): string[] {
	return [
		"## Input record shape",
		"",
		paragraph(
			"The tables below list every field the builder receives in the withheld run and how much of each field",
			"the corpus fills in.",
			"Filling in the empty fields would not change the result, because nothing on the family path reads them",
			'(see "What would move this number" below).',
			"They are listed so that the corpus's sparsity is not mistaken for the reason the withheld run scores zero."
		),
		"",
		...renderFieldTable(
			"Form499Row field",
			FORM_499_FIELD_NOTES,
			withheldInputs.form499Rows,
			controlInputs.form499Rows
		),
		"",
		...renderFieldTable(
			"ProviderListRow field",
			PROVIDER_FIELD_NOTES,
			withheldInputs.providerRows,
			controlInputs.providerRows
		),
	]
}

function renderResults({ withheld, control, registrants }: RenderLinkageEvalReportInput): string[] {
	const truthNegativePairs = withheld.score.totalPairs - withheld.score.truthPositivePairs

	return [
		"## Results",
		"",
		...renderResultsTable(withheld, control),
		"",
		paragraph(
			"The withheld run reports F1 as `N/A` rather than `0.000` on purpose.",
			"Precision is undefined when a prediction makes no positive calls, because its denominator is zero,",
			"and an F1 built on an undefined precision is also undefined.",
			"Recovering nothing because nothing was predicted is a different failure from predicting pairs and getting",
			"them all wrong, which would show `precision 0.000`."
		),
		"",
		"### Same-family pairs, individually",
		"",
		paragraph(
			`The table lists the ${withheld.score.truthPositivePairs} registrant pairs that the withheld field puts together.`,
			`The other ${truthNegativePairs} pairs of the ${registrants.length} registrants are truth negatives,`,
			"including the pair with identical names."
		),
		"",
		...renderPairsTable(withheld, control),
	]
}

function renderArtifacts({ withheld, control }: RenderLinkageEvalReportInput): string[] {
	return [
		"## What is in each artifact",
		"",
		paragraph(
			"These counts come from the two builds rather than from assertions about them.",
			"The withheld build has zero ownership nodes, ownership edges, scored family rows, and family rows with",
			"a relationship the eval cannot classify.",
			"Those four zero counts confirm the withholding, and a runtime check refuses to report a withheld score",
			"if any of them is non-zero.",
			`The build does contain ${withheld.census.nonOwnershipFamilyRows} corporate-family rows from the`,
			"management-company disclosures, which the eval does not withhold.",
			"Those rows use a separate namespace from ownership families, and the prediction skips them."
		),
		"",
		paragraph(
			"The family counts are split by what the prediction does with each row rather than by relationship name,",
			"and the three buckets partition the total.",
			"The scored bucket holds every membership whose relationship asserts ownership, so a `subsidiary` or",
			"`parent_company` row from a future writer is counted there.",
			"The second bucket holds the relationships the eval recognizes and deliberately does not score:",
			"`management_company` and `same_entity`.",
			"The third bucket holds any other relationship string, which the shipped writers never produce,",
			"and the check refuses to report a score when that bucket is not empty.",
			"The table prints the total next to the three buckets, so every row is accounted for."
		),
		"",
		...renderCensusTable(withheld, control),
	]
}

function renderWhyNothing({ withheld }: RenderLinkageEvalReportInput): string[] {
	return [
		"## Why the withheld run recovers nothing",
		"",
		paragraph(
			"No other part of the build produces an ownership fact, and two deliberate design choices keep it that way.",
			"First, the builder writes a corporate-family row only when an input row discloses a parent,",
			"so every path from a filing to a family runs through a disclosed name.",
			`Second, the entity-resolution pass, which ran here over ${withheld.inferred.recordsConsidered} records,`,
			"answers a different question.",
			"It decides whether two identifiers denote the same legal entity, and it merges two records only when they",
			"share an identifier code, however similar their names are.",
			"A merge would assert that two records are the same company rather than that they share a parent,",
			"so even a merge could not populate a family.",
			"The corpus tests that refusal on purpose.",
			"Two of its filers canonicalize to the identical legal name `american fiber partners` but are different",
			"companies.",
			"The canonical name is the blocking key, so the pair is proposed and scored, and the identifier veto",
			"rejects it."
		),
	]
}

function renderWhatWouldMoveIt(): string[] {
	return [
		"## What would move this number",
		"",
		"Better evidence would not lift the withheld score in this code, and two probes show why.",
		"",
		paragraph(
			"**Populating the address and contact fields changes nothing.**",
			"Filling `hqAddress`, `customerInquiriesTelephone` and `customerInquiriesAddress` identically across all",
			"three members of one family in the withheld corpus, then rebuilding, re-clustering and re-scoring,",
			"gives a byte-identical result with 0 pairs recovered.",
			"Those fields are stored as attributes.",
			"Neither the family path nor the entity-resolution path reads them, because entity resolution reads only",
			"legal names and identifier codes.",
			"The result comes from the pipeline's design rather than from gaps in the corpus."
		),
		"",
		paragraph(
			"**Adding an ownership edge changes nothing either.**",
			"Writing inferred `subsidiary` `filer_edge` rows that join the same filers to a parent, in the shape",
			"a corporate-filing importer is specified to emit, leaves recall at 0.000.",
			"Corporate-family membership is read from `filer_family` alone.",
			"The family readers query `filer_edge` only to recover the raw company name behind a canonicalized",
			"family ID, and never to decide who belongs to a family, which is what this eval scores."
		),
		"",
		paragraph(
			"**A channel that writes a `filer_family` row moves this number, and a channel that writes only",
			"a `filer_edge` row does not.**",
			"Injecting three ownership `filer_family` rows into the withheld build raises recall from 0.000 to 0.500",
			"at precision 1.000.",
			"A standing test keeps that probe running, so the claim that this baseline can be beaten is checked on",
			"every run."
		),
		"",
		paragraph(
			"Anyone using this page as a before-and-after baseline depends on that distinction.",
			"A later build scores above 0.000 only if its new evidence lands as `filer_family` membership rows.",
			"An importer that writes ownership edges and stops there will score 0.000 again, which would look as if",
			"the evidence did not help when in fact nothing read it."
		),
	]
}

function renderMethod({ withheld, control, truthForm499Rows }: RenderLinkageEvalReportInput): string[] {
	return [
		"## Metric choice",
		"",
		paragraph(
			"Precision, recall and F1 are pairwise.",
			"They count unordered registrant pairs rather than aligning predicted clusters with true ones.",
			"A predicted family's ID is derived from the canonicalized parent name, so there is no correspondence",
			"problem and no alignment step to get wrong.",
			"The only well-defined question is whether two registrants are correctly placed together or apart,",
			"and pairs answer it directly.",
			"An empty denominator is reported as `N/A`, never as zero."
		),
		"",
		"## Reproducibility",
		"",
		paragraph(
			"The SHA-256 of the withheld run's inputs, which are the exact bytes the builder received, is",
			`\`${withheld.inputsSHA256}\`.`
		),
		"",
		`The SHA-256 of the control run's inputs is \`${control.inputsSHA256}\`.`,
		"",
		paragraph(
			"The corpus is a fixed literal without sampling or randomness, the builder and the clustering pass are",
			"deterministic, and every date the runs depend on is a constant.",
			"Re-running the eval reproduces both scores and both hashes byte for byte.",
			"The test suite regenerates this page and compares it with the committed copy, so a corpus change that is",
			"not republished fails the test."
		),
		"",
		"## Caveats",
		"",
		paragraph(
			`This corpus is a synthetic set of ${truthForm499Rows.length} filers rather than real FCC Form 499 data,`,
			"because the repository ships no real corpus with a stable hash to pin.",
			"The eval gains exactness and reproducibility at the cost of scale.",
			"The withheld score does not show that ownership is hard to recover in general.",
			"It shows that this build has one way to learn a parent, and that way was removed.",
			"Scale limits confidence but not the mechanism, because a larger corpus of the same shape would score",
			"the same for the reason given above.",
			"The control score does not measure what share of real filers report a parent or how accurately they",
			"report it.",
			"It shows only that this pipeline groups filers correctly when they do."
		),
	]
}

/**
 * Renders the Markdown report for the corporate-family linkage eval, comparing the run
 * with `holdingCompany` withheld against the control run that keeps it.
 */
export function renderLinkageEvalReport(input: RenderLinkageEvalReportInput): string {
	const sections = [
		[`# ${input.date} — does filer.db recover corporate family without the disclosed parent?`],
		renderSummary(input),
		renderQuestion(),
		renderRuns(input),
		renderCorpus(input),
		renderInputShape(input),
		renderResults(input),
		renderArtifacts(input),
		renderWhyNothing(input),
		renderWhatWouldMoveIt(),
		renderMethod(input),
	]

	return `${sections.map((lines) => lines.join("\n")).join("\n\n")}\n`
}
