/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The `wikidata-vital-places` training rows: each inventory place rendered as `venue` rows, with an entity-grouped
 * holdout.
 *
 * A settlement or administrative area is left to Who's On First, since its rows already teach the name. Every other place
 * becomes rows of three forms: each language's label bare, the label followed by the country's name in that language
 * for the languages written with a comma separator, and the first English alias bare.
 *
 * The holdout is chosen by a hash of the QID, so every form and language of a held-out place stays out of training.
 */

import { createHash } from "node:crypto"

import { SourceRegister } from "#registers"
import {
	type ClassRoots,
	SETTLEMENT_ROOTS,
	SITE_ROOTS,
} from "#tools/fetch/wikidata/vital-places/classify"
import type { VitalPlace } from "#tools/fetch/wikidata/vital-places/inventory"

/**
 * The `source` written on every row.
 */
export const VITAL_PLACES_SOURCE = "wikidata-vital-places"

/**
 * The languages whose `<label>, <country>` form is rendered: those written with a comma between the two.
 */
export const COMMA_SEPARATED_LANGUAGES: readonly string[] = ["en", "fr", "es", "de", "it", "pt", "ru"]

/**
 * One entity in 50 goes to the holdout.
 */
export const HOLDOUT_MODULUS = 50

/**
 * The longest label rendered, in UTF-16 code units.
 */
const MAX_LABEL_LENGTH = 80

/**
 * What the render does with one place.
 */
export const VITAL_PLACE_RENDERINGS = {
	/**
	 * The place renders as `venue` rows.
	 */
	venue: "venue",
	/**
	 * The place is a settlement or administrative area, left to Who's On First.
	 */
	settlement: "settlement",
	/**
	 * No country of the place states an ISO 3166-1 code, so a row would have no `country` value.
	 */
	noCountry: "no-country",
} as const

export type VitalPlaceRendering = (typeof VITAL_PLACE_RENDERINGS)[keyof typeof VITAL_PLACE_RENDERINGS]

/**
 * Whether a place renders as venues.
 *
 * A place under a settlement root is left to Who's On First unless a class is also under a site root and the place
 * states no population. Wikidata's class tree puts observation tower, national park and ancient city under settlement
 * or administrative roots. The site exception keeps the Eiffel Tower and Machu Picchu as venues.
 * A capital whose old town is a World Heritage site states a population and stays a locality.
 */
export function vitalPlaceRendering(
	place: Pick<VitalPlace, "classes" | "population" | "countryCodes">,
	roots: Readonly<ClassRoots>
): VitalPlaceRendering {
	const placeRoots = new Set(place.classes.flatMap((cls) => roots[cls] ?? []))
	const settlement = SETTLEMENT_ROOTS.some((root) => placeRoots.has(root))
	const site = SITE_ROOTS.some((root) => placeRoots.has(root))

	if (settlement && (!site || place.population != null)) return VITAL_PLACE_RENDERINGS.settlement

	if (!vitalPlaceCountry(place)) return VITAL_PLACE_RENDERINGS.noCountry

	return VITAL_PLACE_RENDERINGS.venue
}

/**
 * The first ISO 3166-1 alpha-2 code among the place's countries, `null` when none states one.
 */
export function vitalPlaceCountry(place: Pick<VitalPlace, "countryCodes">): string | null {
	return place.countryCodes.find((code) => /^[A-Z]{2}$/u.test(code)) ?? null
}

/**
 * One rendered form of a place.
 */
export interface VitalPlaceForm {
	/**
	 * The form's suffix of the row's `source_id`: `<language>-bare`, `<language>-country` or `en-alias-bare`.
	 */
	id: string
	raw: string
	components: Record<string, string>
}

/**
 * Whether a name renders: two to {@linkcode MAX_LABEL_LENGTH} code units with no comma, semicolon or parenthesis,
 * since each of those would read as a component boundary inside the venue.
 */
function isRenderableName(name: string | undefined): name is string {
	return typeof name === "string" && name.length >= 2 && name.length <= MAX_LABEL_LENGTH && !/[,;()]/u.test(name)
}

/**
 * The forms of one place, labels in the inventory's language order, with each distinct bare surface rendered once.
 *
 * @param countryName The name of an ISO 3166-1 code in a language, `undefined` when the language has none.
 */
