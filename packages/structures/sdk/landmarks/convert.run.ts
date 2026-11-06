// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Downloads each converted landmark's model from its `sourceURL`, resolving a Sketchfab page through
 *   `SKETCHFAB_API_KEY`, converts it with `convertLandmarkModel`, and
 *   writes it gzipped to `<out>/<model path>`, such as `<out>/landmarks/eiffel-tower.glb`.
 *
 *   Usage: node packages/structures/sdk/landmarks/convert.run.ts --out <dir> [--landmark <id> ...]
 *
 *   Upload `<out>/landmarks/` to the tiles bucket's `landmarks/` prefix with each object's `Content-Encoding` set to
 *   `gzip`. The tile worker serves the stored bytes with that encoding.
 */

import { gzip } from "@mailwoman/core/fs/compression"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalBuffer } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"

import { isGLBLandmark, type Landmark } from "#landmarks"
import { convertLandmarkModel } from "#sdk/landmarks"
import { resolveModelDownloadURL } from "#sdk/landmarks/sketchfab"

const { values } = parseArguments({
	options: {
		out: { type: "string" },
		landmark: { type: "string", multiple: true },
	},
})

if (!values.out) throw new Error("usage: convert.run.ts --out <dir> [--landmark <id> ...]")

const landmarks = await readLocalJSONFile<Landmark[]>(
	resolvePackagePath("@mailwoman/structures", "data", "landmarks.json")
)

const chosen = landmarks
	.filter(isGLBLandmark)
	.filter((landmark) => !values.landmark?.length || values.landmark.includes(landmark.id))

for (const landmark of chosen) {
	const response = await fetch(await resolveModelDownloadURL(landmark.model.sourceURL), {
		headers: { "User-Agent": "mailwoman-landmarks (+https://github.com/sister-software/mailwoman)" },
	})

	if (!response.ok) throw new Error(`${landmark.id}: ${landmark.model.sourceURL} answered ${response.status}`)

	const source = new Uint8Array(await response.arrayBuffer())
	const converted = convertLandmarkModel(source, landmark.height)
	const stored = await gzip(converted.glb)

	await writeLocalBuffer(stored, values.out, landmark.model.path)

	console.log(
		stringifyJSON({
			id: landmark.id,
			sourceBytes: source.byteLength,
			sourcePrimitives: converted.sourcePrimitives,
			sourceVertices: converted.sourceVertices,
			sourceHeight: converted.sourceHeight,
			vertices: converted.vertices,
			triangles: converted.triangles,
			min: converted.min,
			max: converted.max,
			bytes: converted.glb.byteLength,
			gzippedBytes: stored.byteLength,
		})
	)
}
