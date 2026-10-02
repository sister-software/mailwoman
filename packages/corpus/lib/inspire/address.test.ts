/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { childElement, streamMarkupElements } from "@mailwoman/core/html/elements"
import { describe, expect, it } from "vitest"

import {
	adminUnitLevel,
	codelistValue,
	componentHrefs,
	componentJoinKey,
	designator,
	designatorsByType,
	isVoid,
	placeName,
	postalDescriptorCode,
	thoroughfareName,
	voidReason,
} from "#inspire/address"

const NS =
	'xmlns:ad="http://inspire.ec.europa.eu/schemas/ad/4.0" xmlns:gn="http://inspire.ec.europa.eu/schemas/gn/4.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'

/**
 * A Czech address, trimmed from the real file.
 *
 * Czechia types its number `buildingIdentifier`, writes a separate `buildingIdentifierPrefix`
 * carrying `č.ev.`, and references its components by an absolute WFS URL whose `Id=` is the key.
 */
const CZ = `<base:SpatialDataSet xmlns:base="http://inspire.ec.europa.eu/schemas/base/3.3" ${NS}>
	<ad:Address gml:id="AD.31101551">
		<ad:locator><ad:AddressLocator>
			<ad:designator><ad:LocatorDesignator>
				<ad:designator>č.ev.</ad:designator>
				<ad:type xlink:href="http://inspire.ec.europa.eu/codelist/LocatorDesignatorTypeValue/buildingIdentifierPrefix" xlink:title="buildingIdentifierPrefix" />
			</ad:LocatorDesignator></ad:designator>
			<ad:designator><ad:LocatorDesignator>
				<ad:designator>502</ad:designator>
				<ad:type xlink:href="http://inspire.ec.europa.eu/codelist/LocatorDesignatorTypeValue/buildingIdentifier" xlink:title="buildingIdentifier" />
			</ad:LocatorDesignator></ad:designator>
		</ad:AddressLocator></ad:locator>
		<ad:endLifespanVersion xsi:nil="true" nilReason="http://inspire.ec.europa.eu/codelist/VoidReasonValue/Unpopulated" />
		<ad:component xlink:href="http://services.cuzk.cz/wfs/inspire-ad-wfs.asp?service=WFS&amp;Id=TF.48674" xlink:title="Komenského" />
		<ad:component xlink:href="http://services.cuzk.cz/wfs/inspire-ad-wfs.asp?service=WFS&amp;Id=PD.66701" xlink:title="66701" />
		<ad:component xlink:href="" />
	</ad:Address>
	<ad:ThoroughfareName gml:id="TF.48674">
		<ad:name><ad:ThoroughfareNameValue><ad:name><gn:GeographicalName><gn:spelling><gn:SpellingOfName>
			<gn:text>Komenského</gn:text>
		</gn:SpellingOfName></gn:spelling></gn:GeographicalName></ad:name></ad:ThoroughfareNameValue></ad:name>
	</ad:ThoroughfareName>
	<ad:PostalDescriptor gml:id="PD.66701"><ad:postCode>66701</ad:postCode></ad:PostalDescriptor>
	<ad:PostalDescriptor gml:id="PD.ES"><ad:postCode>2250</ad:postCode></ad:PostalDescriptor>
	<ad:AdminUnitName gml:id="AU.4.584282">
		<ad:level xlink:href="http://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/4thOrder" />
		<ad:name><gn:GeographicalName><gn:spelling><gn:SpellingOfName>
			<gn:text>Židlochovice</gn:text>
		</gn:SpellingOfName></gn:spelling></gn:GeographicalName></ad:name>
	</ad:AdminUnitName>
	<ad:AdminUnitName gml:id="AU.1.1">
		<ad:level xlink:href="http://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/1stOrder" />
		<ad:name><gn:GeographicalName><gn:spelling><gn:SpellingOfName xsi:nil="true" nilReason="http://inspire.ec.europa.eu/codelist/VoidReasonValue/Unknown">
			<gn:text xsi:nil="true" nilReason="http://inspire.ec.europa.eu/codelist/VoidReasonValue/Unknown" />
		</gn:SpellingOfName></gn:spelling></gn:GeographicalName></ad:name>
	</ad:AdminUnitName>
</base:SpatialDataSet>`

/**
 * A Dutch address, trimmed from the real file.
 *
 * The Netherlands types its number `addressNumber`, writes the postcode inline as a
 * `LocatorDesignatorTypeValue/postalDeliveryIdentifier`, publishes no `ad:PostalDescriptor`,
 * and writes an empty-but-present `ad:designator` for an absent extension.
 */
