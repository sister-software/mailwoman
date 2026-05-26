/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	Alpha2LanguageCode,
	type Alpha3bLanguageCode,
	Alpha3bToAlpha2,
	isAlpha2LanguageCode,
	isAlpha3bLanguageCode,
} from "@mailwoman/core/resources/languages"
import type { Feature, Geometry } from "geojson"
import type { WhosOnFirstPlacetype } from "./definition.js"

export interface WOFBaseProperties {
	"wof:id": number
	"wof:name": string
	"wof:src": string
	"src:geom": string
	"wof:placetype": WhosOnFirstPlacetype
	"wof:parent_id": number
	"wof:superseded_by"?: number[]
	"wof:supersedes"?: number[]
	"wof:country"?: string
	"wof:concordances"?: Record<string, string | number>
	"wof:population"?: number
	"wof:lastmodified"?: number
	"geom:latitude"?: number
	"geom:longitude"?: number
	"gn:population"?: number
	"mz:is_current"?: number | string
	"edtf:deprecated"?: string
	"edtf:cessation"?: string
}

export const WOFNameKinds = ["preferred", "variant", "colloquial", "abbr", "short"] as const
export type WOFNameKind = (typeof WOFNameKinds)[number]
export type LanguageSpecificKey = `name:${Alpha3bLanguageCode}_x_${WOFNameKind}`

export type WOFLanguageProperties = {
	[key in LanguageSpecificKey]?: string | string[]
}

export type WOFProperties = WOFBaseProperties & WOFLanguageProperties

export type WOFFeature = Feature<Geometry, WOFProperties>

type LocalizedPlacetypePropMap = Map<WOFNameKind, string>

export interface ParsedWOFPlacetype {
	id: number
	parent_id: number
	name: string
	src: string
	placetype: WhosOnFirstPlacetype
	localizedPropMap: Map<Alpha3bLanguageCode, LocalizedPlacetypePropMap>
	country?: string
	latitude?: number
	longitude?: number
	population?: number
	concordances?: Record<string, string | number>
	isCurrent?: boolean
	isDeprecated?: boolean
	isCeased?: boolean
	isSuperseded?: boolean
	isSuperseding?: boolean
	lastmodified?: number
}

const langPattern = new RegExp(`:([a-z0-9\\-_]{2,3})_x_(${WOFNameKinds.join("|")})`)

export function parsePlacetypeSource(key: string) {
	const [, languageCode, nameKind] = (langPattern.exec(key as string) ?? []) as Partial<
		[string, Alpha3bLanguageCode, WOFNameKind]
	>

	return { languageCode, nameKind }
}

export function pluckPlacetypeSpec({
	"wof:id": id,
	"wof:name": name,
	"wof:src": wof_src,
	"src:geom": geom_src,
	"wof:parent_id": parent_id,
	"wof:placetype": placetype,
	"wof:superseded_by": superseded_by,
	"wof:supersedes": supersedes,
	"wof:country": country,
	"wof:concordances": concordances,
	"wof:population": wofPopulation,
	"wof:lastmodified": lastmodified,
	"geom:latitude": latitude,
	"geom:longitude": longitude,
	"gn:population": gnPopulation,
	"mz:is_current": mzIsCurrent,
	"edtf:deprecated": edtfDeprecated,
	"edtf:cessation": edtfCessation,
	...props
}: WOFProperties): ParsedWOFPlacetype {
	const localizedPropMap = new Map<Alpha3bLanguageCode, LocalizedPlacetypePropMap>()

	for (const [key, value] of Object.entries(props)) {
		if (!value) continue
		if (!value || typeof value === "number") continue

		const { languageCode, nameKind } = parsePlacetypeSource(key)

		if (!languageCode || !nameKind) continue

		let langMap = localizedPropMap.get(languageCode)

		if (!langMap) {
			langMap = new Map()
			localizedPropMap.set(languageCode, langMap)
		}

		const firstValue = Array.isArray(value) ? value[0] : value

		if (firstValue) {
			langMap.set(nameKind, firstValue)
		}
	}

	const src = wof_src || geom_src || "unknown"

	if (!src) throw new Error(`No source found for placetype ${placetype} with ID ${id}`)

	const population =
		typeof wofPopulation === "number" ? wofPopulation : typeof gnPopulation === "number" ? gnPopulation : undefined
	const isCurrent = mzIsCurrent === undefined ? undefined : mzIsCurrent !== 0 && mzIsCurrent !== "0"

	return {
		id,
		name,
		src,
		parent_id,
		placetype,
		localizedPropMap,
		country: country || undefined,
		latitude: typeof latitude === "number" ? latitude : undefined,
		longitude: typeof longitude === "number" ? longitude : undefined,
		population,
		concordances: concordances && Object.keys(concordances).length > 0 ? concordances : undefined,
		isCurrent,
		isDeprecated: !!edtfDeprecated,
		isCeased: !!edtfCessation,
		isSuperseded: !!(superseded_by && superseded_by.length > 0),
		isSuperseding: !!(supersedes && supersedes.length > 0),
		lastmodified: typeof lastmodified === "number" ? lastmodified : undefined,
	}
}

/**
 * Given a WhosOnFirst filename, plucks and normalizes the language code into an ISO 639-1 alpha-2
 * code.
 *
 * @deprecated
 */
export function pluckFileNameLanguageCode(filename: string): Alpha2LanguageCode | null {
	const [, languageCode] = filename.match(/name:([a-z]{2,3})_\w+\.txt/) || []

	if (!languageCode) return null

	if (isAlpha2LanguageCode(languageCode)) return languageCode
	if (isAlpha3bLanguageCode(languageCode)) return Alpha3bToAlpha2.get(languageCode) ?? null

	return null
}
