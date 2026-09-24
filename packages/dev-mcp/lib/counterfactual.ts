/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Measure one-setting-at-a-time counterfactuals for selected rows. Unavailable flips are reported with reasons.
 *   Runs are grouped by setting so rows can reuse each constructed engine.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { haversineKm } from "@mailwoman/spatial"
import type { GeocodeSessionOptions } from "mailwoman/geocode"

import type { EngineConfig, EngineRegistryLike } from "#engine/registry"
import { DISTANCE_THRESHOLDS_KM } from "#geo-grade"

/**
 * Settings measured by this counterfactual pass, in CLI vocabulary.
 */
export const COUNTERFACTUAL_SETTINGS = ["locale", "gazetteer_prior", "country_scope", "fork_entity"] as const

export type CounterfactualSetting = (typeof COUNTERFACTUAL_SETTINGS)[number]

/**
 * Minimum coordinate movement reported, using the finest registered grading threshold.
 *
 * Any change in abstention is reported regardless of distance.
 */
export const COUNTERFACTUAL_MOVED_KM = DISTANCE_THRESHOLDS_KM[0]

/**
 * Base weights locale used as the destination when a row's overlay is removed.
 */
export const BASE_LOCALE = "en-US"

/**
 * Path to the manifest listing published locale overlays.
 */
const RELEASE_CONFIG_RELATIVE_PATH = "release.config.json"

interface ReleaseLocales {
	locales?: string[]
}

let overlayLocaleCache: Map<string, string> | null = null

/**
 * Map each overlay's region subtag to its locale tag.
 *
 * When multiple overlays share a country, the first manifest entry wins.
 */
async function overlayLocaleByCountry(): Promise<Map<string, string>> {
	if (overlayLocaleCache) return overlayLocaleCache

	const manifest = await readLocalJSONFile<ReleaseLocales>(repoRootPath(RELEASE_CONFIG_RELATIVE_PATH))

	const byCountry = new Map<string, string>()

	for (const locale of manifest.locales ?? []) {
		const [language, region] = locale.split("-")

		if (!language || !region) continue

		const country = region.toUpperCase()

		if (!byCountry.has(country)) {
			byCountry.set(country, `${language.toLowerCase()}-${country}`)
		}
	}

	overlayLocaleCache = byCountry

	return byCountry
}

/**
 * One setting change and its corresponding configuration patch.
 */
export interface CounterfactualFlip {
	setting: CounterfactualSetting
	from: string
	to: string
	patch: EngineConfig
}

/**
 * Setting that could not be flipped for a row and the reason.
 */
export interface SettingSkip {
	setting: CounterfactualSetting
	why: string
}

/**
 * Enumerate applicable flips from fully resolved session options.
 */
export async function enumerateFlips(
	effective: GeocodeSessionOptions,
	country: string | undefined
): Promise<{ flips: CounterfactualFlip[]; skipped: SettingSkip[] }> {
	const flips: CounterfactualFlip[] = []
	const skipped: SettingSkip[] = []

	const localeFlip = await localeCounterfactual(effective.locale, country)

	if ("why" in localeFlip) {
		skipped.push({ setting: "locale", why: localeFlip.why })
	} else {
		flips.push(localeFlip)
	}

	flips.push({
		setting: "gazetteer_prior",
		from: String(effective.gazetteerPrior),
		to: String(!effective.gazetteerPrior),
		patch: { gazetteer_prior: !effective.gazetteerPrior },
	})

	const scopeTo = effective.countryScope === "none" ? "auto" : "none"

	flips.push({
		setting: "country_scope",
		from: effective.countryScope,
		to: scopeTo,
		patch: { country_scope: scopeTo },
	})

	flips.push({
		setting: "fork_entity",
		from: String(effective.forkEntity),
		to: String(!effective.forkEntity),
		patch: { fork_entity: !effective.forkEntity },
	})

	return { flips, skipped }
}

/**
 * Return a locale flip, or explain why no country overlay applies.
 */
