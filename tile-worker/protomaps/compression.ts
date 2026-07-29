// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Compression, type DecompressFunc } from "pmtiles"

export const decompressPMTileBuffer: DecompressFunc = async (buf, compression) => {
	if (compression === Compression.None || compression === Compression.Unknown) {
		return buf
	}

	if (compression === Compression.Gzip) {
		const stream = new Response(buf).body
		const result = stream?.pipeThrough(new DecompressionStream("gzip"))

		return new Response(result).arrayBuffer()
	}

	throw new Error("Compression method not supported")
}