export function renderVitalPlaceForms(
	place: Pick<VitalPlace, "labels" | "aliases">,
	countryCode: string,
	countryName: (code: string, language: string) => string | undefined
): VitalPlaceForm[] {
	const forms: VitalPlaceForm[] = []
	const bare = new Set<string>()

	for (const [language, label] of Object.entries(place.labels)) {
		if (!isRenderableName(label)) continue

		if (!bare.has(label)) {
			bare.add(label)
			forms.push({ id: `${language}-bare`, raw: label, components: { venue: label } })
		}

		const country = COMMA_SEPARATED_LANGUAGES.includes(language) ? countryName(countryCode, language) : undefined

		if (isRenderableName(country)) {
			forms.push({ id: `${language}-country`, raw: `${label}, ${country}`, components: { venue: label, country } })
		}
	}

	const alias = place.aliases["en"]?.find((name) => isRenderableName(name) && !bare.has(name))

	if (alias) {
		forms.push({ id: "en-alias-bare", raw: alias, components: { venue: alias } })
	}

	return forms
}

/**
 * A country name from `Intl.DisplayNames`, which covers every ISO 3166-1 code in every language the runtime ships.
 *
 * A code the runtime has no name for comes back as the code itself. This function returns `undefined` for it.
 */
export function createDisplayCountryName(): (code: string, language: string) => string | undefined {
	const byLanguage = new Map<string, Intl.DisplayNames>()

	return (code, language) => {
		let names = byLanguage.get(language)

		if (!names) {
			names = new Intl.DisplayNames([language], { type: "region" })
			byLanguage.set(language, names)
		}

		const name = names.of(code)

		return name && name !== code ? name : undefined
	}
}

/**
 * Whether an entity goes to the holdout: one in {@linkcode HOLDOUT_MODULUS} by the first four bytes of the QID's
 * SHA-256, unless the entity is exempt.
 */
export function holdsOutVitalPlace(qid: string, exempt: ReadonlySet<string> = new Set()): boolean {
	return !exempt.has(qid) && createHash("sha256").update(qid).digest().readUInt32BE(0) % HOLDOUT_MODULUS === 0
}

/**
 * One rendered row before alignment.
 */
export interface VitalPlaceRow {
	raw: string
	components: Record<string, string>
	country: string
	source: typeof VITAL_PLACES_SOURCE
	source_id: string
	register: typeof SourceRegister.Wikidata
	qid: string
}

/**
 * The rows and holdout of a whole inventory, with the count of places each rendering took.
 */
export interface VitalPlacesRender {
	rows: VitalPlaceRow[]
	holdout: VitalPlaceRow[]
	counts: Record<VitalPlaceRendering, number> & { heldOutEntities: number; trainedEntities: number }
}

/**
 * Render every place of the inventory.
 *
 * @param exempt QIDs that always train, such as the famous-places test set's entities.
 */
export function renderVitalPlaces(
	places: Iterable<VitalPlace>,
	roots: Readonly<ClassRoots>,
	exempt: ReadonlySet<string> = new Set(),
	countryName = createDisplayCountryName()
): VitalPlacesRender {
	const result: VitalPlacesRender = {
		rows: [],
		holdout: [],
		counts: { venue: 0, settlement: 0, "no-country": 0, heldOutEntities: 0, trainedEntities: 0 },
	}

	for (const place of places) {
		const rendering = vitalPlaceRendering(place, roots)

		result.counts[rendering]++

		if (rendering !== VITAL_PLACE_RENDERINGS.venue) continue

		const country = vitalPlaceCountry(place)!
		const forms = renderVitalPlaceForms(place, country, countryName)

		if (!forms.length) continue

		const heldOut = holdsOutVitalPlace(place.qid, exempt)
		const target = heldOut ? result.holdout : result.rows

		if (heldOut) {
			result.counts.heldOutEntities++
		} else {
			result.counts.trainedEntities++
		}

		for (const form of forms) {
			target.push({
				raw: form.raw,
				components: form.components,
				country,
				source: VITAL_PLACES_SOURCE,
				source_id: `${VITAL_PLACES_SOURCE}-${place.qid}-${form.id}`,
				register: SourceRegister.Wikidata,
				qid: place.qid,
			})
		}
	}

	return result
}
