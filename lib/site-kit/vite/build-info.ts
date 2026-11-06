/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Emit `build.json` beside a Vite bundle: the static deployment record a production smoke fetches instead of a
 *   health endpoint. The revision is the repository's head at build. Workers Builds checks out the commit it deploys.
 */

import { gitHead } from "@mailwoman/core/git"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { isoSeconds } from "@mailwoman/core/utils"
import type { Plugin } from "vite"

import { renderBuildInfo } from "#site-kit/build-info"

/**
 * The global a site's bundles read the build's short commit from, defined by {@linkcode buildCommitDefine}.
 *
 * `vite-plugin-pwa` builds the service worker with the main config's `define`, so the worker reads it too.
 */
export const BUILD_COMMIT_GLOBAL = "__MAILWOMAN_BUILD_COMMIT__"

/**
 * The `define` entry that sets {@linkcode BUILD_COMMIT_GLOBAL} to the repository's short head at build.
 */
export async function buildCommitDefine(): Promise<Record<string, string>> {
	return { [BUILD_COMMIT_GLOBAL]: stringifyJSON(await gitHead(repoRootPath(), { short: true })) }
}

export function buildInfoPlugin(options: { app: string }): Plugin {
	return {
		name: "mailwoman-build-info",
		async generateBundle() {
			const root = repoRootPath()
			const [revision, commit] = await Promise.all([gitHead(root, { short: true }), gitHead(root)])

			this.emitFile({
				type: "asset",
				fileName: "build.json",
				source: renderBuildInfo({ app: options.app, revision, commit, buildTime: isoSeconds() }),
			})
		},
	}
}
