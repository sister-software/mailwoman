/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * The fixtures are trimmed from live responses, recorded 2026-09-30:
 * Slovakia's `rageo.minv.sk/geoserver/ad/wfs` and Flanders' `geo.api.vlaanderen.be/ad/wfs`.
 */

import { stubFetchingBodies } from "@mailwoman/core/api/test-transport"
import { stringifyJSON } from "@mailwoman/core/json"
import { describe, expect, it } from "vitest"

import {
	AD_FEATURE_TYPES,
	adFeatureTypeOf,
	componentIdentifier,
	componentReferences,
	isVoided,
	readFeaturePage,
	readVoidable,
	readWFSCapabilities,
	resolveComponents,
	type GeoJSONFeature,
} from "#tools/fetch/inspire-addresses"

const SLOVAK_CAPABILITIES = `<?xml version="1.0"?>
<WFS_Capabilities version="2.0.0">
  <OperationsMetadata>
    <Operation name="GetFeature">
      <Parameter name="outputFormat">
        <AllowedValues>
          <Value>application/gml+xml; version=3.2</Value>
          <Value>application/json</Value>
          <Value>csv</Value>
        </AllowedValues>
      </Parameter>
    </Operation>
  </OperationsMetadata>
  <FeatureTypeList>
    <FeatureType><Name>ad:Address</Name></FeatureType>
    <FeatureType><Name>ad:ThoroughfareName</Name></FeatureType>
    <FeatureType><Name>ad:PostalDescriptor</Name></FeatureType>
    <FeatureType><Name>ad:AdminUnitName</Name></FeatureType>
  </FeatureTypeList>
  <fes:Constraint name="ImplementsResultPaging">
    <ows:DefaultValue>TRUE</ows:DefaultValue>
  </fes:Constraint>
</WFS_Capabilities>`

describe("reading an INSPIRE Addresses WFS", () => {
	it("reads the formats, the paging support and the qualified type names a service advertises", async () => {
		const capabilities = await readWFSCapabilities(stubFetchingBodies(SLOVAK_CAPABILITIES), {
			wfsURL: "https://example.invalid/wfs",
			context: "test",
		})

		expect(capabilities.outputFormats).toContain("application/json")
		expect(capabilities.jsonFormat).toBe("application/json")
		expect(capabilities.supportsPaging).toBe(true)
		expect(capabilities.typeNames.Address).toBe("ad:Address")
		expect(capabilities.typeNames.PostalDescriptor).toBe("ad:PostalDescriptor")

		// The service publishes four of the five, and the fifth reads as absent rather than as a guess.
		expect(capabilities.typeNames.AddressAreaName).toBeUndefined()
	})

	it("refuses a capabilities document that advertises no output format", async () => {
		await expect(
			readWFSCapabilities(stubFetchingBodies("<WFS_Capabilities version='2.0.0'/>"), {
				wfsURL: "https://example.invalid/wfs",
				context: "test",
			})
		).rejects.toThrow(/advertised no outputFormat/u)
	})

	it("reads the four ways a service names the same type", () => {
		// Measured across the four services this module was written from.
		// A reader that compares the part after the colon against `Address` finds Estonia
		// and Poland publishing no addresses.
		expect(adFeatureTypeOf("ad:Address")).toBe("Address")
		expect(adFeatureTypeOf("AD_Address:AD.Address")).toBe("Address")
		expect(adFeatureTypeOf("ms:AD.Address")).toBe("Address")
		expect(adFeatureTypeOf("AD_Address:AD.Address_ThoroughfareName")).toBe("ThoroughfareName")
		expect(adFeatureTypeOf("AD_Address:AD.Address_AdminUnitName")).toBe("AdminUnitName")
		expect(adFeatureTypeOf("ad:PostalDescriptor")).toBe("PostalDescriptor")

		expect(adFeatureTypeOf("bu:Building")).toBeNull()
		expect(adFeatureTypeOf("Addresses")).toBeNull()
	})

	it("takes a type only from the feature-type list", async () => {
		// `Name` also labels operation parameters and service contacts.
		// One of those matching would publish a feature type the service does not serve,
		// and every page of it would fail.
		const decoy = `<?xml version="1.0"?>
<WFS_Capabilities version="2.0.0">
  <ServiceProvider><ServiceContact><IndividualName>ad:Address</IndividualName></ServiceContact></ServiceProvider>
  <OperationsMetadata>
    <Operation name="GetFeature">
      <Parameter name="outputFormat"><AllowedValues><Value>application/json</Value></AllowedValues></Parameter>
      <Parameter name="typeNames"><AllowedValues><Name>ad:Address</Name></AllowedValues></Parameter>
    </Operation>
  </OperationsMetadata>
  <FeatureTypeList>
    <FeatureType><Name>ms:AD.Address</Name></FeatureType>
  </FeatureTypeList>
</WFS_Capabilities>`

		const capabilities = await readWFSCapabilities(stubFetchingBodies(decoy), {
			wfsURL: "https://example.invalid/wfs",
			context: "test",
		})

		expect(capabilities.typeNames.Address).toBe("ms:AD.Address")
	})

	it("carries every AD feature type this module pages", () => {
		// An address references the other four, so a build that pages only `Address` holds
		// addresses whose street name and postcode it cannot resolve.
		expect(AD_FEATURE_TYPES).toEqual([
			"Address",
			"ThoroughfareName",
			"PostalDescriptor",
			"AdminUnitName",
			"AddressAreaName",
		])
	})
})

