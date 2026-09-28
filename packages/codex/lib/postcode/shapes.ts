/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode shape patterns identify substrings of a line that look like a postcode.
 *   Patterns appear from most-specific to least-specific. A lower index wins when patterns overlap.
 *
 *   The data lives in `./shapes.json` so non-TypeScript consumers read the same records as
 *   `us/street-suffix.json`. The neural package uses this table for postcode repair.
 *   The Python trainer reads it in `features/postcode_shapes.py` to paint the train-side anchor
 *   on the spans inference paints. Separate typed copies drifted twice. The IE Eircode row appeared
 *   in TypeScript one month before it appeared in Python. The BR CEP row followed five weeks later.
 *   Each gap made the trainer paint one fewer shape than inference.
 *
 *   This function checks postcode form. `./systems.ts` checks whether a postcode occurs in a gazetteer.
 *   A bare `68161` matches the US five-digit shape. It also matches the German shape.
 *   It matches the French shape. It matches the Spanish shape.
 *   It matches the Italian shape.
 *   The modules remain independent.
 *
 *   The pattern bodies use a regex subset accepted by both JavaScript `RegExp` and Python `re`.
 *   This lets both runtimes read one file. A row needing different source text requires a second field
 *   and a stated reason. Keep each runtime's comparison strict.
 */

import postcodeShapeData from "./shapes.json" with { type: "json" }

/**
 * What a match is eligible to do.
 *
 * `designated` may overwrite any existing label.
 * `alnum` may add a postcode when the model emitted none.
 *
 * `numeric` may only snap an existing postcode.
 * A numeric shape cannot invent a postcode over a hyphenated house number.
 */
export type PostcodeShapeKind = "alnum" | "numeric" | "designated"

/**
 * One shape, including its label and compiled pattern.
 * The kind describes its allowed operation.
 */
export interface PostcodeShape {
	readonly label: string
	readonly kind: PostcodeShapeKind
	readonly re: RegExp
}

/**
 * Every postcode shape, in priority order.
 *
 * Compiled once at module load.
 * Each `RegExp` has the `g` flag so callers scan a whole line.
 * Rows that declare Unicode matching also have the `u` flag.
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
