// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The shape of a trace.
 *
 *   A trace is opt-in: `recognizer.recognize(text, { trace: true })` returns one trace
 *   per recognition beside the recognitions, and a call without the option builds none.
 *
 *   A trace lists each step: which grammar node accepted, and whether the validator accepted.
 *   For a shape listed in `explain`, it also lists the node that first failed to match the text.
 *
 *   Every span is in UTF-16 code units, as the recognitions' are.
 */

/**
 * The outcome of one step.
 *
 * `pass` and `fail` are the grammar's: the node accepted or it didn't.
 * `rejected` is the validator's: the grammar accepted and the values broke a semantic rule.
 *
 * The engine never produces `miss`, a membership check that found no entry,
 * or `gap`, a question the data doesn't cover.
 * Recognition consults no data, and a consumer that resolves a recognition reports them in this shape.
 *
 * `limit` means the replay passed its step budget before it could say.
 */
export const Outcome = {
	Pass: "pass",
	Fail: "fail",
	Rejected: "rejected",
	Miss: "miss",
	Gap: "gap",
	Limit: "limit",
} as const

export type Outcome = (typeof Outcome)[keyof typeof Outcome]

/**
 * How a whole trace ended.
 */
export const TraceResult = {
	/**
	 * The grammar accepted and the validator built a payload.
	 */
	Validated: "validated",
	/**
	 * The grammar accepted and the shape declares no validator.
	 */
	Accepted: "accepted",
	/**
	 * The grammar accepted and the validator refused the values.
	 */
	Rejected: "rejected",
	/**
	 * The grammar didn't accept.
	 */
	NoMatch: "no_match",
	/**
	 * The replay didn't finish.
	 */
	Incomplete: "incomplete",
} as const

export type TraceResult = (typeof TraceResult)[keyof typeof TraceResult]

/**
 * A half-open span in UTF-16 code units.
 */
export interface TraceSpan {
	readonly start: number
	readonly end: number
}

/**
 * Where a grammar node is declared.
 *
 * The IR records the declaration of each shape and each term, so a node of a shape's own
 * grammar reports its shape's line, and a reference reports the line of the term it names.
 */
export interface TraceSource {
	readonly file: string
	readonly line: number
}

/**
 * One step of a trace.
 */
export interface TraceStep {
	/**
	 * The node's stable ID: `<shape>#<index>` for an item of the shape's grammar,
	 * `<shape>#validator` for the validator, `<shape>#end` for the end of the text.
	 */
	readonly node: string
	/**
	 * The operator: `capture`, `reference`, `literal`, `class`, `optional`,
	 * `repeat`, `validator` and the like.
	 */
	readonly op: string
	/**
	 * The capture path, the term ID or the literal text, when the operator has one.
	 */
	readonly name?: string
	readonly source: TraceSource
	/**
	 * The span the node took on an accepted parse.
	 *
	 * On a failing step, an empty span at the furthest offset the earlier steps reached.
	 * A step that passed in an explanation has none.
	 */
	readonly span?: TraceSpan
	readonly outcome: Outcome
	/**
	 * The typed rejection, on a step whose outcome is `rejected`.
	 */
	readonly rejection?: { readonly code: string; readonly capture: string | null; readonly message: string }
}

/**
 * The trace of one shape over one span or one text.
 */
export interface Trace {
	readonly family: string
	/**
	 * The shape's ID, the same string as a recognition's `kind`.
	 */
	readonly shape: string
	/**
	 * The recognized span.
	 * A trace of a text the grammar didn't accept has none.
	 */
	readonly span?: TraceSpan
	readonly steps: readonly TraceStep[]
	readonly result: TraceResult
}

/**
 * The options of a traced call.
 */
export interface TraceOptions {
	/**
	 * Shape IDs to explain against the whole text, beside the recognitions' traces.
	 *
	 * A shape that matches the whole text gets the trace of an accepted span.
	 * A shape that doesn't gets the first failing step.
	 * The explanation covers the whole text only.
	 */
	readonly explain?: readonly string[]
}
