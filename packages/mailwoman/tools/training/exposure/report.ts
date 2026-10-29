/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The exposure measurement artifact: per jurisdiction, what each pipeline stage holds and which phenomena it
 *   exercises.
 *
 *   Stages, in pipeline order:
 *
 *   - `source_records`: records the source published that the acquisition read, from the acquisition's stats file.
 *   - `canonical_rows`: rows an adapter wrote to `canonical.jsonl` after its refusals and deduplication.
 *   - `eligible_training_rows`: rows in the built corpus's `train` split that the training config admits, by a
 *       positive country weight and a positive source weight (or no source weights).
 *   - `replayed_draws`: rows the training mixture draws in epoch 1, reconstructed with the trainer's seed.
 *   - `realized_draws`: rows the trainer logged as drawn, recorded only from a trainer log.
 *
 *   A stage that was not measured is `null`. A stage measured at zero is `{"total": 0, ...}`. The two are different
 *   facts and the report never writes one for the other.
 *
 *   The report is the Python `exposure/report.py` artifact, `mailwoman.exposure/v1`, byte for byte apart from
 *   `measured_at`.
 */

import { gitHead } from "@mailwoman/core/git"
import type { PythonText } from "@mailwoman/mtf/tools/sampler/native"
import { IGNORE_INDEX } from "@mailwoman/neural/labels"
import type { LabelSetContract } from "@mailwoman/neural/semantic-tags"
import type { AddressSystemRegistry } from "@mailwoman/neural/tools/address-system-registry"
import { JSONSpliterator } from "spliterator"

import { countInto, sortedByKey } from "../audits/receipt.ts"
import {
	isRelational,
	LocateError,
	PHENOMENON_IDS,
	Row,
	rowFromSpans,
	rowPhenomena,
	spansFromComponents,
	ARITY,
} from "./phenomena.ts"

/**
 * The artifact's schema id.
 */
export const EXPOSURE_SCHEMA = "mailwoman.exposure/v1"

/**
 * The stages, in pipeline order.
 */
export const STAGES = [
	"source_records",
	"canonical_rows",
	"eligible_training_rows",
	"replayed_draws",
	"realized_draws",
] as const

export type Stage = (typeof STAGES)[number]

/**
 * The address-system id of a row: its country's `latin` system for Latin-script text when it
 * has one, its `local` system otherwise, and the ignore index for a country with no layout.
 */
export type AddressSystemOf = (country: string, raw: string) => number

/**
 * The lookup `address_systems.address_system_id` makes, with Latin script judged by Unicode name.
 */
export function addressSystemLookup(registry: AddressSystemRegistry, text: PythonText): AddressSystemOf {
	const members = new Map(registry.members.map((m) => [`${m.country}/${m.script}`, m.system]))

	return (country, raw) => {
		if (!country) return IGNORE_INDEX

		const code = country.trim().toUpperCase()

		if (text.isLatinText(raw)) {
			const latin = members.get(`${code}/latin`)

			if (latin != null) return latin
		}

		return members.get(`${code}/local`) ?? IGNORE_INDEX
	}
}

/**
 * A canonical adapter row, as the counter reads it.
 */
export interface CanonicalRecord {
	raw?: unknown
	country?: unknown
	components?: Record<string, string> | null
}

/**
 * A built corpus row, as the counter reads it.
 */
export interface SpanRecord {
	raw: string | null | undefined
	country: string | null | undefined
	spanStarts?: number[] | null
	spanEnds?: number[] | null
	spanTags?: string[] | null
}

/**
 * Python's `str()` of a value read from a row.
 */
function pythonString(value: unknown): string {
	if (value == null) return "None"

	return String(value)
}

/**
 * A row's country as the counter keys it: `str(country or "").upper()`.
 */
export function rowCountry(country: unknown): string {
	return country ? String(country).toUpperCase() : ""
}

/**
 * Totals and phenomenon forms for one stage, keyed by jurisdiction.
 */
export class StageCounter {
	readonly stage: Stage
	readonly totals = new Map<string, number>()
	readonly unreadable = new Map<string, number>()
	readonly forms = new Map<string, Map<string, Map<string, number>>>()
	/**
	 * Rows per address-system id.
	 * The ignore index counts rows whose country has no layout.
	 */
	readonly systems = new Map<number, number>()
	readonly #addressSystem: AddressSystemOf
	readonly #text: PythonText

