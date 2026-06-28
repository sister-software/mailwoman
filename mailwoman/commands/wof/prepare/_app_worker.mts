/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Piscina worker for WOF prepare — reads GeoJSON files, extracts structured fields via
 *   pluckPlacetypeSpec, and returns parsed data to the main thread. The main thread handles all
 *   SQLite writes (both mini-DBs and unified DB) to avoid concurrent writer locks.
 *
 *   Per the WAL + Freeze design brief (docs/articles/reviews/2026-05-28-sqlite-wal-strategy.md):
 *   "Workers return parsed data to a single main-thread writer."
 */

import { readFileSync } from "node:fs"

import { pluckPlacetypeSpec, type WOFFeature } from "@mailwoman/core/resources/whosonfirst"

const ADMIN_PLACETYPES = new Set([
	"country",
	"region",
	"county",
	"locality",
	"localadmin",
	"borough",
	"neighbourhood",
	"macroregion",
	"macrocounty",
])

export interface WorkerInput {
	filePaths: string[]
}

export interface ParsedPlace {
	id: number
	parent_id: number
	name: string
	placetype: string
	country: string
	latitude: number
	longitude: number
	population: number
	isCurrent: number
	isDeprecated: number
	isCeased: number
	isSuperseded: number
	isSuperseding: number
	lastmodified: number
	concordances: Record<string, string>
	names: Array<{
		language: string
		preferred: string | null
		variant: string | null
		colloquial: string | null
		abbr: string | null
		short: string | null
	}>
	src: string
}

export interface WorkerOutput {
	places: ParsedPlace[]
	skipped: number
}

async function processFiles(input: WorkerInput): Promise<WorkerOutput> {
	const places: ParsedPlace[] = []
	let skipped = 0

	for (const filePath of input.filePaths) {
		if (filePath.includes("-alt-")) {
			skipped++
			continue
		}

		let fileContent: string

		try {
			fileContent = readFileSync(filePath, "utf8")
		} catch {
			skipped++
			continue
		}

		let feature: WOFFeature

		try {
			feature = JSON.parse(fileContent)
		} catch {
			skipped++
			continue
		}

		const superseded_by = feature.properties["wof:superseded_by"]

		if (superseded_by && superseded_by.length !== 0) {
			skipped++
			continue
		}

		const { localizedPropMap, placetype, ...props } = pluckPlacetypeSpec(feature.properties)

		if (!ADMIN_PLACETYPES.has(placetype)) {
			skipped++
			continue
		}

		const names: ParsedPlace["names"] = []

		for (const [languageCode, nameKindMap] of localizedPropMap) {
			names.push({
				language: languageCode,
				preferred: nameKindMap.get("preferred") ?? null,
				variant: nameKindMap.get("variant") ?? null,
				colloquial: nameKindMap.get("colloquial") ?? null,
				abbr: nameKindMap.get("abbr") ?? null,
				short: nameKindMap.get("short") ?? null,
			})
		}

		const concordances: Record<string, string> = {}

		if (props.concordances) {
			for (const [source, value] of Object.entries(props.concordances)) {
				concordances[source] = String(value)
			}
		}

		places.push({
			id: props.id,
			parent_id: props.parent_id,
			name: props.name,
			placetype,
			country: props.country ?? "",
			latitude: props.latitude ?? 0,
			longitude: props.longitude ?? 0,
			population: props.population ?? 0,
			isCurrent: props.isCurrent === false ? 0 : 1,
			isDeprecated: props.isDeprecated ? 1 : 0,
			isCeased: props.isCeased ? 1 : 0,
			isSuperseded: props.isSuperseded ? 1 : 0,
			isSuperseding: props.isSuperseding ? 1 : 0,
			lastmodified: props.lastmodified ?? 0,
			concordances,
			names,
			src: props.src,
		})
	}

	return { places, skipped }
}

export default processFiles
