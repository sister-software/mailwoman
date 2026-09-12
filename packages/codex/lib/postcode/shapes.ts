/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode SHAPE patterns — which substrings of a line LOOK like a postcode, ordered most-specific
 *   to least. Priority IS the index: a lower index wins an overlap.
 *
 *   The DATA lives in `./shapes.json` so non-TS consumers read the identical record, the
 *   same arrangement `us/street-suffix.json` has. Two runtimes need this table and both used to
 *   carry their own typed copy: `@mailwoman/neural`'s postcode repair, and the Python trainer's
 *   `features/postcode_shapes.py`, which paints the train-side anchor on the spans inference paints.
 *   Hand-mirrored, they drifted twice — the IE Eircode row was TS-only for a month, the BR CEP row
 *   for five weeks — and each time the trainer painted one fewer shape than inference, silently.
 *
 *   This is a SHAPE test, not a gazetteer-membership test. A bare `68161` matches the US, German,
 *   French, Spanish and Italian 5-digit shapes; `./systems.ts` answers the membership
 *   question, and neither module reads the other.
 *
 *   REGEX DIALECT. The bodies are written in the subset both JavaScript `RegExp` and Python `re`
 *   accept, which is what lets one file serve both. A row needing different source text in the two
 *   dialects needs a second field and a stated reason, not a loosened comparison on either side.
 */

import postcodeShapeData from "./shapes.json" with { type: "json" }

/**
 * What a match is eligible to do. `designated` may overwrite any existing label, `alnum` may add a postcode where the
 * model emitted none, and `numeric` may only snap an existing one — so a numeric shape can never invent a postcode over
 * a hyphenated house number.
 */
export type PostcodeShapeKind = "alnum" | "numeric" | "designated"

/**
 * One shape: the label it reports, what it is eligible to do, and the compiled pattern.
 */
export interface PostcodeShape {
	readonly label: string
	readonly kind: PostcodeShapeKind
	readonly re: RegExp
}

/**
 * Every postcode shape, in priority order. Compiled once at module load; each `RegExp` carries the `g` flag because
 * callers scan a whole line, and `u` as well where the row declares it.
 */
export const POSTCODE_SHAPES: readonly PostcodeShape[] = postcodeShapeData.shapes.map((shape) => ({
	label: shape.label,
	kind: shape.kind as PostcodeShapeKind,
	re: new RegExp(shape.pattern, "unicode" in shape && shape.unicode ? "gu" : "g"),
}))

/**
 * The record's own version string, so a consumer that vendors a copy can say which revision it holds.
 */
export const POSTCODE_SHAPES_VERSION: string = postcodeShapeData.version
