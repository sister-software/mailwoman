/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Spinner } from "@inkjs/ui"
import { Text } from "ink"
import { createAddressParser, createDiagnosticReport } from "mailwoman"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../cli-kit/index.ts"

const ArgumentsSchema = zod.array(zod.string().describe("A formatted postal address"))
const DebugConfigSchema = zod.object({
	locale: zod
		.string()
		.regex(/^[a-z]{2}(-[A-Z]{2})?$/u, "Expected a BCP-47 tag like en-US or fr-FR")
		.optional()
		.describe("BCP-47 locale tag (e.g. en-US, fr-FR). Reserved for the upcoming neural pipeline."),
})
export { ArgumentsSchema as args, DebugConfigSchema as options }

const DebugCommand: CommandComponent<typeof DebugConfigSchema, typeof ArgumentsSchema> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const parser = createAddressParser()
		const parseOpts = options.locale ? { verbose: true as const, locale: options.locale } : { verbose: true as const }

		return parser.parse(args[0]!, parseOpts).then(createDiagnosticReport)
	})

	if (state.status === "error") {
		return <Text color="red">{state.message}</Text>
	}

	if (state.status !== "done") {
		return <Spinner />
	}

	return <Text>{state.result}</Text>
}

export default DebugCommand
