/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reads the parts of an INSPIRE Addresses feature that every publisher spells the same way.
 *
 * INSPIRE harmonizes the schema and leaves the rest to the publisher. Seven publishers this
 * repository reads all write `ad:Address` with the same element paths, and they disagree on four
 * things that each decide a value:
 *
 * 1. The wrapper. Czechia writes `base:SpatialDataSet` with `base:member`. The Netherlands,
 *    Wallonia and Brussels write `gml:FeatureCollection` with `gml:featureMember`.
 * 2. The reference form. Czechia's `ad:component` href is an absolute WFS stored-query URL
 *    whose `Id=` parameter is the key. The Netherlands, Wallonia and Brussels write a local `#`
 *    fragment. Flanders writes an absolute data URI that a caller rewrites into a `resourceId`.
 * 3. Where the postcode lives. Czechia and Wallonia reference an `ad:PostalDescriptor`; the
 *    Netherlands puts it inline as a `LocatorDesignatorTypeValue/postalDeliveryIdentifier` locator and publishes no
 *    `ad:PostalDescriptor` at all.
 * 4. The locator vocabulary. Czechia types its number `buildingIdentifier`, the Netherlands
 *    `addressNumber`, Wallonia `LocatorDesignatorTypeValue/addressIdentifierGeneral`, Brussels
 *    `buildingIdentifier`.
 *
 * So this module exposes the primitives and leaves composition to each adapter. A configuration
 * object describing those four axes would have to be right about publishers whose files nobody has
 * read yet. A handful of small functions carries no such claim.
 *
 * The reference form is the exception, because its shapes are enumerable and measured:
 * {@linkcode componentJoinKey} reads all four.
 */

import { childElement, childElements, elementAtPath, type MarkupElement } from "@mailwoman/core/html/elements"

/**
 * The final segment of an INSPIRE codelist URI, which is the value's name.
 *
 * `http://inspire.ec.europa.eu/codelist/LocatorDesignatorTypeValue/buildingIdentifier`
 * reads `buildingIdentifier`.
 * A `#` fragment is dropped first, because Flanders appends one to a `vocab.belgif.be`
 * reference and Czechia folds it into `base:localId`.
 */
export function codelistValue(uri: string | undefined): string | undefined {
	if (!uri) return undefined

	const withoutFragment = uri.split("#")[0]!
	const segment = withoutFragment.split("/").pop()

	return segment || undefined
}

/**
 * Whether a publisher marked this element void.
 *
 * INSPIRE writes `xsi:nil="true"` and usually a `nilReason`.
 * Brussels writes the nil marker and no reason on all 232,003 of its void `ad:validFrom`
 * elements, and Czechia writes four `gn:pronunciation` elements nil with no reason,
 * so a reader keyed on `nilReason` alone mistakes a void value for a populated one.
 *
 * An absent element answers false, so a caller distinguishes a void value from a missing one.
 */
export function isVoid(element: MarkupElement | undefined): boolean {
	return element?.attributes["xsi:nil"] === "true"
}

/**
 * The reason a publisher gave for a void element, as a codelist value such as `Unpopulated`.
 *
 * Returns undefined when the element is void and states no reason, which the
 * schema permits and which Brussels does throughout.
 * A caller that needs to separate a void carrying a reason from a void carrying
 * none reads this together with {@linkcode isVoid}.
 */
export function voidReason(element: MarkupElement | undefined): string | undefined {
	if (!isVoid(element)) return undefined

	return codelistValue(element?.attributes.nilReason)
}

/**
 * Every locator designator on an address, keyed by its INSPIRE type name.
 *
 * One `ad:AddressLocator` carries a designator per part of the number, each in its
 * own `ad:LocatorDesignator` beside an `ad:type` naming what it is.
 * Czechia writes two, `č.ev.` typed `buildingIdentifierPrefix` and `502` typed `buildingIdentifier`.
 *
 * The Netherlands writes four, including an empty `LocatorDesignatorTypeValue/addressNumberExtension`
 * and the postcode as `LocatorDesignatorTypeValue/postalDeliveryIdentifier`.
 *
 * A type may repeat, so each key holds a list in document order.
 * A designator the publisher wrote empty contributes an empty string, which is a value the publisher
 * stated rather than one it omitted: the Netherlands writes `<ad:designator/>` 198,118 times
 * over 108,708 features to mean "no extension", and that is a different condition from void.
 *
 * A designator whose `ad:type` is absent or void is skipped, because its value cannot be placed.
 */
