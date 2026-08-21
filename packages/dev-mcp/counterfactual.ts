/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The smallest single-lever flip that changes a row's answer (#1722).
 *
 *   An account says what the pipeline DID. A counterfactual says what it would have done under one different setting,
 *   which is the only way to turn "this mechanism ran" into "this mechanism decided" — the L2 rung the activation
 *   census deliberately does not measure. One lever moves per flip, always, because a flip that moves two levers
 *   cannot attribute the change to either.
 *
 *   The lever space is FIXED and enumerated here rather than derived from `EngineConfig`. Every lever in that
 *   interface is flippable in principle; these five are the ones whose flip is cheap (no second gazetteer, no second
 *   model) and whose meaning is stateable in one sentence. A lever that cannot apply to a row is reported as SKIPPED
 *   with its reason, never omitted — an absent lever and a lever that changed nothing are different facts.
 *
 *   Runs are ENGINE-MAJOR: every row needing one flip is measured before the next flip's engine is built. The
 *   registry holds two engines at a time (`EngineRegistry`'s cap, set by the measured throughput ceiling on a shared
 *   WOF SQLite), so a row-major loop would evict and rebuild a multi-second engine on nearly every iteration.
 */

import { readFileSync } from "node:fs"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/utils"
import { haversineKm } from "@mailwoman/spatial"
import type { GeocodeSessionOptions } from "mailwoman/geocode-session"

import type { EngineConfig, EngineRegistry } from "./engine-registry.ts"
import { DISTANCE_THRESHOLDS_KM } from "./geo-grade.ts"

/**
 * The fixed lever space, in the CLI's own vocabulary — the same keys `EngineConfig` uses, so a flip a reader wants to
 * reproduce is a `config` they can paste into any other tool.
 */
export const COUNTERFACTUAL_LEVERS = ["locale", "gazetteer_prior", "country_scope", "fork_entity"] as const

export type CounterfactualLever = (typeof COUNTERFACTUAL_LEVERS)[number]

/**
 * How far an answer must move before the flip is reported, in kilometres.
 *
 * The finest of the pre-registered distance thresholds, borrowed rather than chosen: a flip that moves the answer less
 * than the tightest threshold anything here grades at cannot change a verdict, so reporting it would fill the result
 * with coordinate jitter. A flip that changes ABSTENTION is reported at any distance — there is no distance to measure,
 * which is the point.
 */
export const COUNTERFACTUAL_MOVED_KM = DISTANCE_THRESHOLDS_KM[0]

/**
 * The self-contained base weights locale. Every other `@mailwoman/neural-weights-*` package is a data overlay sharing
 * this one's `model.onnx` byte-for-byte, so it is the locale a flip returns TO when the row is already running under
 * its own overlay.
 */
export const BASE_LOCALE = "en-US"

/**
 * Repo-relative home of the release manifest, whose `locales` array is the list of weights overlays that exist. Read
 * rather than re-typed: an overlay added by `scripts/scaffold-weights-overlay.ts` lands there, and a hand-kept copy
 * here would make the locale lever silently stop offering the newest locale.
 */
const RELEASE_CONFIG_RELATIVE_PATH = "release.config.json"

interface ReleaseLocales {
	locales?: string[]
}

let overlayLocaleCache: Map<string, string> | null = null

/**
 * Country (ISO alpha-2, upper) → the canonical locale tag of the weights overlay that scopes it.
 *
 * Derived from each overlay's own REGION SUBTAG, which is what makes this a derivation rather than a second table:
 * `en-gb` scopes GB because that is what the tag says. A country with two overlays would keep the first listed; none
 * exists today, and the manifest is the place that would have to decide.
 */
