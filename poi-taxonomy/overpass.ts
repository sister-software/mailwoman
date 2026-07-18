/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   OverpassQL EXPORT emitter over a POI intent (spec §1: "we print the query; we never run it").
 *   Overpass is not a serving backend — this exists so users who live in Overpass-turbo can take
 *   a mailwoman intent there. The category→OSM-tag mapping is the caller's input (from
 *   `@mailwoman/poi-taxonomy`'s `osmTag`); the emitter is a pure string builder.
 *
 *   Re-homed from `mailwoman/poi-overpass.ts` (Task 8, pre-declared plan deviation): this package
 *   must not depend on `@mailwoman/core`, so `OverpassIntentLike` below is a local structural type
 *   covering exactly what the emitter reads. `POIIntent` (`@mailwoman/core/pipeline`) is structurally
 *   assignable to it — callers pass a real `POIIntent` without a cast. `mailwoman/poi-overpass.ts` is
 *   now a thin re-export of this module, kept for backward compatibility.
 *
 *   Two escaping contexts: the category branch and the `area["name"="…"]` anchor scope are string
 *   EQUALITY, so `escapeQL` alone is correct. The brand/name branches interpolate into a `~"…"`
 *   REGEX context, so they need `escapeQLRegex` to neutralize regex metacharacters first.
 */

/**
 * Minimal structural shape the emitter reads off a POI intent. `@mailwoman/core/pipeline`'s `POIIntent` satisfies this
 * — no cast needed at call sites — but this package doesn't depend on core to define it.
 */
export interface OverpassIntentLike {
	subject:
		| { kind: "category"; categoryID: string; matched: string }
		| { kind: "brand"; name: string; wikidata?: string; matched: string }
		| { kind: "name"; text: string }
	/** Spatial anchor: the split-off remainder text and its parse, when the query carried one. */
	anchor?: {
		text?: string
		tree?: { roots: ReadonlyArray<{ tag: string; value: string }> }
		/** Caller-supplied bias point ("near me"); executors treat it as the anchor when no tree resolved. */
		biasPoint?: { latitude: number; longitude: number }
		radiusM?: number
	}
	limit?: number
}

/** Escape a value for an OverpassQL double-quoted string. */
function escapeQL(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
}

/** Escape regex metacharacters — the `~` operator's value is a regex, not a literal. */
function escapeQLRegex(value: string): string {
	return escapeQL(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
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
export function emitOverpassQL(intent: OverpassIntentLike, opts: EmitOverpassOpts = {}): string {
	let filter: string

	switch (intent.subject.kind) {
		case "category": {
			if (!opts.osmTag) {
				throw new Error(`emitOverpassQL: category subject ${intent.subject.categoryID} requires opts.osmTag`)
			}
			const parts = opts.osmTag.split("=")

			if (parts.length !== 2 || !parts[0] || !parts[1]) {
				throw new Error(`emitOverpassQL: malformed osmTag ${JSON.stringify(opts.osmTag)} — expected key=value`)
			}
			filter = `nwr["${escapeQL(parts[0])}"="${escapeQL(parts[1])}"]`
			break
		}
		case "brand":
			filter = `nwr["name"~"${escapeQLRegex(intent.subject.name)}",i]`
			break
		case "name":
			filter = `nwr["name"~"${escapeQLRegex(intent.subject.text)}",i]`
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
