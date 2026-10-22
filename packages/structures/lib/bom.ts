/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The CycloneDX `data` component of a published basemap archive, built from the structure-source register.
 *
 *   The release data BOM in `mailwoman/data/bom` lists what a mailwoman release delivers. A basemap archive is served
 *   to the map, so its component is built here, in the same shape, from the register entries of the sources the
 *   archive was built from.
 */

import { electedLicenseLabel } from "@mailwoman/core/license/decision"
import type { DataBOMComponent } from "mailwoman/data/bom"

import { BASEMAP_INPUTS, type Basemap } from "#basemaps"
import { STRUCTURE_SOURCE_REGISTER } from "#register"
import type { StructureSourceRegister } from "#types"

/**
 * One published basemap archive.
 */
export interface BasemapArchive {
	basemap: Basemap
	/**
	 * The archive's public URL.
	 */
	url: string
	/**
	 * The archive's build identifier, such as its date or the commit of the build profile.
	 */
	version: string
	/**
	 * The database license the archive is distributed under, as an SPDX expression.
	 *
	 * An archive built from ODbL sources is a derivative database and is distributed under `ODbL-1.0`.
	 */
	license: string
}

/**
 * The archive's `data` component, with one property per input naming its elected license and its credit.
 *
 * An input whose decision is still unchecked or refused records `unelected` with
 * its review state, so the component shows the open review.
 */
export function basemapBOMComponent(
	archive: BasemapArchive,
	register: StructureSourceRegister = STRUCTURE_SOURCE_REGISTER
): DataBOMComponent {
	const inputs = BASEMAP_INPUTS[archive.basemap].map((sourceID) => {
		const source = register.sources.find((entry) => entry.sourceID === sourceID)

		if (!source) throw new Error(`basemap input ${sourceID} is not in the structure-source register`)

		const decision = register.licenses.find((entry) => entry.licenseID === source.license)
		const label = decision ? (electedLicenseLabel(decision) ?? `unelected (${decision.state})`) : "undeclared"

		return { source, label }
	})

	return {
		type: "data",
		"bom-ref": `basemap/${archive.url}`,
		name: archive.url,
		version: archive.version,
		description: `Basemap archive (${archive.basemap}) built from ${inputs.length} register sources`,
		licenses: [{ expression: archive.license }],
		externalReferences: [{ type: "distribution", url: archive.url }],
		properties: inputs.flatMap(({ source, label }) => [
			{ name: `mailwoman:input:${source.sourceID}:license`, value: label },
			...(source.attribution
				? [{ name: `mailwoman:input:${source.sourceID}:attribution`, value: source.attribution }]
				: []),
		]),
	}
}
