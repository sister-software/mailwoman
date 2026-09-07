/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Emit `build.json` beside a Vite bundle: the static deployment record a production smoke fetches instead of a
 *   health endpoint. The revision is the repository's HEAD at build; Workers Builds checks out the commit it deploys.
 */

import { gitHead } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import { isoSeconds } from "@mailwoman/core/utils"
import type { Plugin } from "vite"

import { renderBuildInfo } from "#build-info"

export function buildInfoPlugin(options: { app: string }): Plugin {
	return {
		name: "mailwoman-build-info",
		async generateBundle() {
			const revision = await gitHead(repoRootPath(), { short: true })

			this.emitFile({
				type: "asset",
				fileName: "build.json",
				source: renderBuildInfo({ app: options.app, revision, buildTime: isoSeconds() }),
			})
		},
	}
}
