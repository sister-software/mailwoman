/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OverpassQL EXPORT emitter over `POIIntent` (spec §1: "we print the query; we never run it").
 *   Overpass is not a serving backend — this exists so users who live in Overpass-turbo can take
 *   a mailwoman intent there. The category→OSM-tag mapping is the caller's input (from
 *   `@mailwoman/poi-taxonomy`'s `osmTag`); the emitter is a pure string builder.
 */

import type { POIIntent } from "@mailwoman/core/pipeline"

/** Escape a value for an OverpassQL double-quoted string. */
function escapeQL(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

export interface EmitOverpassOpts {
	/** `key=value` OSM tag for category subjects (from `CategoryRecord.osmTag`). */
	osmTag?: string
	/** Radius for around-filters when the anchor is a bias point (future); default 10000. */
	radiusM?: number
}

/**
 * Render an OverpassQL query for the intent. Category subjects need `opts.osmTag`; name/brand subjects render a
 * case-insensitive name regex. A resolved anchor locality becomes an area scope; otherwise the query is global
 * (Overpass-turbo users add their own bbox).
 */
export function emitOverpassQL(intent: POIIntent, opts: EmitOverpassOpts = {}): string {
	let filter: string

	switch (intent.subject.kind) {
		case "category": {
			if (!opts.osmTag) {
				throw new Error(`emitOverpassQL: category subject ${intent.subject.categoryID} requires opts.osmTag`)
			}
			const [key, value] = opts.osmTag.split("=")
			filter = `nwr["${escapeQL(key ?? "")}"="${escapeQL(value ?? "")}"]`
			break
		}
		case "brand":
			filter = `nwr["name"~"${escapeQL(intent.subject.name)}",i]`
			break
		case "name":
			filter = `nwr["name"~"${escapeQL(intent.subject.text)}",i]`
			break
	}

	const locality = intent.anchor?.tree?.roots.find((r) => r.tag === "locality")?.value

	if (locality) {
		return [
			"[out:json][timeout:25];",
			`area["name"="${escapeQL(locality)}"]->.anchor;`,
			`${filter}(area.anchor);`,
			"out center;",
		].join("\n")
	}

	return ["[out:json][timeout:25];", `${filter};`, "out center;"].join("\n")
}