async function localeCounterfactual(
	current: string,
	country: string | undefined
): Promise<CounterfactualFlip | { why: string }> {
	if (!country) {
		return { why: "the input set carries no country for this row, so there is no row locale to flip to" }
	}

	const rowLocale = (await overlayLocaleByCountry()).get(country.toUpperCase())

	if (!rowLocale) {
		return {
			why:
				`no weights overlay ships for ${country.toUpperCase()} (the release manifest's locales are the set), so ` +
				"a flip would name a package that does not exist",
		}
	}

	const to = rowLocale.toLowerCase() === current.toLowerCase() ? BASE_LOCALE : rowLocale

	if (to.toLowerCase() === current.toLowerCase()) {
		return {
			why: `${current} is already both the base and this row's country overlay, so the setting has nowhere to move`,
		}
	}

	return { setting: "locale", from: current, to, patch: { locale: to } }
}

/**
 * Row and baseline answer used for counterfactual measurement.
 */
export interface CounterfactualTarget {
	id: string
	input: string
	country?: string | undefined
	base: CounterfactualAnswer
}

export interface CounterfactualAnswer {
	lat: number | null
	lon: number | null
	tier: string
}

/**
 * Flip that moved coordinates beyond the threshold or changed abstention.
 */
interface CounterfactualMove extends MoveReading {
	setting: CounterfactualSetting
	from: string
	to: string
}

/**
 * Movement between two answers, independent of the changed setting.
 */
export interface MoveReading {
	moved_km: number | null
	changed_abstention: boolean
	answer: CounterfactualAnswer
}

export interface RowCounterfactuals {
	settings_tried: CounterfactualSetting[]
	settings_skipped: SettingSkip[]
	n_flips_run: number
	n_flips_moved: number
	moves: CounterfactualMove[]
}

/**
 * Return a movement record when answers differ enough to affect grading.
 */
export function measureMove(base: CounterfactualAnswer, flipped: CounterfactualAnswer): MoveReading | null {
	const baseAbstained = base.lat === null || base.lon === null
	const flippedAbstained = flipped.lat === null || flipped.lon === null
	const changedAbstention = baseAbstained !== flippedAbstained

	const movedKm =
		baseAbstained || flippedAbstained ? null : haversineKm(base.lat!, base.lon!, flipped.lat!, flipped.lon!)

	if (!changedAbstention && !(movedKm !== null && movedKm > COUNTERFACTUAL_MOVED_KM)) return null

	return { moved_km: movedKm, changed_abstention: changedAbstention, answer: flipped }
}

export interface CounterfactualError {
	id: string
	setting: CounterfactualSetting
	message: string
}

/**
 * Run applicable flips and report those that change an answer.
 */
export async function runCounterfactuals(
	registry: EngineRegistryLike,
	baseConfig: EngineConfig,
	effective: GeocodeSessionOptions,
	targets: CounterfactualTarget[]
): Promise<{ byRow: Map<string, RowCounterfactuals>; errors: CounterfactualError[] }> {
	const byRow = new Map<string, RowCounterfactuals>()
	const errors: CounterfactualError[] = []
	// Keyed by the patch itself, so two rows whose locale flip lands on the same overlay share one engine build.
	const batches = new Map<string, { flip: CounterfactualFlip; targets: CounterfactualTarget[] }>()

	for (const target of targets) {
		const { flips, skipped } = await enumerateFlips(effective, target.country)

		byRow.set(target.id, {
			settings_tried: flips.map((flip) => flip.setting),
			settings_skipped: skipped,
			n_flips_run: 0,
			n_flips_moved: 0,
			moves: [],
		})

		for (const flip of flips) {
			const key = `${flip.setting}\0${stringifyJSON(flip.patch)}`
			const batch = batches.get(key)

			if (batch) {
				batch.targets.push(target)
			} else {
				batches.set(key, { flip, targets: [target] })
			}
		}
	}

	for (const { flip, targets: batched } of batches.values()) {
		// Disable tracing because this pass compares answers only.
		const engine = await registry.acquire({ ...baseConfig, ...flip.patch, trace: false })

		for (const target of batched) {
			const row = byRow.get(target.id)!

			try {
				const run = await engine.session.geocode(target.input)

				const flipped: CounterfactualAnswer = {
					lat: run.result.lat,
					lon: run.result.lon,
					tier: run.result.resolution_tier,
				}

				row.n_flips_run++

				const move = measureMove(target.base, flipped)

				if (move) {
					row.n_flips_moved++
					row.moves.push({ ...move, setting: flip.setting, from: flip.from, to: flip.to })
				}
			} catch (error) {
				errors.push({ id: target.id, setting: flip.setting, message: (error as Error).message })
			}
		}
	}

	return { byRow, errors }
}