export function designatorsByType(address: MarkupElement): ReadonlyMap<string, readonly string[]> {
	const byType = new Map<string, string[]>()
	const locator = elementAtPath(address, "ad:locator", "ad:AddressLocator")

	if (!locator) return byType

	for (const wrapper of childElements(locator, "ad:designator")) {
		const locatorDesignator = childElement(wrapper, "ad:LocatorDesignator")

		if (!locatorDesignator) continue

		const type = childElement(locatorDesignator, "ad:type")

		if (!type || isVoid(type)) continue

		const name = codelistValue(type.attributes["xlink:href"]) ?? type.text

		if (!name) continue

		const value = childElement(locatorDesignator, "ad:designator")

		// A void designator is reported by `voidDesignatorTypes` rather than here, because a
		// value the publisher marked unknown is not a value and must not reach a component.
		if (!value || isVoid(value)) continue

		const existing = byType.get(name)

		if (existing) {
			existing.push(value.text)
		} else {
			byType.set(name, [value.text])
		}
	}

	return byType
}

/**
 * The first non-empty designator among `types`, in the order given.
 *
 * A caller states its publisher's vocabulary and its own precedence:
 * Czechia asks for `buildingIdentifier`, the Netherlands for `addressNumber`,
 * Wallonia for `LocatorDesignatorTypeValue/addressIdentifierGeneral`.
 */
/**
 * The locator-designator types this address marks void, by their INSPIRE type name.
 *
 * {@linkcode designatorsByType} leaves a void designator out, so on its own it cannot
 * separate a value the publisher marked unknown from one the publisher never wrote.
 * The repository's partial-read rule needs that separation: an unreadable requested
 * value has to be reported rather than turned into an absence.
 *
 * A caller reads this when the difference changes what it does.
 * An adapter that refuses a row carrying no house number should report a void `buildingIdentifier` as
 * a value it could not read, and an absent one as an address the publisher states has no number.
 */
export function voidDesignatorTypes(address: MarkupElement): ReadonlySet<string> {
	const voided = new Set<string>()
	const locator = elementAtPath(address, "ad:locator", "ad:AddressLocator")

	if (!locator) return voided

	for (const wrapper of childElements(locator, "ad:designator")) {
		const locatorDesignator = childElement(wrapper, "ad:LocatorDesignator")

		if (!locatorDesignator) continue

		const value = childElement(locatorDesignator, "ad:designator")

		if (!value || !isVoid(value)) continue

		const type = childElement(locatorDesignator, "ad:type")
		const name = type && !isVoid(type) ? (codelistValue(type.attributes["xlink:href"]) ?? type.text) : undefined

		// A void value whose own type is void or absent cannot be placed, so it is reported under
		// the empty name rather than dropped, which keeps the address's unreadable parts countable.
		voided.add(name || "")
	}

	return voided
}

export function designator(
	byType: ReadonlyMap<string, readonly string[]>,
	...types: readonly string[]
): string | undefined {
	for (const type of types) {
		for (const value of byType.get(type) ?? []) {
			const trimmed = value.trim()

			if (trimmed) return trimmed
		}
	}

	return undefined
}

/**
 * Every `ad:component` reference on an address, as written.
 *
 * The href is returned verbatim, and {@linkcode componentJoinKey} turns it into a join key.
 * A component whose href is absent or empty is skipped.
 *
 * Brussels writes `<ad:component xlink:href=""/>` on 9 addresses, and those 9 therefore
 * carry no postal zone, which a caller must report rather than read as a resolved component.
 */
export function componentHrefs(address: MarkupElement): readonly string[] {
	const hrefs: string[] = []

	for (const component of childElements(address, "ad:component")) {
		const href = component.attributes["xlink:href"]?.trim()

		if (href) {
			hrefs.push(href)
		}
	}

	return hrefs
}

/**
 * The query parameters a WFS stored-query reference carries its feature id in.
 *
 * Each publisher picked a spelling, and the match below ignores case, so Czechia's `Id`
 * and Slovakia's `id` both resolve without naming each casing separately.
 * A reader that knew only `id` returned Czechia's whole URL as the key, and no `gml:id`
 * equals a URL, so all 5,460 of one municipality's references read as unjoinable.
 */
const REFERENCE_ID_PARAMETERS = new Set(["id", "featureid", "resourceid"])

