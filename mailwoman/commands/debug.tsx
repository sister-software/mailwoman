/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Spinner } from "@inkjs/ui"
import { Text } from "ink"
import { createAddressParser, createDiagnosticReport } from "mailwoman"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../sdk/cli.js"

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
	const [output, setOutput] = useState<string>()
	const [error, setError] = useState<string>()

	useEffect(() => {
		const parser = createAddressParser()
		const parseOpts = options.locale ? { verbose: true as const, locale: options.locale } : { verbose: true as const }

		parser
			.parse(args[0]!, parseOpts)
			.then(createDiagnosticReport)
			.then(setOutput)
			.catch((err) => setError(err.message))

		return
	}, [args, options.locale])

	if (error) {
		return <Text color="red">{error}</Text>
	}

	if (!output) {
		return <Spinner />
	}

	return <Text>{output}</Text>
}

export default DebugCommand
