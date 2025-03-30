// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Spinner } from "@inkjs/ui"
import { Text } from "ink"
import { createAddressParser, createDiagnosticReport } from "mailwoman"
import { CommandComponent } from "mailwoman/sdk/cli"
import { useEffect, useState } from "react"
import zod from "zod"

const ArgumentsSchema = zod.array(zod.string().describe("A formatted postal address"))
export { ArgumentsSchema as args, ParseConfigSchema as options }

const ParseConfigSchema = zod.object({
	debug: zod.boolean().optional().default(false).describe("Enable verbose debugging output"),
})

const ParseCommand: CommandComponent<typeof ParseConfigSchema, typeof ArgumentsSchema> = ({ options, args }) => {
	const [output, setOutput] = useState<string>()
	const [error, setError] = useState<string>()

	useEffect(() => {
		const parser = createAddressParser()
		const input = args[0]!

		if (options.debug) {
			parser
				.parse(input, { verbose: true })
				.then(createDiagnosticReport)
				.then(setOutput)
				.catch((err) => setError(err.message))
		} else {
			parser
				.parse(input)
				.then((results) => setOutput(JSON.stringify(results, null, 2)))
				.catch((err) => setError(err.message))
		}
	}, [args, options.debug])

	if (error) {
		return <Text color="red">{error}</Text>
	}

	if (!output) {
		return <Spinner />
	}

	return <Text>{output}</Text>
}

export default ParseCommand