describe("paging", () => {
	it("refuses a page past the first from a service that declines paging", async () => {
		// Such a service answers every page with the first, so the caller would read
		// one page repeatedly and record it as the whole dataset.
		await expect(
			readFeaturePage(stubFetchingBodies("{}"), {
				wfsURL: "https://example.invalid/wfs",
				typeName: "ad:Address",
				outputFormat: "application/json",
				count: 100,
				startIndex: 100,
				supportsPaging: false,
				context: "test",
			})
		).rejects.toThrow(/does not advertise ImplementsResultPaging/u)
	})

	it("reads a page and its reported total", async () => {
		const page = await readFeaturePage(
			stubFetchingBodies(
				stringifyJSON({
					type: "FeatureCollection",
					numberMatched: 1_704_196,
					numberReturned: 1,
					features: [{ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} }],
				})
			),
			{
				wfsURL: "https://example.invalid/wfs",
				typeName: "ad:Address",
				outputFormat: "application/json",
				count: 1,
				startIndex: 0,
				supportsPaging: true,
				context: "test",
			}
		)

		expect(page.numberMatched).toBe(1_704_196)
		expect(page.numberReturned).toBe(1)
	})

	it("reports an uncounted total as unstated rather than as zero", async () => {
		// WFS 2.0 permits the server to decline a count.
		// A reader that takes that as 0 would turn a refusal to count into a measurement of none.
		const page = await readFeaturePage(
			stubFetchingBodies(stringifyJSON({ numberMatched: "unknown", numberReturned: 0, features: [] })),
			{
				wfsURL: "https://example.invalid/wfs",
				typeName: "ad:Address",
				outputFormat: "application/json",
				count: 10,
				startIndex: 0,
				supportsPaging: true,
				context: "test",
			}
		)

		expect(page.numberMatched).toBeNull()
	})

	it("refuses a WFS 2.0 exception report as a report rather than as unparseable JSON", async () => {
		// This body used to reach `JSON.parse` and surface as "not JSON", because the
		// detector knew only the OGC 1.x `ServiceExceptionReport` spelling.
		// The reader now recognizes the WFS 2.0 `ows:ExceptionReport` spelling as a refusal.
		await expect(
			readFeaturePage(stubFetchingBodies("<ows:ExceptionReport/>"), {
				wfsURL: "https://example.invalid/wfs",
				typeName: "ad:Address",
				outputFormat: "application/json",
				count: 10,
				startIndex: 0,
				supportsPaging: true,
				context: "test",
			})
		).rejects.toThrow(/exception report/u)
	})

	it("refuses a body that is not the JSON it asked for and is not a report either", async () => {
		await expect(
			readFeaturePage(stubFetchingBodies("<html><body>maintenance</body></html>"), {
				wfsURL: "https://example.invalid/wfs",
				typeName: "ad:Address",
				outputFormat: "application/json",
				count: 10,
				startIndex: 0,
				supportsPaging: true,
				context: "test",
			})
		).rejects.toThrow(/not JSON/u)
	})
})

describe("voidable properties", () => {
	it("tells a void apart from a value", () => {
		// GeoServer writes a voidable null as an object.
		// `String()` on one yields `[object Object]`, which a naive reader stores as
		// though the publisher had supplied that text.
		const voided = { "@nilReason": "http://inspire.ec.europa.eu/codelist/VoidReasonValue/Unpopulated", "@nil": "true" }

		expect(isVoided(voided)).toBe(true)
		expect(isVoided("2022-03-13T23:00:00Z")).toBe(false)
		expect(isVoided(null)).toBe(false)

		expect(readVoidable(voided)).toBeNull()
		expect(readVoidable("2022-03-13T23:00:00Z")).toBe("2022-03-13T23:00:00Z")
	})
})