const NL = `<gml:FeatureCollection ${NS}>
	<ad:Address gml:id="nl-imbag-ad-address.0003200000133985">
		<ad:locator><ad:AddressLocator>
			<ad:designator><ad:LocatorDesignator><ad:designator>3</ad:designator>
				<ad:type xlink:title="address number" xlink:href="http://inspire.ec.europa.eu/codelist/LocatorDesignatorTypeValue/addressNumber" />
			</ad:LocatorDesignator></ad:designator>
			<ad:designator><ad:LocatorDesignator><ad:designator/>
				<ad:type xlink:title="address number extension" xlink:href="http://inspire.ec.europa.eu/codelist/LocatorDesignatorTypeValue/addressNumberExtension" />
			</ad:LocatorDesignator></ad:designator>
			<ad:designator><ad:LocatorDesignator><ad:designator>9901AA</ad:designator>
				<ad:type xlink:title="postal delivery identifier" xlink:href="http://inspire.ec.europa.eu/codelist/LocatorDesignatorTypeValue/postalDeliveryIdentifier" />
			</ad:LocatorDesignator></ad:designator>
		</ad:AddressLocator></ad:locator>
		<ad:alternativeIdentifier xsi:nil="true" nilReason="http://inspire.ec.europa.eu/codelist/VoidReasonValue/Unpopulated" />
		<ad:component xlink:href="#nl-imbag-ad-thoroughfarename.0003300000117203" />
	</ad:Address>
</gml:FeatureCollection>`

async function* once(text: string): AsyncIterable<string> {
	yield text
}

async function features(document: string, name: string | readonly string[]) {
	return await Array.fromAsync(streamMarkupElements(once(document), name, { xml: true }))
}

describe("codelistValue", () => {
	it("reads the final segment of a codelist URI", () => {
		expect(codelistValue("http://inspire.ec.europa.eu/codelist/LocatorDesignatorTypeValue/buildingIdentifier")).toBe(
			"buildingIdentifier"
		)
	})

	it("drops a fragment, which Flanders appends to a vocabulary reference", () => {
		expect(codelistValue("http://vocab.belgif.be/auth/refnis1995/1000#id")).toBe("1000")
	})

	it("answers undefined for an absent or empty URI", () => {
		expect(codelistValue(undefined)).toBeUndefined()
		expect(codelistValue("")).toBeUndefined()
	})
})

describe("designatorsByType", () => {
	it("keys Czechia's two designators by their INSPIRE type", async () => {
		const [address] = await features(CZ, "ad:Address")
		const byType = designatorsByType(address!)

		expect(Object.fromEntries(byType)).toEqual({
			buildingIdentifierPrefix: ["č.ev."],
			buildingIdentifier: ["502"],
		})

		expect(designator(byType, "buildingIdentifier")).toBe("502")
	})

	it("keeps the Netherlands' empty extension as a stated empty value", async () => {
		const [address] = await features(NL, "ad:Address")
		const byType = designatorsByType(address!)

		// The publisher wrote `<ad:designator/>`, which means "no extension" rather than void.
		expect(byType.get("addressNumberExtension")).toEqual([""])
		// `designator` skips it, because an empty string is not a house-number part.
		expect(designator(byType, "addressNumberExtension")).toBeUndefined()
		expect(designator(byType, "addressNumber")).toBe("3")
		expect(designator(byType, "postalDeliveryIdentifier")).toBe("9901AA")
	})

	it("takes the first non-empty type in the order the caller gives", async () => {
		const [address] = await features(NL, "ad:Address")
		const byType = designatorsByType(address!)

		expect(designator(byType, "addressNumberExtension", "addressNumber")).toBe("3")
		expect(designator(byType, "buildingIdentifier")).toBeUndefined()
	})

	it("answers an empty map for an address with no locator", async () => {
		const [address] = await features(`<r ${NS}><ad:Address gml:id="x" /></r>`, "ad:Address")

		expect(designatorsByType(address!).size).toBe(0)
	})
})

describe("componentHrefs", () => {
	it("returns each reference verbatim, because the key form differs per publisher", async () => {
		const [address] = await features(CZ, "ad:Address")

		expect(componentHrefs(address!)).toEqual([
			"http://services.cuzk.cz/wfs/inspire-ad-wfs.asp?service=WFS&Id=TF.48674",
			"http://services.cuzk.cz/wfs/inspire-ad-wfs.asp?service=WFS&Id=PD.66701",
		])
	})

	it("skips an empty href, which Brussels writes on 9 addresses", async () => {
		const [address] = await features(CZ, "ad:Address")

		// The third component in the fixture carries `xlink:href=""`.
		expect(componentHrefs(address!)).toHaveLength(2)
	})
})

