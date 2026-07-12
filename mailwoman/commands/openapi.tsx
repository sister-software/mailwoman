/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman openapi` — print (or `--out`-write) the emitted OpenAPI document for the native
 *   `@mailwoman/api` `/v1/*` surface, mirroring the `openapi` subcommand every drop-in CLI carries
 *   (`mailwoman-libpostal openapi`, `mailwoman-photon openapi`, `mailwoman-nominatim openapi`).
 *   Builds the app around a stub engine (`{}` — every `MailwomanAPIEngine` method is optional) so
 *   this NEVER boots the real parser/resolver stack: pure route-table introspection, fast regardless
 *   of data-root state. `--flavor 3.0` prints the 3.0.3 diet (client generators that lag, e.g.
 *   progenitor) instead of the default 3.1.0.
 */

import { createMailwomanAPI, MAILWOMAN_API_DOC_INFO } from "@mailwoman/api"
import { printOpenAPIDocument } from "@mailwoman/api-kit"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../cli-kit/index.ts"

export const description = "Emit the native @mailwoman/api OpenAPI document"

const OptionsSchema = zod.object({
	flavor: zod.enum(["3.1", "3.0"]).default("3.1").describe("OpenAPI flavor: 3.1.0 (default) or the 3.0.3 diet"),
	out: zod.string().optional().describe("Write to this path instead of stdout"),
})

export { OptionsSchema as options }

const Openapi: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const app = createMailwomanAPI({})

		printOpenAPIDocument(app, MAILWOMAN_API_DOC_INFO, options)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// printOpenAPIDocument itself writes to stdout or the --out path.
	return null
}

export default Openapi
