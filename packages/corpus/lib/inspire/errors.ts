/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The two conditions an INSPIRE Addresses reader must report rather than read as an absence.
 *
 * An `ad:Address` states its street, its postcode and its place names by reference, and states the
 * parts of its number as typed designators. Both forms can hold a value the reader asked for and
 * could not read: a reference whose target the service never served, and a designator the publisher
 * marked `xsi:nil`. An empty component for either would publish an address the publisher did not
 * state, so each raises and names what it could not read.
 *
 * The errors live beside {@linkcode "#inspire/address"} because every publisher of this theme writes
 * both forms, so an adapter for the next one reports the same two conditions in the same words.
 */

/**
 * Raised when an `ad:component` reference resolves to no feature the reader indexed.
 *
 * The message states the address's own `gml:id` and the href as the publisher wrote it,
 * so the failure identifies the record and the reference rather than the run.
 *
 * A reader whose index is complete raises on the first unresolved reference.
 * One reading a document that interleaves features with addresses defers the address
 * instead, and raises only once the document has ended, because until then an
 * unresolved reference and an absent one are the same observation.
 */
export class UnresolvedComponentReferenceError extends Error {
	constructor(adapterID: string, addressID: string | undefined, href: string) {
		super(
			`${adapterID} adapter: address ${addressID ?? "(no gml:id)"} carries ad:component xlink:href="${href}", which resolves to no feature`
		)

		this.name = "UnresolvedComponentReferenceError"
	}
}

/**
 * Raised when a locator designator the reader needs is present and marked void.
 *
 * `designatorsByType` leaves a void designator out, so a reader keyed on that map by itself
 * cannot tell a number the publisher marked unknown from one the publisher never wrote.
 * `voidDesignatorTypes` separates them, and this error reports the first case.
 */
export class VoidDesignatorError extends Error {
	constructor(adapterID: string, addressID: string | undefined, type: string) {
		super(`${adapterID} adapter: address ${addressID ?? "(no gml:id)"} marks its ${type} designator void`)

		this.name = "VoidDesignatorError"
	}
}

/**
 * Raised when a publication's archive cannot answer what the adapter asked it for.
 *
 * An archive holding no component feature is not a smaller publication.
 * Every address references a fixed set of components, so an empty index turns each
 * row into a row with no street rather than into fewer rows.
 *
 * That is the absence the repository's partial-read rule refuses.
 *
 * The adapter id records which publisher failed, so one class serves every
 * publisher that ships its theme as one archive.
 */
export class InspireArchiveError extends Error {
	constructor(adapterID: string, message: string) {
		super(`${adapterID} adapter: ${message}`)

		this.name = "InspireArchiveError"
	}
}
