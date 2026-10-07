/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The words the application shows for the model's values. Each building state, segment status, selection and
 *   synthetic figure has a word that a screen reader reads and a search of the page text finds, so color
 *   never provides one of them on its own. An unresolved unit total is written as the word unresolved and
 *   never as a number.
 */

import { type EntityID, type ISODate, proseList } from "@mailwoman/dossier"
import {
	BuildingState,
	type DistrictProperties,
	DistrictPlacement,
	type FeaturePosition,
	type RouteSegmentProperties,
	type SelectionEconomics,
	SegmentStatus,
	type UnitDenominator,
} from "@mailwoman/opportunity-map"
import { calendarMonth, formatMoney, type InputBasis, InputBasisKind } from "@mailwoman/route-scenarios"

import type { Outcome } from "#view"

/**
 * The words of each building state.
 */
export const STATE_WORDS: Readonly<Record<BuildingState, string>> = {
	[BuildingState.UnknownUnitCount]: "unknown unit count",
	[BuildingState.ZeroPremises]: "zero premises",
	[BuildingState.PartialAvailability]: "partial availability",
	[BuildingState.KnownUnserved]: "known unserved",
	[BuildingState.UnknownCoverage]: "unknown coverage",
}

/**
 * The words of each segment status.
 */
export const SEGMENT_WORDS: Readonly<Record<SegmentStatus, string>> = {
	[SegmentStatus.Verified]: "verified existing segment",
	[SegmentStatus.Proposed]: "proposed construction",
}

/**
 * A building's unit denominator: its resolved total with stage and date,
 * or the word unresolved with its stage.
 */
export function unitsText(units: UnitDenominator): string {
	return units.total === "unresolved"
		? `Units: unresolved at the ${units.stage} stage`
		: `Units: ${units.total} ${units.stage} units on ${units.at}`
}

/**
 * A month of the scenario's table with its calendar month, or the words for no month within the horizon.
 */
export function monthText(monthZero: ISODate, month: number | null): string {
	return month === null ? "none within the horizon" : `month ${month} (${calendarMonth(monthZero, month)})`
}

/**
 * Where an input's value came from: a source record or the party that stated the assumption.
 */
export function inputBasisText(basis: InputBasis): string {
	return basis.kind === InputBasisKind.SourceRecord
		? `source record ${basis.source}`
		: `operator assumption stated by ${basis.statedBy}`
}

/**
 * The origin word that every economic figure shows.
 */
export function originText(synthetic: boolean): string {
	return synthetic ? "synthetic" : "operator supplied"
}

/**
 * A building's position as its list row states it.
 * An unresolved position lists the positions that differ.
 */
export function positionText(position: FeaturePosition): string {
	if (position.status === "resolved") {
		return `Position: ${position.synthetic ? "synthetic, " : ""}from ${proseList(position.sources)}.`
	}

	const candidates = position.candidates.map(
		(entry) => `${entry.latitude}, ${entry.longitude} per ${entry.source}${entry.synthetic ? ", synthetic" : ""}`
	)

	return `Position: unresolved, ${position.reason}${candidates.length ? `: ${candidates.join("; ")}` : ""}. The map draws no marker for this building.`
}

/**
 * A district's row header and marker heading: its extent, or the words for the
 * buildings that no single extent of the kind places.
 */
export function districtHeading(properties: DistrictProperties): string {
	if (properties.extent) return properties.extent

	return properties.placement === DistrictPlacement.Unplaced
		? `Buildings with no ${properties.extentKind} membership`
		: `Buildings with two or more ${properties.extentKind} memberships`
}

/**
 * The count of a district's buildings in each state it holds, in the order of the state rules.
 */
export function statesText(states: Readonly<Record<BuildingState, number>>): string {
	return proseList(
		Object.values(BuildingState)
			.filter((state) => states[state] > 0)
			.map((state) => `${states[state]} ${STATE_WORDS[state]}`)
	)
}

/**
 * One route segment in words: its status, whether it is shared, its basis, its path and its cost.
 */
export function segmentText(properties: RouteSegmentProperties, labels: ReadonlyMap<EntityID, string>): string {
	const { segment, status, shared, description, usedBy, basis, synthetic, economics } = properties

	return [
		`${segment}: ${SEGMENT_WORDS[status]}${shared ? ", shared" : ""}.`,
		`${description}.`,
		`Used by ${proseList(usedBy.map((building) => labels.get(building) ?? building))}.`,
		`Basis: ${inputBasisText(basis)}.`,
		`Path: ${synthetic ? "synthetic" : "sourced"}.`,
		`Construction cost in this selection: ${formatMoney(economics.amount, economics.currency)}, ${originText(economics.synthetic)}.`,
	].join(" ")
}

/**
 * What the live region announces after a change: the selection's two headline figures,
 * the model's refusal, or the empty selection.
 */
export function recalculationText(economics: Outcome<SelectionEconomics>): string {
	if (economics.status === "empty") return "No building is selected."

	if (economics.status === "refused") return `Recalculated: no figures. ${economics.message}`

	const { selection, currency, construction, npv, synthetic } = economics.value
	const count = selection.length

	return (
		`Recalculated for ${count} selected ${count === 1 ? "building" : "buildings"}: ` +
		`total construction cost ${formatMoney(construction.total, currency)}, ` +
		`net present value ${formatMoney(npv, currency)}, ${originText(synthetic)} figures.`
	)
}
