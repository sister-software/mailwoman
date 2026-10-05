/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The report section for a shared-route scenario, in Markdown, written so a reader can check it by hand.
 *
 *   The section opens by stating that its figures are a scenario computed from supplied assumptions, and it
 *   never presents them as a quote. It lists the conventions, the buildings and their unit evidence, the
 *   operating assumptions, every construction line with its quantity, rate, month and basis, the decision
 *   outputs, the comparison cases with their assumptions, and the full monthly table with its totals.
 *   Optional financing and transaction views follow. The low and high capex cases are labeled as scenarios,
 *   and no probability is attached to them.
 *
 *   Tables are padded to their widest cell, the layout the repository's Markdown formatter writes, so the
 *   section reads in columns as plain text and survives formatting unchanged.
 */

import { formatPercent } from "@mailwoman/core/stats"
import type { Dossier, EntityID } from "@mailwoman/dossier"

import { calendarMonth, type CashFlowRow, type CashFlowTable, projectCashFlow } from "#cash-flow"
import { compareCases, type ComparisonCase, type ComparisonRow } from "#comparison"
import {
	constructionCost,
	type ConstructionCost,
	incrementalCost,
	type IncrementalCost,
	type PricedLine,
	priceLine,
} from "#construction"
import {
	affordableExtraSpend,
	type AffordableSpend,
	breakEvenTakeRate,
	type BreakEvenTakeRate,
	capexRange,
	type CapexRange,
} from "#decision"
import { type PreparedScenario, prepareScenario } from "#eligibility"
import { type FinancingFlow, type FinancingView, financingView } from "#financing"
import { formatBasisPoints, formatDiscountFactor, formatMinorUnits, formatMoney, type MinorUnits } from "#money"
import {
	type CostAdjustment,
	type InputBasis,
	InputBasisKind,
	InputOrigin,
	buildingPlan,
	rateFor,
	type Scenario,
	type ScheduledAmount,
	TaxTreatmentKind,
} from "#scenario"
import { type TransactionCase, type TransactionView, transactionView } from "#transactions"

export interface ScenarioReportOptions {
	/**
	 * The labeled adjustments behind the capex range's low and high cases.
	 */
	capexRange: { low: CostAdjustment; high: CostAdjustment }
	/**
	 * The comparison cases, listed after the base case.
	 */
	cases: readonly ComparisonCase[]
	/**
	 * The flows of the optional financing view.
	 */
	financing?: readonly FinancingFlow[]
	/**
	 * Optional transaction cases.
	 */
	transactions?: readonly TransactionCase[]
}

export interface ScenarioReport {
	prepared: PreparedScenario
	construction: ConstructionCost
	/**
	 * Each selected building's construction cost on its own.
	 */
	alone: readonly { building: EntityID; total: MinorUnits }[]
	/**
	 * Each selected building added to the other selected buildings, then each planned
	 * and unselected building added to the selection.
	 */
	incremental: readonly IncrementalCost[]
	replacements: readonly PricedLine[]
	capex: CapexRange
	table: CashFlowTable
	affordable: AffordableSpend
	breakEven: BreakEvenTakeRate
	comparison: readonly ComparisonRow[]
	financing: FinancingView | null
	transactions: readonly TransactionView[]
}

/**
 * Computes every figure the report section prints.
 */
export function scenarioReport(dossier: Dossier, scenario: Scenario, options: ScenarioReportOptions): ScenarioReport {
	const prepared = prepareScenario(dossier, scenario)
	const table = projectCashFlow(prepared)
	const { selected } = scenario
	const unselected = scenario.buildings.map((plan) => plan.building).filter((building) => !selected.includes(building))

	const joining =
		selected.length > 1
			? selected.map((building) =>
					incrementalCost(
						prepared,
						selected.filter((other) => other !== building),
						building
					)
				)
			: []

	return {
		prepared,
		construction: constructionCost(prepared),
		alone: selected.map((building) => ({ building, total: constructionCost(prepared, [building]).total })),
		incremental: [...joining, ...unselected.map((building) => incrementalCost(prepared, selected, building))],
		replacements: scenario.replacements.map((line) => priceLine(scenario, line, scenario.costAdjustment)),
		capex: capexRange(prepared, options.capexRange.low, options.capexRange.high),
		table,
		affordable: affordableExtraSpend(table, scenario.extraSpendMonth, scenario.npvTarget),
		breakEven: breakEvenTakeRate(prepared),
		comparison: compareCases(dossier, scenario, options.cases),
		financing: options.financing ? financingView(table, options.financing) : null,
		transactions: (options.transactions ?? []).map((transaction) => transactionView(prepared, transaction)),
	}
}