	constructor(stage: Stage, addressSystem: AddressSystemOf, text: PythonText) {
		this.stage = stage
		this.#addressSystem = addressSystem
		this.#text = text
	}

	add(row: Row): void {
		countInto(this.totals, row.country)
		countInto(this.systems, this.#addressSystem(row.country, row.raw))

		for (const [phenomenon, form] of rowPhenomena(row)) {
			countInto(this.formsOf(row.country, phenomenon), form)
		}
	}

	/**
	 * A row the stage holds but the predicates could not read.
	 * It counts toward the total.
	 */
	addUnreadable(country: string): void {
		countInto(this.totals, country)
		countInto(this.unreadable, country)
	}

	addCanonical(record: CanonicalRecord): void {
		const country = rowCountry(record.country)
		const raw = pythonString(record.raw)
		let spans

		try {
			spans = spansFromComponents(this.#text, raw, record.components ?? {})
		} catch (error) {
			if (error instanceof LocateError) return this.addUnreadable(country)

			throw error
		}

		this.add(new Row(raw, country, spans))
	}

	addSpanRow(record: SpanRecord): void {
		const country = rowCountry(record.country)
		const { spanStarts, spanEnds, spanTags } = record

		if (spanStarts == null || spanEnds == null || spanTags == null) return this.addUnreadable(country)

		this.add(rowFromSpans(pythonString(record.raw), country, spanStarts, spanEnds, spanTags))
	}

	/**
	 * The form counts of one phenomenon in one jurisdiction, created empty when absent.
	 */
	formsOf(country: string, phenomenon: string): Map<string, number> {
		let byPhenomenon = this.forms.get(country)

		if (!byPhenomenon) {
			this.forms.set(country, (byPhenomenon = new Map()))
		}

		let counts = byPhenomenon.get(phenomenon)

		if (!counts) {
			byPhenomenon.set(phenomenon, (counts = new Map()))
		}

		return counts
	}
}

/**
 * Counts every row of canonical JSONL files, compressed or not, into one counter.
 */
export async function countCanonicalJSONL(counter: StageCounter, paths: readonly string[]): Promise<StageCounter> {
	for (const path of paths) {
		for await (const record of JSONSpliterator.fromAsync<CanonicalRecord>(path)) {
			counter.addCanonical(record)
		}
	}

	return counter
}

/**
 * Cross-jurisdiction pairs available for `numeric-shape-across-contexts` at one stage.
 *
 * Two rows from different jurisdictions whose postcodes share one all-digit width form a pair,
 * so the count for a width and two jurisdictions is the product of their row counts at that width.
 */
export function numericShapePairs(counter: StageCounter): Map<string, number> {
	const byWidth = new Map<string, Map<string, number>>()

	for (const [country, phenomena] of counter.forms) {
		for (const [width, rows] of phenomena.get("fixed-width-numeric-postcode") ?? []) {
			let countries = byWidth.get(width)

			if (!countries) {
				byWidth.set(width, (countries = new Map()))
			}

			countries.set(country, rows)
		}
	}

	const out = new Map<string, number>()

	for (const [width, countries] of sortedByKey(byWidth)) {
		const codes = [...countries.keys()].toSorted()

		for (const [i, a] of codes.entries()) {
			for (const b of codes.slice(i + 1)) {
				out.set(`${width}:${a}/${b}`, countries.get(a)! * countries.get(b)!)
			}
		}
	}

	return out
}

/**
 * The checkout's `HEAD` commit, or `null` outside a git checkout, as the report's `code_revision`.
 */
export async function codeRevision(): Promise<string | null> {
	return gitHead().then(
		(head) => head.trim(),
		() => null
	)
}

/**
 * `datetime.now(UTC).isoformat(timespec="seconds")`.
 */
export function measuredAt(now = new Date()): string {
	return `${now.toISOString().slice(0, 19)}+00:00`
}

/**
 * What a report records beside its stages.
 */
export interface ReportContext {
	sourceRecords?: Map<string, Map<string, unknown>> | null
	pairs?: Map<string, unknown> | null
	corpusVersion?: string | null
	trainingConfig?: string | null
	labelSet?: LabelSetContract | null
	inputs?: Map<string, string>
	codeRevision: string | null
	measuredAt: string
	registry: AddressSystemRegistry
}

/**
 * Assembles the artifact from per-stage counters.
 *
 * Every phenomenon id appears under every jurisdiction a stage measured, so a phenomenon the
 * stage holds no row of reads as an empty form map at that stage rather than being absent.
 *
 * @throws When two counters share a stage name outside {@linkcode STAGES}.
 */
export function buildReport(counters: readonly StageCounter[], context: ReportContext): Map<string, unknown> {
	const byStage = new Map<string, StageCounter>()

	for (const counter of counters) {
		byStage.set(counter.stage, counter)
	}

	const unknown = [...byStage.keys()].filter((stage) => !(STAGES as readonly string[]).includes(stage))

	if (unknown.length) throw new Error(`unknown stages ${unknown.toSorted().join(", ")}`)

	const sourceRecords = context.sourceRecords ?? null
	const countries = new Set<string>(sourceRecords?.keys())

	for (const counter of byStage.values()) {
		for (const country of counter.totals.keys()) {
			countries.add(country)
		}
	}

	const body = new Map<string, unknown>()

	for (const country of [...countries].toSorted()) {
		const stages = new Map<string, unknown>()

		for (const stage of STAGES) {
			if (stage === "source_records" && sourceRecords?.size && sourceRecords.has(country)) {
				stages.set(stage, sourceRecords.get(country))

				continue
			}

			const counter = byStage.get(stage)

			stages.set(
				stage,
				counter
					? new Map([
							["total", counter.totals.get(country) ?? 0],
							["unreadable", counter.unreadable.get(country) ?? 0],
						])
					: null
			)
		}

		const phenomena = new Map<string, unknown>()

		for (const phenomenon of PHENOMENON_IDS) {
			const entry = new Map<string, unknown>([["arity", ARITY[phenomenon]]])

			for (const stage of STAGES.slice(1)) {
				const counter = byStage.get(stage)

				entry.set(
					stage,
					isRelational(phenomenon) || !counter
						? null
						: new Map(sortedByKey(counter.forms.get(country)?.get(phenomenon) ?? []))
				)
			}

			phenomena.set(phenomenon, entry)
		}

		body.set(
			country,
			new Map<string, unknown>([
				["stages", stages],
				["phenomena", phenomena],
			])
		)
	}

	return new Map<string, unknown>([
		["schema", EXPOSURE_SCHEMA],
		["measured_at", context.measuredAt],
		["code_revision", context.codeRevision],
		["corpus_version", context.corpusVersion ?? null],
		["training_config", context.trainingConfig ?? null],
		["label_set", context.labelSet ?? null],
		["inputs", context.inputs ?? new Map()],
		["denominator", "rows per jurisdiction at each stage; each phenomenon form counts rows exercising it"],
		["jurisdictions", body],
		["address_systems", addressSystemSection(byStage, context.registry)],
		["pairs", context.pairs ?? null],
	])
}

/**
 * Every registered system: its id, its key and the `CC/script` members that follow it,
 * as `address_systems.address_system_table` lists them.
 */
export function systemsWithMembers(
	registry: AddressSystemRegistry
): Array<{ id: number; key: string; members: string[] }> {
	const members = new Map<string, number>()

	for (const member of registry.members) {
		members.set(`${member.country}\u0000${member.script}`, member.system)
	}

	const bySystem = new Map<number, string[]>()

	for (const [key, system] of sortedByKey(members)) {
		const [country, script] = key.split("\u0000")
		const list = bySystem.get(system) ?? []

		list.push(`${country}/${script}`)
		bySystem.set(system, list)
	}

	return registry.systems.map((s) => ({ id: s.id, key: s.key, members: bySystem.get(s.id) ?? [] }))
}

/**
 * Rows per address system at each measured stage, beside the system's key and members.
 *
 * A system no stage reached reads 0 at each measured stage, so the section
 * lists every system the registry holds.
 */
export function addressSystemSection(
	byStage: ReadonlyMap<string, StageCounter>,
	registry: AddressSystemRegistry
): Map<string, unknown> {
	const rows = (id: number) => new Map([...byStage].map(([stage, counter]) => [stage, counter.systems.get(id) ?? 0]))

	return new Map<string, unknown>([
		["denominator", "readable rows at each stage, assigned by country and script"],
		[
			"systems",
			systemsWithMembers(registry).map(
				(entry) =>
					new Map<string, unknown>([
						["id", entry.id],
						["key", entry.key],
						["members", entry.members],
						["rows", rows(entry.id)],
					])
			),
		],
		["no_system", rows(IGNORE_INDEX)],
	])
}