/**
 * The key a component reference joins on.
 *
 * Four shapes appear across the publishers measured, and they differ in
 * where the key sits rather than in whether one exists:
 *
 * | publisher | href | key |
 * | --- | --- | --- |
 * | Netherlands, Wallonia, Brussels | `#nl-imbag-ad-thoroughfarename.0003300000117203` | the fragment |
 * | Czechia | `…inspire-ad-wfs.asp?…&Id=TF.48674` | `TF.48674` |
 * | Slovakia | `…ad/ows?…&id=AdminUnitName.15345` | `AdminUnitName.15345` |
 * | Flanders | `https://data.vlaanderen.be/id/straatnaam/6301` | the URI itself |
 *
 * A URI with no id parameter is its own key, which is what Flanders publishes on both sides of the join.
 * Its fragment is dropped, because a reference may carry one where the identifier does not:
 * `http://vocab.belgif.be/auth/refnis1995/1000#id` addresses the same term as that URI without it.
 *
 * Whether a key joins is not a property of its spelling, so this reads a key
 * and the caller decides joinability against the features the publisher actually served.
 * Deciding it here from the URL's shape once reported 15 of Flanders' 20 references as
 * belonging to another register when every one of them addressed a feature of the same service.
 *
 * @returns The key, or undefined when the href is neither a fragment nor a URL.
 */
export function componentJoinKey(href: string): string | undefined {
	const trimmed = href.trim()

	if (!trimmed) return undefined

	if (trimmed.startsWith("#")) return trimmed.slice(1) || undefined

	let url: URL

	try {
		url = new URL(trimmed)
	} catch {
		return undefined
	}

	for (const [parameter, value] of url.searchParams) {
		if (!REFERENCE_ID_PARAMETERS.has(parameter.toLowerCase())) continue

		const id = value.trim()

		if (id) return id
	}

	url.hash = ""

	return url.toString()
}

/**
 * The spelling a `gn:GeographicalName` carries, reached from a feature that holds one.
 *
 * Every name-bearing INSPIRE feature nests the text at
 * `…/gn:GeographicalName/gn:spelling/gn:SpellingOfName/gn:text`, under a per-feature
 * prefix: an `ad:ThoroughfareName` adds `ad:name/ad:ThoroughfareNameValue/ad:name`,
 * while an `ad:AdminUnitName` and an `ad:AddressAreaName` add only `ad:name`.
 * The caller gives the prefix.
 *
 * @returns The text, or undefined when any step is absent or the name is void.
 */
export function geographicalNameText(feature: MarkupElement, ...prefix: readonly string[]): string | undefined {
	const name = elementAtPath(feature, ...prefix, "gn:GeographicalName", "gn:spelling", "gn:SpellingOfName", "gn:text")

	if (!name || isVoid(name)) return undefined

	const text = name.text.trim()

	return text || undefined
}

/**
 * The street name an `ad:ThoroughfareName` feature states.
 */
export function thoroughfareName(feature: MarkupElement): string | undefined {
	return geographicalNameText(feature, "ad:name", "ad:ThoroughfareNameValue", "ad:name")
}

/**
 * The place name an `ad:AdminUnitName` or `ad:AddressAreaName` feature states.
 */
export function placeName(feature: MarkupElement): string | undefined {
	return geographicalNameText(feature, "ad:name")
}

/**
 * The postcode an `ad:PostalDescriptor` feature states.
 *
 * The Spanish cadastre writes this element as an integer, so `02250` arrives as `2250`.
 * Left-padding belongs to the caller that knows the jurisdiction's width,
 * because this reader returns what the publisher wrote.
 */
export function postalDescriptorCode(feature: MarkupElement): string | undefined {
	const code = childElement(feature, "ad:postCode")

	if (!code || isVoid(code)) return undefined

	const text = code.text.trim()

	return text || undefined
}

/**
 * The administrative level an `ad:AdminUnitName` states, as a codelist value such as `4thOrder`.
 *
 * A publisher references several admin units per address: Czechia references the
 * country at `1stOrder` and the municipality at `4thOrder`, and the Netherlands
 * publishes exactly one `ad:AdminUnitName` feature, the country.
 * A caller picks the finest level it wants by this value rather than by the order the references appear.
 */
export function adminUnitLevel(feature: MarkupElement): string | undefined {
	const level = childElement(feature, "ad:level")

	if (!level || isVoid(level)) return undefined

	return codelistValue(level.attributes["xlink:href"]) ?? (level.text.trim() || undefined)
}
