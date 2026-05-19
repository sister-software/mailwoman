/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import {
	Alpha2LanguageCode,
	Alpha3bLanguageCode,
	Alpha3bToAlpha2,
	isAlpha2LanguageCode,
	isAlpha3bLanguageCode,
} from "@mailwoman/core/resources/languages"
import type { Feature, Geometry } from "geojson"
import { WhosOnFirstPlacetype } from "./definition.js"

export interface WOFBaseProperties {
	"wof:id": number
	"wof:name": string
	"wof:src": string
	"src:geom": string
	"wof:placetype": WhosOnFirstPlacetype
	"wof:parent_id": number
	"wof:superseded_by"?: number[]
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

	return {
		id,
		name,
		src,
		parent_id,
		placetype,
		localizedPropMap,
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
