// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The license and source links of a collection, read from the manifests of its layers.
 *
 *   {@linkcode resolveLayerTerms} reads the manifests.
 *   Its license links become `license` links (RFC 4946: "Refers to a license
 *   associated with this context"), and its source links become `via` links
 *   (the RFC 4287 relation for the source of the information in the link's context).
 *
 *   A license that requires credit adds an `attribution`, the member OGC API Common Part
 *   2 gives a collection for "a short attribution for data being visualized".
 *
 *   A collection lists each link once, whatever the count of regional layers that record it.
 *   A manifest field without a value, and a value without a known URL,
 *   adds one sentence to the description rather than a link.
 */

import { type LayerTerms, ProvenanceLinkKind, resolveLayerTerms } from "@mailwoman/core/layers/provenance"
import { gazetteerSourceLocation } from "@mailwoman/resolver-wof-sqlite/sources"

import type { OGCServedCollection } from "#engine"
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
 * A source that neither the layer's provider nor the gazetteer's source table locates is stated in a note.
 *
 * @param knownLayers Every layer the engine opened, so a source that matches a layer resolves to that layer.
 */
export function collectionTerms(served: OGCServedCollection, knownLayers: readonly LayerTerms[]): OGCCollectionTerms {
	const unread = served.unreadRegions
		? `${countPhrase(served.unreadRegions, "region has", "regions have")} a layer without a readable layer_manifest, so ${served.unreadRegions === 1 ? "it contributes" : "they contribute"} no link.`
		: null

	if (!served.layers) {
		return {
			links: [],
			notes: ["The server read no layer manifest for this collection, so it links no license or source."],
		}
	}

	const provenance = resolveLayerTerms(served.layers, { knownLayers, locate: gazetteerSourceLocation })

	const links: OGCLink[] = provenance.links.map((link) => ({
		href: link.href,
		rel: link.kind === ProvenanceLinkKind.License ? OGCLinkRelation.License : OGCLinkRelation.Via,
		type: OGCMediaType.HTML,
		title: link.title,
	}))

	const { withoutLicense, withoutSource, unlinkedLicenses, unlocatedSources, credits } = provenance

	const notes = [
		...(unread ? [unread] : []),
		...(withoutLicense ? [`${countPhrase(withoutLicense, "layer records", "layers record")} no license.`] : []),
		...(withoutSource ? [`${countPhrase(withoutSource, "layer records", "layers record")} no source.`] : []),
		...(unlinkedLicenses.length ? [`No published text is linked for the license ${unlinkedLicenses.join(", ")}.`] : []),
		...(unlocatedSources.length ? [`The server knows no location for the source ${unlocatedSources.join(", ")}.`] : []),
	]

	return provenance.attributionRequired && credits.length
		? { links, notes, attribution: credits.join("; ") }
		: { links, notes }
}
