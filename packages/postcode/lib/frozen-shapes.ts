// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The frozen legacy table of postcode shape patterns.
 *
 *   The `postal` family finds postcode spans now, for serving and for the training
 *   encoder alike (`./postal-spans.ts`).
 *   This table survives for the two readers whose results the published model's release verdict covers.
 *
 *   One is `span_mode: "shaped"` in `@mailwoman/neural`, which model 10.8.0's card declares.
 *   The other is its postcode repair pass.
 *
 *   The training encoder doesn't read the table, and no one may add a row.
 *   Both readers and this file are deleted together with the legacy-formats family
 *   when the first model that declares `span_mode: "postal"` ships.
 *
 *   Patterns appear from most-specific to least-specific.
 *   A lower index wins when patterns overlap.
 *
 *   This function checks postcode form.
 *   `./systems.ts` checks whether a postcode occurs in a gazetteer.
 *
 *   A bare `68161` matches the US five-digit shape.
 *   It also matches the German shape.
 *
 *   It matches the French shape.
 *   It matches the Spanish shape.
 *
 *   It matches the Italian shape.
 *   The modules remain independent.
 *
 *   The pattern bodies use a regex subset accepted by both JavaScript `RegExp` and Python `re`.
 *   This lets both runtimes read one file.
 *
 *   A row needing different source text requires a second field and a stated reason.
 *   Keep each runtime's comparison strict.
 */

import postcodeShapeData from "./frozen-shapes.json" with { type: "json" }

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

/**
 * The anchored form of each shape that states one, keyed by label.
 *
 * {@linkcode POSTCODE_SHAPES} answers whether a line contains a postcode-shaped span.
 * This map answers whether a whole string is one.
 *
 * That's the question a caller asks once it already holds a span and wants to know what the span is.
 *
 * A row states a `whole` pattern only where the anchored form differs from its scan form,
 * and its `wholeNote` gives the reason.
 *
 * These patterns match either case, where the scan patterns require upper case to stay off lower-case prose.
 * An anchored test receives a span a caller already isolated, so `sw1a 1aa` is an ordinary
 * way for a person to type a postcode rather than a word that happens to fit.
 *
 * No other runtime reads `pattern` now, so the anchored form has no cross-runtime constraint.
 */
export const WHOLE_POSTCODE_SHAPES: ReadonlyMap<string, RegExp> = new Map(
	postcodeShapeData.shapes
		.filter((shape): shape is typeof shape & { whole: string } => "whole" in shape && typeof shape.whole === "string")
		.map((shape) => [shape.label, new RegExp(shape.whole, "unicode" in shape && shape.unicode ? "iu" : "i")])
)

/**
 * The anchored pattern for `label`.
 *
 * @throws When no shape holds that label or the labeled shape states no anchored form, because
 * a caller naming a label it cannot have is a typo rather than a reason to answer "no match".
 */
export function wholePostcodeShape(label: string): RegExp {
	const re = WHOLE_POSTCODE_SHAPES.get(label)

	if (!re) {
		// Codex depends on no other workspace, so this quotes the label directly rather than through
		// `stringifyJSON`, which lives in `@mailwoman/core` and would invert the dependency.
		throw new Error(
			`wholePostcodeShape: frozen-shapes.json states no anchored pattern for "${label}"; it has ${[...WHOLE_POSTCODE_SHAPES.keys()].join(", ")}`
		)
	}

	return re
}
