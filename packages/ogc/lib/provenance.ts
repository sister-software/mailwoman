// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The license and source links of a collection, read from the manifests of its layers.
 *
 *   Each identifier in a layer's license expression whose text has a known URL becomes a
 *   `license` link (RFC 4946: "Refers to a license associated with this context").
 *   Each source the manifest records with a known location becomes a `via` link
 *   (the RFC 4287 relation for the source of the information in the link's context).
 *
 *   A source that matches another opened layer, as the candidate gazetteer's manifest
 *   records the admin gazetteer, contributes that layer as a whole: its license links,
 *   its sources and its credit, so a collection that credits a source links its license too.
 *   A license that requires credit adds an `attribution`, the member OGC API Common Part
 *   2 gives a collection for "a short attribution for data being visualized".
 *
 *   A collection lists each link once, whatever the count of regional layers that record it.
 *   A manifest field without a value, and a value without a known URL,
 *   adds one sentence to the description rather than a link.
 */

import { manifestSourceNames } from "@mailwoman/core/layers"
import { LicenseObligation, licenseIdentifiers, summarizeLicense } from "@mailwoman/core/license/obligations"
import { licenseTextURL } from "@mailwoman/core/license/text-url"
import { gazetteerSourceLocation } from "@mailwoman/resolver-wof-sqlite/sources"

import type { OGCLayerTerms, OGCServedCollection } from "#engine"
import { OGCLinkRelation, OGCMediaType, type OGCLink } from "#schema"

/**
 * The links, attribution and description sentences a collection's layers contribute.
 */
export interface OGCCollectionTerms {
	links: OGCLink[]
	/**
	 * The credit a client shows beside the data, present when a layer's license requires attribution.
	 */
	attribution?: string
	/**
	 * Sentences for the description, each one stating a manifest field the links couldn't come from.
	 */
	notes: string[]
}

function countPhrase(count: number, singular: string, plural: string): string {
	return count === 1 ? `1 ${singular}` : `${count} ${plural}`
}

/**
 * The license and source links of `served`, from its own layers' manifests.
 *
 * @param knownLayers Every layer the engine opened, so a source that matches a layer resolves to that layer.
 */
export function collectionTerms(
	served: OGCServedCollection,
	knownLayers: readonly OGCLayerTerms[]
): OGCCollectionTerms {
	const unread = served.unreadRegions
		? `${countPhrase(served.unreadRegions, "region has", "regions have")} a layer without a readable layer_manifest, so ${served.unreadRegions === 1 ? "it contributes" : "they contribute"} no link.`
		: null

	if (!served.layers) {
		return {
			links: [],
			notes: ["The server read no layer manifest for this collection, so it links no license or source."],
		}
	}

	const links: OGCLink[] = []
	const credits: string[] = []
	const hrefs = new Set<string>()
	const unlinkedLicenses = new Set<string>()
	const unlocatedSources = new Set<string>()
	let withoutLicense = 0
	let withoutSource = 0
	let attributionRequired = false

	const push = (link: OGCLink) => {
		if (hrefs.has(`${link.rel} ${link.href}`)) return

		hrefs.add(`${link.rel} ${link.href}`)
		links.push(link)
	}

	const credit = (text: string | null) => {
		if (text && !credits.includes(text)) {
			credits.push(text)
		}
	}

	const addLayer = (layer: OGCLayerTerms, visited: Set<string>) => {
		if (!layer.license) {
			withoutLicense++
		} else {
			if (summarizeLicense(layer.license).obligations.includes(LicenseObligation.Attribution)) {
				attributionRequired = true
			}

			for (const identifier of licenseIdentifiers(layer.license)) {
				const href = licenseTextURL(identifier)

				if (href) {
					push({ href, rel: OGCLinkRelation.License, type: OGCMediaType.HTML, title: identifier })
				} else {
					unlinkedLicenses.add(identifier)
				}
			}
		}

		if (!layer.source) {
			withoutSource++
			credit(layer.attribution)

			return
		}

		const names = manifestSourceNames(layer.source)

		for (const name of names) {
			const location = layer.sourceLocations?.[name] ?? gazetteerSourceLocation(name)
			const upstream = knownLayers.find((known) => known.name === name)

			if (location) {
				push({ href: location.url, rel: OGCLinkRelation.Via, type: OGCMediaType.HTML, title: location.title })
				// A layer of one source records that source's own credit line, so it's credited in the publisher's words.
				credit(names.length === 1 && layer.attribution ? layer.attribution : location.title)
			} else if (upstream && !visited.has(upstream.name)) {
				visited.add(upstream.name)
				addLayer(upstream, visited)
			} else if (!upstream) {
				unlocatedSources.add(name)
				// A source without a location is credited through the layer's own recorded attribution.
				credit(layer.attribution)
			}
		}
	}

	for (const layer of served.layers) {
		addLayer(layer, new Set([layer.name]))
	}

	const notes = [
		...(unread ? [unread] : []),
		...(withoutLicense ? [`${countPhrase(withoutLicense, "layer records", "layers record")} no license.`] : []),
		...(withoutSource ? [`${countPhrase(withoutSource, "layer records", "layers record")} no source.`] : []),
		...(unlinkedLicenses.size
			? [`No published text is linked for the license ${[...unlinkedLicenses].join(", ")}.`]
			: []),
		...(unlocatedSources.size
			? [`The server knows no location for the source ${[...unlocatedSources].join(", ")}.`]
			: []),
	]

	return attributionRequired && credits.length ? { links, notes, attribution: credits.join("; ") } : { links, notes }
}