describe("componentJoinKey", () => {
	it("reads a local fragment, which the Netherlands, Wallonia and Brussels write", () => {
		expect(componentJoinKey("#nl-imbag-ad-thoroughfarename.0003300000117203")).toBe(
			"nl-imbag-ad-thoroughfarename.0003300000117203"
		)
	})

	it("reads Czechia's Id parameter, whose capital letter a case-sensitive lookup misses", () => {
		// A reader matching only `id` returned this whole URL, and no `gml:id` equals a URL,
		// so all 5,460 references in one municipality read as unjoinable.
		expect(
			componentJoinKey(
				"http://services.cuzk.cz/wfs/inspire-ad-wfs.asp?service=WFS&storedQuery_id=urn:ogc:def:query:OGC-WFS::GetFeatureById&Id=TF.48674"
			)
		).toBe("TF.48674")
	})

	it("reads the same file's other casing of the stored-query key", () => {
		expect(
			componentJoinKey("http://services.cuzk.cz/wfs/inspire-au-wfs.asp?service=WFS&StoredQuery_id=urn&Id=AU.4.584061")
		).toBe("AU.4.584061")
	})

	it("joins on the feature id a stored-query reference carries", () => {
		expect(
			componentJoinKey("https://rageo.minv.sk/geoserver/ad/ows?service=WFS&request=GetFeature&id=AdminUnitName.15345")
		).toBe("AdminUnitName.15345")
	})

	it("joins on featureID as well as id, which is the parameter Estonia writes", () => {
		expect(
			componentJoinKey(
				"https://inspire.geoportaal.ee/geoserver/AD_Address/ows?service=WFS&request=GetFeature&typeNames=AD_Address%3AAD.Address_PostalDescriptor&featureID=120275"
			)
		).toBe("120275")
	})

	it("joins an identifier URI on itself, dropping a fragment the identifier does not carry", () => {
		// Flanders writes the identifier its component features publish, and writes a fragment
		// on the vocabulary reference that the vocabulary's own term does not carry.
		expect(componentJoinKey("https://data.vlaanderen.be/id/straatnaam/6301")).toBe(
			"https://data.vlaanderen.be/id/straatnaam/6301"
		)

		expect(componentJoinKey("http://vocab.belgif.be/auth/refnis1995/1000#id")).toBe(
			"http://vocab.belgif.be/auth/refnis1995/1000"
		)
	})

	it("answers undefined for an href that is neither a fragment nor a URL", () => {
		expect(componentJoinKey("not a url")).toBeUndefined()
		expect(componentJoinKey("")).toBeUndefined()
		expect(componentJoinKey("   ")).toBeUndefined()
		expect(componentJoinKey("#")).toBeUndefined()
	})
})

describe("the name and code readers", () => {
	it("reads a street through the ThoroughfareName prefix", async () => {
		const [thoroughfare] = await features(CZ, "ad:ThoroughfareName")

		expect(thoroughfareName(thoroughfare!)).toBe("Komenského")
	})

	it("reads a place name and its administrative level", async () => {
		const [municipality, country] = await features(CZ, "ad:AdminUnitName")

		expect(placeName(municipality!)).toBe("Židlochovice")
		expect(adminUnitLevel(municipality!)).toBe("4thOrder")
		expect(adminUnitLevel(country!)).toBe("1stOrder")
	})

	it("answers undefined for a void name rather than an empty string", async () => {
		const [, country] = await features(CZ, "ad:AdminUnitName")

		expect(placeName(country!)).toBeUndefined()
	})

	it("returns a postcode as the publisher wrote it, including a stripped leading zero", async () => {
		const [czech, spanish] = await features(CZ, "ad:PostalDescriptor")

		expect(postalDescriptorCode(czech!)).toBe("66701")
		// The Spanish cadastre writes the element as an integer, so `02250` arrives as `2250`.
		// Padding belongs to the caller that knows the jurisdiction's width.
		expect(postalDescriptorCode(spanish!)).toBe("2250")
	})
})

describe("isVoid and voidReason", () => {
	it("reads a nil marker and its reason", async () => {
		const [address] = await features(CZ, "ad:Address")
		const element = childElement(address!, "ad:endLifespanVersion")

		expect(isVoid(element)).toBe(true)
		expect(voidReason(element)).toBe("Unpopulated")
	})

	it("reads a nil marker with no reason as void, which Brussels writes throughout", async () => {
		const [address] = await features(
			`<r ${NS}><ad:Address><ad:validFrom xsi:nil="true" /></ad:Address></r>`,
			"ad:Address"
		)

		const element = childElement(address!, "ad:validFrom")

		expect(isVoid(element)).toBe(true)
		expect(voidReason(element)).toBeUndefined()
	})

	it("treats an absent element as not void, which a caller distinguishes from void", async () => {
		const [address] = await features(NL, "ad:Address")

		expect(isVoid(childElement(address!, "ad:nowhere"))).toBe(false)
		expect(voidReason(childElement(address!, "ad:nowhere"))).toBeUndefined()
		expect(voidReason(childElement(address!, "ad:alternativeIdentifier"))).toBe("Unpopulated")
	})
})