/**
 * Returns a Markdown table with every cell padded to its column's widest cell
 * and a delimiter row of dashes as wide as each column, at least three.
 * A pipe inside a cell is escaped.
 */
function markdownTable(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string[] {
	const cells = [header, ...rows].map((row) => row.map((cell) => String(cell).replaceAll("|", "\\|")))
	const widths = header.map((_, column) => Math.max(3, ...cells.map((row) => row[column]!.length)))
	const line = (row: readonly string[]) => `| ${row.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ")} |`

	return [line(cells[0]!), line(widths.map((width) => "-".repeat(width))), ...cells.slice(1).map(line)]
}

function basisText(basis: InputBasis): string {
	return basis.kind === InputBasisKind.SourceRecord ? `source ${basis.source}` : `stated by ${basis.statedBy}`
}

/**
 * Renders the report section as Markdown.
 */
export function renderScenarioReport(report: ScenarioReport): string {
	const { scenario } = report.prepared
	const money = (amount: MinorUnits) => formatMoney(amount, scenario.currency)
	const cell = (amount: MinorUnits) => formatMinorUnits(amount, scenario.currency)

	const labels = new Map(
		report.prepared.dossier.buildings.map((section) => [section.building.id, section.building.label])
	)

	const label = (building: EntityID) => labels.get(building) ?? building
	const months = (month: number) => `month ${month} (${calendarMonth(scenario.monthZero, month)})`
	const rate = (id: string) => rateFor(scenario, id)

	const scheduledText = (entry: ScheduledAmount) =>
		`${entry.id}, ${entry.description}: ${money(entry.amount)} ` +
		(entry.fromMonth === entry.toMonth
			? `in month ${entry.fromMonth}`
			: `per month in months ${entry.fromMonth} to ${entry.toMonth}`) +
		` (${basisText(entry.basis)})`

	const lines: string[] = [
		`## Shared-route scenario: ${scenario.label}`,
		"",
		`${scenario.origin === InputOrigin.Synthetic ? "Every input in this section is synthetic." : "The inputs in this section are supplied by an operator."} ` +
			"The figures are a scenario computed from the supplied assumptions below. They are not a quote. " +
			"The low and high cases are scenarios from named assumptions, and no probability is attached to them.",
		"",
		"### Conventions",
		"",
		`- As of ${scenario.asOf}. Rate card ${scenario.rateCard.id} version ${scenario.rateCard.version}, stated on ${scenario.rateCard.statedOn}.`,
		`- Currency ${scenario.currency}. Every undiscounted amount is exact to the minor unit. Prices and the discount rate are ${scenario.priceBasis}.`,
		scenario.taxTreatment.kind === TaxTreatmentKind.PreTax
			? "- Tax: pre-tax. The tax column holds zero by this convention."
			: "- Tax: the operator's stated payments, entered in the months stated. The calculator computes no tax liability.",
		`- Month 0 is ${calendarMonth(scenario.monthZero, 0)}. The table runs from month 0 through ${months(scenario.horizonMonths)}.`,
		`- Discounting: effective annual rate ${formatBasisPoints(scenario.annualDiscountRateBasisPoints)}, so the monthly rate is ` +
			`(1 + annual rate)^(1/12) - 1 = ${formatPercent(report.table.monthlyDiscountRate, 1, 6)}. Month m's factor is ` +
			"(1 + monthly rate)^m rounded to eight decimal places. Each present value is the cash flow divided by its factor, " +
			"rounded half away from zero to the minor unit, and NPV is the sum of the present values.",
		`- Terminal value: zero. The base case adds no sale proceeds after ${months(scenario.horizonMonths)}.`,
		`- NPV target: ${money(scenario.npvTarget)}.`,
		"",
		"### Buildings",
		"",
		"A building's units enter the scenario from its own dossier unit total. Occupied units are a stated assumption that never exceeds that total.",
		"",
		...markdownTable(
			["Building", "Eligible units", "Service from", "Occupied units"],
			report.prepared.eligible.map((entry) => {
				const plan = buildingPlan(scenario, entry.building)

				return [
					`${entry.label} (\`${entry.building}\`)`,
					`${entry.units} ${entry.stage} units on ${entry.at} (${entry.sources.join(", ")})`,
					months(plan.serviceFromMonth),
					plan.occupancy.map((step) => `${step.units} from month ${step.fromMonth}`).join(", "),
				]
			})
		),
	]

	const { operating } = scenario
	const { uptake, monthlyChurn, promotion } = operating
	const activation = rate(operating.activationRate)
	const acquisition = rate(operating.acquisitionRate)
	const service = rate(operating.serviceRate)
	const maintenance = rate(operating.maintenance.rate)

	lines.push(
		"",
		"### Operating assumptions",
		"",
		"Occupied units, active subscribers and provider availability are separate counts.",
		"",
		...operating.prices.map(
			(step) =>
				`- Price: ${money(step.amount)} per subscriber per month from month ${step.fromMonth} (${basisText(step.basis)}).`
		),
		`- Uptake: from each building's first service month, its target of active subscribers rises in equal steps over ${uptake.rampMonths} months ` +
			`to ${formatBasisPoints(uptake.takeRateBasisPoints)} of its occupied units, rounded down to whole subscribers (${basisText(uptake.basis)}).`,
		`- Churn: ${formatBasisPoints(monthlyChurn.basisPoints)} a month, applied in whole subscribers as the floor of the cumulative expected churn. ` +
			`A churned subscriber is replaced in the same month (${basisText(monthlyChurn.basis)}).`,
		`- Promotion: each new subscriber is credited ${formatBasisPoints(promotion.basisPoints)} of the activation month's price (${basisText(promotion.basis)}).`,
		`- Activation and acquisition: ${money(activation.amount)} and ${money(acquisition.amount)} per new subscriber ` +
			`(rates ${activation.id} and ${acquisition.id}, ${basisText(activation.basis)}).`,
		`- Service: ${money(service.amount)} per active subscriber per month (rate ${service.id}, ${basisText(service.basis)}).`,
		`- Maintenance: ${money(maintenance.amount)} per month from month ${operating.maintenance.fromMonth} (rate ${maintenance.id}, ${basisText(maintenance.basis)}).`,
		...(scenario.workingCapital.length
			? scenario.workingCapital.map(
					(step) =>
						`- Working capital: ${money(step.balance)} held from month ${step.fromMonth} (${basisText(step.basis)}).`
				)
			: ["- Working capital: none held."]),
		...report.replacements.map(
			(priced) =>
				`- Replacement: ${priced.line.id}, ${priced.line.description}, ${priced.line.quantity.value} ${priced.line.quantity.unit} × ` +
				`${cell(priced.rate.amount)} = ${money(priced.amount)} in month ${priced.line.month} (${basisText(priced.line.quantity.basis)}).`
		),
		""
	)

	const { construction } = report

	const lineCells = (priced: PricedLine, chargedTo: string) => [
		`${priced.line.id}: ${priced.line.description}`,
		priced.line.category,
		`${priced.line.quantity.value} ${priced.line.quantity.unit}`,
		`${cell(priced.rate.amount)} per ${priced.rate.unit}`,
		cell(priced.amount),
		priced.line.month,
		chargedTo,
		basisText(priced.line.quantity.basis),
	]

	lines.push(
		"### Construction",
		"",
		"Each distinct route segment is charged once, however many selected buildings use it.",
		"",
		...markdownTable(
			["Line", "Category", "Quantity", "Rate", "Amount", "Month", "Charged to", "Basis"],
			[
				...construction.segments.flatMap((segment) =>
					segment.lines.map((priced) =>
						lineCells(priced, `segment ${segment.segment.id}, used by ${segment.usedBy.map(label).join(" and ")}`)
					)
				),
				...construction.project.map((priced) => lineCells(priced, "the project")),
				...construction.buildings.flatMap((building) =>
					building.lines.map((priced) => lineCells(priced, label(building.building)))
				),
			]
		),
		"",
		`- Common cost: ${money(construction.common)}, the route's ${money(construction.route)} and the project's ${money(construction.projectTotal)}.`,
		`- Direct cost: ${construction.buildings.map((building) => `${label(building.building)} ${money(building.amount)}`).join(". ")}.`,
		`- Total project cost: ${money(construction.total)}.`,
		...report.alone.map((entry) => `- ${label(entry.building)} alone: ${money(entry.total)}.`),
		...report.incremental.map(
			(entry) =>
				`- Adding ${label(entry.added)} to ${entry.base.length ? entry.base.map(label).join(" and ") : "an empty selection"}: ` +
				`${money(entry.incremental)}${entry.newSegments.length ? `, including segment ${entry.newSegments.join(" and ")}` : ""}.`
		),
		`- Capex range, as scenarios: low ${money(report.capex.low.total)} (${report.capex.low.label}), ` +
			`base ${money(report.capex.base.total)} (${report.capex.base.label}), ` +
			`high ${money(report.capex.high.total)} (${report.capex.high.label}).`,
		""
	)

	const { table, affordable, breakEven } = report

	lines.push(
		"### Decision outputs",
		"",
		`- NPV at ${formatBasisPoints(scenario.annualDiscountRateBasisPoints)}: ${money(table.npv)}, against a target of ${money(scenario.npvTarget)}.`,
		`- First revenue: ${table.firstRevenueMonth === null ? "none within the horizon" : months(table.firstRevenueMonth)}.`,
		`- Cash required before first revenue: ${money(table.cashBeforeFirstRevenue)}.`,
		table.peakFunding.month === null
			? "- Peak funding: none. The cumulative cash flow stays at or above zero."
			: `- Peak funding: ${money(table.peakFunding.amount)}, reached in ${months(table.peakFunding.month)}` +
					(table.firstRevenueMonth !== null && table.peakFunding.month > table.firstRevenueMonth
						? ", after first revenue."
						: "."),
		affordable.status === "within_target"
			? `- Affordable extra construction spend: ${money(affordable.amount)} paid in ${months(affordable.month)}, ` +
					`at the factor ${formatDiscountFactor(affordable.discountFactorE8)}, keeps the NPV at or above ${money(affordable.target)}.`
			: `- Affordable extra construction spend: none. The NPV is ${money(affordable.shortfall)} below the target before any extra spend.`,
		breakEven.status === "reached"
			? `- Break-even take rate: ${formatBasisPoints(breakEven.takeRateBasisPoints)} of occupied units under the uptake assumption. ` +
					`In ${months(breakEven.month)}, ${breakEven.active} of ${breakEven.occupied} occupied units subscribe ` +
					`(${formatPercent(breakEven.active, breakEven.occupied, 2)}), and the NPV is ${money(breakEven.npv)}.`
			: `- Break-even take rate: unreachable. With every occupied unit subscribing, the NPV is ${money(breakEven.npvAtFullTake)}.`,
		""
	)

	let lowest = report.comparison[0]!

	for (const row of report.comparison)
		if (row.npv < lowest.npv) {
			lowest = row
		}

	lines.push(
		"### Comparison",
		"",
		`Every case keeps the base case's buildings and conventions and changes the one assumption it states. Amounts are in ${scenario.currency}.`,
		"",
		...markdownTable(
			["Case", "Assumption", "Capex", "NPV", "First revenue", "Cash before first revenue", "Peak funding"],
			report.comparison.map((row) => [
				row.label,
				row.assumption,
				cell(row.capex),
				cell(row.npv),
				row.firstRevenueMonth === null ? "none" : `month ${row.firstRevenueMonth}`,
				cell(row.cashBeforeFirstRevenue),
				row.peakFunding.month === null ? cell(0) : `${cell(row.peakFunding.amount)} in month ${row.peakFunding.month}`,
			])
		),
		"",
		`Lowest NPV among the cases: ${money(lowest.npv)}, under "${lowest.label}": ${lowest.assumption}.`,
		""
	)

	const joined = table.totals.joined > 0
	const { totals } = table

	const monthCells = (row: CashFlowRow) => [
		row.month,
		row.calendarMonth,
		row.occupied,
		row.active,
		row.newActivations,
		row.churn,
		...(joined ? [row.joined] : []),
		cell(row.receipts),
		cell(row.promotion),
		cell(row.serviceAndMaintenance),
		cell(row.acquisitionAndActivation),
		cell(row.constructionAndReplacement),
		cell(row.workingCapitalIncrease),
		cell(row.tax),
		cell(row.cashFlow),
		cell(row.cumulative),
		formatDiscountFactor(row.discountFactorE8),
		cell(row.presentValue),
	]

	lines.push(
		"### Monthly cash flow",
		"",
		`Unfinanced project cash flow in ${scenario.currency}. Cash flow is receipts minus promotion, service and maintenance, ` +
			"acquisition and activation, construction and replacement, the working-capital increase and tax.",
		"",
		...markdownTable(
			[
				"Month",
				"Calendar",
				"Occupied",
				"Active",
				"New",
				"Churn",
				...(joined ? ["Joined"] : []),
				"Receipts",
				"Promotion",
				"Service and maintenance",
				"Acquisition and activation",
				"Construction and replacement",
				"Working-capital increase",
				"Tax",
				"Cash flow",
				"Cumulative",
				"Factor",
				"Present value",
			],
			[
				...table.rows.map(monthCells),
				[
					"Total",
					"",
					"",
					"",
					totals.newActivations,
					totals.churn,
					...(joined ? [totals.joined] : []),
					cell(totals.receipts),
					cell(totals.promotion),
					cell(totals.serviceAndMaintenance),
					cell(totals.acquisitionAndActivation),
					cell(totals.constructionAndReplacement),
					cell(totals.workingCapitalIncrease),
					cell(totals.tax),
					cell(totals.cashFlow),
					"",
					"",
					cell(totals.presentValue),
				],
			]
		),
		""
	)

	if (report.financing) {
		const view = report.financing
		const { totals: sums } = view

		lines.push(
			"### Financing view",
			"",
			"The financing view adds each flow once beside the unfinanced table, which it leaves unchanged.",
			"",
			...markdownTable(
				["Flow", "Kind", "Months", "Amount per month", "Total", "Basis"],
				view.flows.map((flow) => [
					`${flow.id}: ${flow.description}`,
					flow.kind,
					flow.fromMonth === flow.toMonth ? String(flow.fromMonth) : `${flow.fromMonth} to ${flow.toMonth}`,
					cell(flow.amount),
					cell(flow.amount * (flow.toMonth - flow.fromMonth + 1)),
					basisText(flow.basis),
				])
			),
			"",
			`- Net cash flow: project ${money(sums.projectCashFlow)}, plus equity ${money(sums.equity)}, draws ${money(sums.debtDraws)} ` +
				`and grants ${money(sums.grants)}, minus repayments ${money(sums.debtRepayments)} and interest ${money(sums.interest)}, ` +
				`is ${money(sums.netCashFlow)}.`,
			view.reconciles
				? `- In each of the ${view.rows.length} months, the net cash flow minus that month's financing flows equals the project cash flow.`
				: "- The financing view does not reconcile to the project table.",
			view.fundingGap === null
				? "- Funding gap: none. The cash balance stays at or above zero in every month."
				: `- Funding gap: the cash balance falls to ${money(view.fundingGap.balance)} in ${months(view.fundingGap.month)}.`,
			""
		)
	}

	if (report.transactions.length) {
		lines.push(
			"### Transaction cases",
			"",
			`Each case is optional and reads against the base case, whose NPV is ${money(table.npv)} with zero terminal value. ` +
				`Amounts are in ${scenario.currency}.`,
			"",
			...markdownTable(
				[
					"Case",
					"Kind",
					"Integration",
					"Avoided construction",
					"Subscriber change",
					"Obligations",
					"Proceeds",
					"Case NPV",
					"Reconciles",
				],
				report.transactions.map((view) => [
					view.transaction.label,
					view.transaction.kind,
					`month ${view.transaction.integrationMonth}`,
					cell(view.totals.avoidedConstruction),
					cell(view.totals.subscriberChange),
					cell(view.totals.obligations),
					cell(view.totals.proceeds),
					cell(view.npv),
					view.reconciles ? "yes" : "no",
				])
			),
			""
		)

		for (const view of report.transactions) {
			const { transaction } = view

			lines.push(
				`${transaction.label} (${transaction.kind}, from ${months(transaction.integrationMonth)}):`,
				"",
				...(transaction.leasedSegments.length ? [`- Leased segments: ${transaction.leasedSegments.join(", ")}.`] : []),
				...transaction.acquiredSubscribers.map(
					(entry) =>
						`- Acquired subscribers: ${entry.count} in ${label(entry.building)}, joining without activation cost.`
				),
				...(transaction.obligations.length
					? transaction.obligations.map((entry) => `- Obligation: ${scheduledText(entry)}.`)
					: ["- Obligations: none."]),
				...(transaction.proceeds.length
					? transaction.proceeds.map((entry) => `- Proceeds: ${scheduledText(entry)}.`)
					: ["- Proceeds: none."]),
				""
			)
		}
	}

	return lines.join("\n")
}
