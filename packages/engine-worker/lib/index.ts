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

import { createEngineWorkerEngine } from "#engine"
import { engineScope, ReleasePipelineService } from "#services"

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
 * The engine stamp that the API attaches to every response identifies the
 * `mailwoman` package version bundled by this Worker.
 */
const ENGINE_STAMP = buildEngineStamp({ version: mailwomanPackage.version, expression: mailwomanPackage.license })

export default {
	fetch(request: Request, env: EngineWorkerEnv): Promise<Response> | Response {
		const engine = createEngineWorkerEngine({
			pipeline: () => engineScope().resolve(ReleasePipelineService),
			lookup: { findPlace: (query) => env.GAZETTEER.findPlace(query) },
			landmarkLayers: {
				landmarks: { find: (name) => env.GAZETTEER.findLandmarks(name, LandmarkSource.Wikidata) },
				osmPlaces: { find: (name) => env.GAZETTEER.findLandmarks(name, LandmarkSource.OpenStreetMap) },
			},
		})

		return createMailwomanAPI(engine, { engine: ENGINE_STAMP }).fetch(request)
	},
} satisfies ExportedHandler<EngineWorkerEnv>
