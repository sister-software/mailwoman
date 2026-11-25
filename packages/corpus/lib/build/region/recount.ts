// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The `region:unknown` count of a reused source, recounted under the region data the reusing build reads.
 *
 *   The region data changes no row's bytes, so it stays out of a source's derivation. A source written under other
 *   region data is the same work apart from that one count. A source record states the fingerprints of the region
 *   data its count was made under, and the region value of every row the check read. A reusing build recounts from
 *   those values when the fingerprints differ. A record written before the values existed can't be recounted, and is
 *   refused.
 */

import { canonicalJSON } from "@mailwoman/core/values/json"

import type { AlignTotalsRecord } from "#build/align/totals"
import { ComponentRule, countRegionUnknown } from "#build/component-check"
import type { RegionNames } from "#build/region/names"
import { REGION_CHECK_INPUTS } from "#build/settings"

/**
 * The fields of a source's completion record the recount reads and writes.
 */
export interface RegionCheckedRecord {
	source: string
	derivation: { config: unknown }
	totals: AlignTotalsRecord
	/**
	 * The fingerprints of the region data the `region:unknown` count in `totals`
	 * was made under, from `regionCheckFingerprints`.
	 *
	 * A record written before the region data left the derivation holds them in `derivation.config.alignData`.
	 */
	regionCheck?: Record<string, string>
}

/**
 * The `alignData` fingerprints of a derivation's config, or `null` when it records none.
 */
function alignDataOf(config: unknown): Record<string, unknown> | null {
	if (typeof config !== "object" || config == null) return null

	const alignData = (config as Record<string, unknown>)["alignData"]

	return typeof alignData === "object" && alignData != null ? (alignData as Record<string, unknown>) : null
}

/**
 * The fingerprints of the region data a record's count was made under: its `regionCheck`,
 * or the region keys a record written before the field kept in its derivation's `alignData`.
 */
export function recordedRegionCheck(record: RegionCheckedRecord): Record<string, string> | null {
	if (record.regionCheck) return record.regionCheck

	const alignData = alignDataOf(record.derivation.config)

	if (!alignData) return null

	const recorded: Record<string, string> = {}

	for (const key of REGION_CHECK_INPUTS) {
		const fingerprint = alignData[key]

		if (typeof fingerprint !== "string") return null

		recorded[key] = fingerprint
	}

	return recorded
}

/**
 * A derivation with the region keys a record written before `regionCheck` kept in
 * `alignData` left out, so a record of either age compares with this build's derivation.
 */
export function withoutRegionCheckInputs<T extends { config: unknown }>(derivation: T): T {
	const alignData = alignDataOf(derivation.config)

	if (!alignData) return derivation

	const kept = Object.fromEntries(
		Object.entries(alignData).filter(([key]) => !(REGION_CHECK_INPUTS as readonly string[]).includes(key))
	)

	return { ...derivation, config: { ...(derivation.config as Record<string, unknown>), alignData: kept } }
}

/**
 * The record with its `region:unknown` count made under the region data `current`
 * fingerprints, or why it can't be.
 *
 * A record already made under `current` comes back with only its `regionCheck` set.
 * Under `regions` null the count is removed and the rule listed as unchecked,
 * as an align without the database writes.
 */
export async function recountRegionCheck<T extends RegionCheckedRecord>(
	record: T,
	current: Record<string, string>,
	readRegions: () => Promise<RegionNames | null>
): Promise<{ record: T; problem: null } | { record: null; problem: string }> {
	const recorded = recordedRegionCheck(record)

	if (recorded && canonicalJSON(recorded) === canonicalJSON(current)) {
		return { record: { ...record, regionCheck: current }, problem: null }
	}

	const values = record.totals.region_values

	if (!values) {
		return {
			record: null,
			problem:
				`${record.source}'s record was made under other region data and records no region values, ` +
				`so its region:unknown count can't be recounted`,
		}
	}

	const regions = await readRegions()
	const unknown = regions ? countRegionUnknown(values, regions) : 0

	const findings = record.totals.component_findings_by_source.map(
		([source, rules]): [string, [ComponentRule, number][]] => [
			source,
			rules.filter(([rule]) => rule !== ComponentRule.RegionUnknown),
		]
	)

	if (unknown > 0) {
		const own = findings.find(([source]) => source === record.source)

		if (own) {
			own[1].push([ComponentRule.RegionUnknown, unknown])
		} else {
			findings.push([record.source, [[ComponentRule.RegionUnknown, unknown]]])
		}
	}

	const unchecked = record.totals.unchecked_component_rules.filter((rule) => rule !== ComponentRule.RegionUnknown)

	return {
		record: {
			...record,
			totals: {
				...record.totals,
				// An align counts a source only once a row of it fails a rule.
				component_findings_by_source: findings.filter(([, rules]) => rules.length > 0),
				unchecked_component_rules: regions ? unchecked : [...unchecked, ComponentRule.RegionUnknown],
			},
			regionCheck: current,
		},
		problem: null,
	}
}
