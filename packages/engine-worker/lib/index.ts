// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The engine Worker's entry: `createMailwomanAPI` over {@link createEngineWorkerEngine},
 *   with the release pipeline loaded once per isolate and each gazetteer query
 *   sent to the `GAZETTEER` service binding.
 *
 *   The API Worker binds this Worker as `API_BACKEND`, so admission, CORS
 *   and rate limiting stay in the API Worker.
 */

import { createMailwomanAPI } from "@mailwoman/api"
import { buildEngineStamp } from "@mailwoman/core/license/stamp"
import type GazetteerWorker from "@mailwoman/gazetteer-worker"
import { LandmarkSource } from "@mailwoman/resolver-wof-wasm/remote/landmark"
import mailwomanPackage from "mailwoman/package.json" with { type: "json" }

import { createEngineWorkerEngine, type ReleasePipeline } from "#engine"
import { loadDefaultReleasePipeline } from "#release-pipeline"

/**
 * The bindings `wrangler.toml` declares.
 */
export interface EngineWorkerEnv {
	/**
	 * The gazetteer Worker.
	 * Its `findPlace` answers from `candidate.db` in R2.
	 */
	GAZETTEER: Service<GazetteerWorker>
}

/**
 * The isolate's pipeline load.
 * A failed load is forgotten so the next request retries it.
 */
let pipeline: Promise<ReleasePipeline> | null = null

function loadPipeline(): Promise<ReleasePipeline> {
	const loading = (pipeline ??= loadDefaultReleasePipeline())

	loading.catch(() => {
		if (pipeline === loading) {
			pipeline = null
		}
	})

	return loading
}

/**
 * The engine stamp the API attaches to every response, for the `mailwoman`
 * package version this Worker bundles.
 */
const ENGINE_STAMP = buildEngineStamp({ version: mailwomanPackage.version, expression: mailwomanPackage.license })

export default {
	fetch(request: Request, env: EngineWorkerEnv): Promise<Response> | Response {
		const engine = createEngineWorkerEngine({
			pipeline: loadPipeline,
			lookup: { findPlace: (query) => env.GAZETTEER.findPlace(query) },
			landmarkLayers: {
				landmarks: { find: (name) => env.GAZETTEER.findLandmarks(name, LandmarkSource.Wikidata) },
				osmPlaces: { find: (name) => env.GAZETTEER.findLandmarks(name, LandmarkSource.OpenStreetMap) },
			},
		})

		return createMailwomanAPI(engine, { engine: ENGINE_STAMP }).fetch(request)
	},
} satisfies ExportedHandler<EngineWorkerEnv>
