// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The types that compose families, and `defineFamily`, which each family module calls.
 *
 *   A family declaration is data: an ID, its generated kinds, the hash of its generated
 *   declarations and a function that returns its artifact's bytes.
 *   A family module imports this file and its own artifact only, so a bundle that
 *   imports one family holds one artifact and no engine.
 *
 *   # Typed results
 *
 *   A family declaration has three type parameters that exist only in types: the union of its
 *   kinds, the payload each validated kind returns, and the result fields the family adds.
 *   `createRecognizer` composes them, so the kinds of a recognizer are the union of its
 *   families' kinds, and a handler map that omits one fails to type-check.
 *
 *   # How a family contributes typed fields later
 *
 *   A recognition result is `{ recognitions, fields }`.
 *   `fields` is typed as the intersection of every composed family's `Fields` parameter,
 *   and the engine's result document has a `fields` object the family fills.
 *
 *   A family that returns structural fields, such as the `structure` family's character class
 *   or segments, declares its `Fields` type and adds the matching keys to that object.
 *   Neither the recognizer's signature nor the ABI changes, and a family that adds no
 *   fields keeps an empty `Fields` type, an identity in the intersection.
 */

/**
 * The hidden slot that holds a declaration's type parameters.
 * It exists in types only.
 */
declare const $types: unique symbol

/**
 * Why a span's captured values failed validation.
 */
export interface Rejection {
	readonly code: string
	readonly capture: string | null
	readonly message: string
}

/**
 * The shape-only outcome: the span matched and the shape declares no validator.
 */
export interface Unvalidated {
	readonly status: "unvalidated"
}

/**
 * The validator accepted the captured values.
 */
export interface Validated<Payload> {
	readonly status: "validated"
	readonly payload: Payload
}

/**
 * The span matched the shape's grammar and its values failed validation.
 */
export interface Rejected {
	readonly status: "rejected"
	readonly rejection: Rejection
}

/**
 * One recognized span of kind `Kind`.
 *
 * A kind with a payload type has a validated payload or a rejection,
 * and a kind without one has its span and text only.
 *
 * Offsets are UTF-16 code units, half-open, as `String.prototype.slice` reads them.
 */
export interface Recognition<Kind extends string = string, Payload = never> {
	readonly kind: Kind
	readonly family: string
	readonly start: number
	readonly end: number
	/**
	 * The raw text of the span, `text.slice(start, end)`.
	 */
	readonly text: string
	readonly validation: [Payload] extends [never] ? Unvalidated : Validated<Payload> | Rejected
}

/**
 * A handler: a function that receives one recognition and returns the consumer's result.
 *
 * `R` is the recognition type.
 * A {@link HandlerMap} supplies it for each kind, and it defaults to a loosely
 * typed recognition of kind `K`.
 */
export type Handler<K extends string, R extends { readonly kind: K } = Recognition<K, unknown>> = (
	recognition: R
) => unknown

/**
 * One family's declaration.
 */
export interface FamilyDeclaration<
	Kind extends string = string,
	Payloads extends object = object,
	Fields extends object = Record<never, never>,
> {
	readonly id: string
	/**
	 * Every kind by name, as the generated `<Family>Kind` constant spells them.
	 */
	readonly kinds: Readonly<Record<string, Kind>>
	/**
	 * The hash of the generated declarations.
	 * The loader refuses an artifact whose embedded hash differs.
	 */
	readonly declarationsHash: string
	/**
	 * The artifact's bytes.
	 * Called on the first recognition.
	 */
	readonly artifact: () => Uint8Array
	/**
	 * Type-only slot for the payloads and fields.
	 */
	readonly [$types]?: { payloads: Payloads; fields: Fields }
}

/**
 * Any family declaration.
 */
export type AnyFamily = FamilyDeclaration<string, object, object>

type KindOf<D> = D extends { readonly kinds: Readonly<Record<string, infer Kind extends string>> } ? Kind : never

/**
 * The union of the kinds of every family in `F`.
 */
export type KindsOf<F extends readonly AnyFamily[]> = KindOf<F[number]>

type RecognitionOfFamily<D> = D extends { readonly [$types]?: { payloads: infer Payloads } }
	? {
			[K in KindOf<D>]: Recognition<K, K extends keyof Payloads ? Payloads[K] : never>
		}[KindOf<D>]
	: never

/**
 * The union of every recognition a recognizer over `F` returns, one member per kind.
 */
export type RecognitionsOf<F extends readonly AnyFamily[]> = RecognitionOfFamily<F[number]>

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
	? I
	: never

type FieldsOfFamily<D> = D extends { readonly [$types]?: { fields: infer Fields } } ? Fields : never

/**
 * The result fields of a recognizer over `F`: the intersection of its families' fields.
 *
 * No family declares fields yet, so the type is an empty object type.
 */
export type FieldsOf<F extends readonly AnyFamily[]> = UnionToIntersection<FieldsOfFamily<F[number]>>

/**
 * The handler map type for `F`: one handler per kind of every composed family,
 * each typed with its own recognition.
 *
 * ```ts
 * const handlers = { … } satisfies HandlerMap<typeof families>
 * ```
 *
 * A map that omits a kind of any composed family fails to type-check.
 * The looser form `{ [K in KindsOf<typeof families>]: Handler<K> }` checks coverage
 * the same way and types each handler's recognition loosely.
 */
export type HandlerMap<F extends readonly AnyFamily[]> = {
	[K in KindsOf<F>]: Handler<K, Extract<RecognitionsOf<F>, { readonly kind: K }>>
}

/**
 * Declares a family.
 * Each family module calls it with its generated pieces.
 */
export function defineFamily<
	Kind extends string,
	Payloads extends object = object,
	Fields extends object = Record<never, never>,
>(spec: {
	id: string
	kinds: Readonly<Record<string, Kind>>
	declarationsHash: string
	artifact: () => Uint8Array
}): FamilyDeclaration<Kind, Payloads, Fields> {
	if (!/^[0-9a-f]{64}$/u.test(spec.declarationsHash)) {
		throw new TypeError(`family ${spec.id}: the declarations hash is not 64 lowercase hexadecimal digits`)
	}

	return Object.freeze({ ...spec })
}