describe("component references", () => {
	const slovakAddress: GeoJSONFeature = {
		type: "Feature",
		geometry: { type: "Point", coordinates: [18.06826613, 48.4] },
		properties: {
			component: [
				{ "@href": "https://rageo.minv.sk/geoserver/ad/ows?service=WFS&request=GetFeature&id=AdminUnitName.15345" },
				{ "@href": "https://rageo.minv.sk/geoserver/ad/ows?service=WFS&request=GetFeature&id=PostalDescriptor.95144" },
			],
		},
	}

	const flemishAddress: GeoJSONFeature = {
		type: "Feature",
		geometry: { type: "Point", coordinates: [4.35, 50.85] },
		properties: {
			component: [
				{ "@href": "http://vocab.belgif.be/auth/refnis1995/1000#id" },
				{ "@href": "https://data.vlaanderen.be/id/straatnaam/1000" },
			],
		},
	}

	/**
	 * Estonia writes one flat property per component slot and fills an unused slot with a bare
	 * void reason, so slots 4 and 5 state that no component exists rather than naming one.
	 */
	const estonianAddress: GeoJSONFeature = {
		type: "Feature",
		geometry: { type: "Point", coordinates: [23.2, 58.6] },
		properties: {
			component1_xlink_href:
				"https://inspire.geoportaal.ee/geoserver/AU_haldusyksused/ows?service=WFS&request=GetFeature&id=AU.AdministrativeUnit.1",
			component1_xlink_title: "Harju maakond",
			component4_xlink_href: "unpopulated",
			component5_xlink_href: "unpopulated",
			component6_xlink_href:
				"https://inspire.geoportaal.ee/geoserver/AD_Address/ows?service=WFS&request=GetFeature&id=AD.Address_ThoroughfareName.92",
		},
	}

	/**
	 * The features the two services publish for the references above to join against.
	 */
	const slovakComponents: readonly GeoJSONFeature[] = [
		{ type: "Feature", geometry: null, properties: { gml_id: "AdminUnitName.15345" } },
		{ type: "Feature", geometry: null, properties: { gml_id: "PostalDescriptor.95144" } },
	]

	const flemishComponents: readonly GeoJSONFeature[] = [
		{
			type: "Feature",
			geometry: null,
			properties: { identifier: { value: "https://data.vlaanderen.be/id/straatnaam/1000" } },
		},
	]

	it("reads every reference an address carries", () => {
		expect(componentReferences(slovakAddress)).toHaveLength(2)
		expect(componentReferences({ ...slovakAddress, properties: {} })).toHaveLength(0)
	})

	it("reads a flattened component slot, and reads a bare void reason as no reference", () => {
		// A reader of only the `component` array reported 0 references for every
		// Estonian address, where each holds four.
		const references = componentReferences(estonianAddress)

		expect(references).toHaveLength(2)
		expect(references).not.toContain("unpopulated")

		expect(references[0]).toContain("AU_haldusyksused")
		expect(references[1]).toContain("AD.Address_ThoroughfareName.92")
	})

	it("reads the identifier a component feature publishes, preferring the INSPIRE one over gml_id", () => {
		expect(componentIdentifier(flemishComponents[0]!)).toBe("https://data.vlaanderen.be/id/straatnaam/1000")
		expect(componentIdentifier(slovakComponents[0]!)).toBe("AdminUnitName.15345")
		expect(componentIdentifier({ type: "Feature", geometry: null, properties: {} })).toBeNull()
	})

	it("decides joinability against the features a service published rather than against a URL's shape", () => {
		// A decision from the URL shape reported 15 of Flanders' 20 references as another register's.
		// Each addresses a feature of the same service.
		const resolution = resolveComponents([flemishAddress], flemishComponents)

		expect(resolution.joined).toBe(1)
		expect(resolution.unjoined).toBe(1)
		expect(resolution.unjoinedExample).toBe("http://vocab.belgif.be/auth/refnis1995/1000#id")
		expect(resolution.unreadable).toBe(0)
	})

	it("reports an unjoined reference rather than assuming the component is absent", () => {
		// The component features supplied hold neither key, and an address referencing a
		// feature past the end of a page reads the same as one referencing another register.
		// The caller looks at `unjoinedExample` to tell them apart.
		const resolution = resolveComponents([slovakAddress, flemishAddress], [])

		expect(resolution.joined).toBe(0)
		expect(resolution.unjoined).toBe(4)
	})

	it("counts a reference it cannot read a key from separately from one that did not join", () => {
		const unreadable: GeoJSONFeature = {
			type: "Feature",
			geometry: null,
			properties: { component: [{ "@href": "AdminUnitName.15345" }] },
		}

		const resolution = resolveComponents([unreadable], slovakComponents)

		expect(resolution.unreadable).toBe(1)
		expect(resolution.joined).toBe(0)
		expect(resolution.unjoined).toBe(0)
	})

	it("joins every reference across a page when both services' components are supplied", () => {
		const resolution = resolveComponents([slovakAddress, flemishAddress], [...slovakComponents, ...flemishComponents])

		expect(resolution.joined).toBe(3)
		expect(resolution.unjoined).toBe(1)
		expect(resolution.unjoinedExample).toBe("http://vocab.belgif.be/auth/refnis1995/1000#id")
	})
})
