// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Downloads the Koppen-Geiger climate classification the facade crate samples per building: Beck et al. 2023,
 *   "High-resolution (1 km) Koppen-Geiger maps for 1901-2099 based on constrained CMIP6 projections", Scientific
 *   Data 10, 724, CC BY 4.0. The 0.1 degree map of the 1991-2020 period, `koppen_geiger_0p1.tif`, is the layer
 *   `hrt-facade` reads: one byte per cell, class 1 to 30, 0 for ocean.
 *
 *   Usage: node packages/structures/sdk/koppen/fetch.run.ts --out <dir> [--url <archive url>]
 *
 *   Data transfers run on AWS, never on the lab host. The script writes the archive and its SHA-256 beside it, and
 *   stops there: the conversion to the crate's grid is the next step, once the archive's checksum is recorded under
 *   `packages/structures/data/licenses/` with the publisher's terms, per `packages/structures/AGENTS.md`.
 */

import { writeLocalBuffer, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

/**
 * The publisher's landing page.
 *
 * It links the figshare archive holding `koppen_geiger_0p1.tif`.
 * The archive URL is passed in rather than fixed, because figshare file ids change with each version.
 */
const LANDING_PAGE = "https://www.gloh2o.org/koppen/"

const { values } = parseArguments({
	options: {
		out: { type: "string" },
		url: { type: "string" },
		verbose: { type: "boolean", default: false },
	},
})

if (!values.out || !values.url) {
	console.error(`Usage: node packages/structures/sdk/koppen/fetch.run.ts --out <dir> --url <archive url>`)

	console.error(`The archive URL comes from ${LANDING_PAGE}. The 0.1 degree 1991-2020 map is the file wanted.`)

	process.exit(2)
}

const response = await fetch(values.url)

if (!response.ok) {
	throw new Error(`${values.url} answered ${response.status}`)
}

const bytes = new Uint8Array(await response.arrayBuffer())
const sha256 = sha256Hex(bytes)
const archive = values.url.split("/").at(-1) || "koppen_geiger.zip"

await writeLocalBuffer(bytes, values.out, archive)
await writeLocalTextFile(`${sha256}  ${archive}\n`, values.out, `${archive}.sha256`)

console.log(`${bytes.length} bytes written to ${values.out}/${archive}, sha256 ${sha256}`)

if (values.verbose) {
	console.log(`source: ${LANDING_PAGE}, license CC BY 4.0, attribution "Beck et al. (2023), Scientific Data 10, 724"`)
}