function overlayLocaleByCountry(): Map<string, string> {
	if (overlayLocaleCache) return overlayLocaleCache

	const manifest = parseJSONStrict<ReleaseLocales>(
		readFileSync(String(repoRootPath(RELEASE_CONFIG_RELATIVE_PATH)), "utf8")
	)

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
 * One flip: which lever, what it moved from, what it moved to, and the config patch that expresses it.
 */
export interface CounterfactualFlip {
	lever: CounterfactualLever
	from: string
	to: string
	patch: EngineConfig
}

/**
 * A lever that could not be flipped for this row, and why. Reported so an empty flip list is readable: no lever
 * applied, or every lever applied and none moved the answer.
 */
export interface LeverSkip {
	lever: CounterfactualLever
	why: string
}

/**
 * The single-lever flips available for one row.
 *
 * `effective` is the RESOLVED session options — the production defaults already filled in — because the flip has to be
 * stated against what the engine will actually do, not against what the caller happened to type. An unset lever in a
 * caller's `EngineConfig` means the production default, so reading the caller's object would report every unset lever
 * as absent and flip it in the wrong direction.
 */
export function enumerateFlips(
	effective: GeocodeSessionOptions,
	country: string | undefined
): { flips: CounterfactualFlip[]; skipped: LeverSkip[] } {
	const flips: CounterfactualFlip[] = []
	const skipped: LeverSkip[] = []

	const localeFlip = localeCounterfactual(effective.locale, country)

	if ("why" in localeFlip) {
		skipped.push({ lever: "locale", why: localeFlip.why })
	} else {
		flips.push(localeFlip)
	}

	flips.push({
		lever: "gazetteer_prior",
		from: String(effective.gazetteerPrior),
		to: String(!effective.gazetteerPrior),
		patch: { gazetteer_prior: !effective.gazetteerPrior },
	})

	const scopeTo = effective.countryScope === "none" ? "auto" : "none"

	flips.push({
		lever: "country_scope",
		from: effective.countryScope,
		to: scopeTo,
		patch: { country_scope: scopeTo },
	})

	flips.push({
		lever: "fork_entity",
		from: String(effective.forkEntity),
		to: String(!effective.forkEntity),
		patch: { fork_entity: !effective.forkEntity },
	})

	return { flips, skipped }
}

/**
 * The locale flip, or the reason there is none.
 *
 * Two directions, never one: a row running under the base weights flips TO its country's overlay, and a row already
 * running under its country's overlay flips BACK to the base. The second direction is what prices the overlay — "the
 * overlay is load-bearing here" is a claim only its removal can support.
 */
function localeCounterfactual(current: string, country: string | undefined): CounterfactualFlip | { why: string } {
	if (!country) {
		return { why: "the input set carries no country for this row, so there is no row locale to flip to" }
	}

	const rowLocale = overlayLocaleByCountry().get(country.toUpperCase())

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
			why: `${current} is already both the base and this row's country overlay, so the lever has nowhere to move`,
		}
	}

	return { lever: "locale", from: current, to, patch: { locale: to } }
}

/**
 * One row as the counterfactual pass reads it: what to re-run, and the answer to measure the flip against.
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
 * A flip that MOVED the answer. Flips that changed nothing are counted, never listed — the list is the finding.
 *
 * `moved_km` is `null` when one side has no coordinate: an abstention has no distance from anything, and turning that
 * into a number (zero, or infinity) is the projection this whole surface exists to avoid. `changed_abstention` is the
 * fact in that case.
 */
interface CounterfactualMove extends MoveReading {
	lever: CounterfactualLever
	from: string
	to: string
}

/**
 * The distance half of a move, with no lever attached — what {@link measureMove} can know from two answers alone.
 */
export interface MoveReading {
	moved_km: number | null
	changed_abstention: boolean
	answer: CounterfactualAnswer
}

export interface RowCounterfactuals {
	levers_tried: CounterfactualLever[]
	levers_skipped: LeverSkip[]
	n_flips_run: number
	n_flips_moved: number
	moves: CounterfactualMove[]
}

/**
 * Whether one flip's answer counts as a move, and how far.
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
	lever: CounterfactualLever
	message: string
}

/**
 * Re-run every applicable flip and report the ones that moved the answer.
 */
export async function runCounterfactuals(
	registry: EngineRegistry,
	baseConfig: EngineConfig,
	effective: GeocodeSessionOptions,
	targets: CounterfactualTarget[]
): Promise<{ byRow: Map<string, RowCounterfactuals>; errors: CounterfactualError[] }> {
	const byRow = new Map<string, RowCounterfactuals>()
	const errors: CounterfactualError[] = []
	// Keyed by the patch itself, so two rows whose locale flip lands on the same overlay share one engine build.
	const batches = new Map<string, { flip: CounterfactualFlip; targets: CounterfactualTarget[] }>()

	for (const target of targets) {
		const { flips, skipped } = enumerateFlips(effective, target.country)

		byRow.set(target.id, {
			levers_tried: flips.map((flip) => flip.lever),
			levers_skipped: skipped,
			n_flips_run: 0,
			n_flips_moved: 0,
			moves: [],
		})

		for (const flip of flips) {
			const key = `${flip.lever} ${JSON.stringify(flip.patch)}`
			const batch = batches.get(key)

			if (batch) {
				batch.targets.push(target)
			} else {
				batches.set(key, { flip, targets: [target] })
			}
		}
	}

	for (const { flip, targets: batched } of batches.values()) {
		// Tracing stays OFF on a flip arm: the flip is graded on its ANSWER, and a traced session pays an extra
		// decode per input for evidence nothing here reads.
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
					row.moves.push({ ...move, lever: flip.lever, from: flip.from, to: flip.to })
				}
			} catch (error) {
				errors.push({ id: target.id, lever: flip.lever, message: (error as Error).message })
			}
		}
	}

	return { byRow, errors }
}
