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
import { PositionalCommandComponent } from "../sdk/cli.js"

const ArgumentsSchema = zod.array(zod.string().describe("A formatted postal address"))
export { ArgumentsSchema as args }

const DebugCommand: PositionalCommandComponent<typeof ArgumentsSchema> = ({ args }) => {
	const [output, setOutput] = useState<string>()
	const [error, setError] = useState<string>()

	useEffect(() => {
		const parser = createAddressParser()

		parser
			.parse(args[0]!, { verbose: true })
			.then(createDiagnosticReport)
			.then(setOutput)
			.catch((err) => setError(err.message))

		return
	}, [args])

	if (error) {
		return <Text color="red">{error}</Text>
	}

	if (!output) {
		return <Spinner />
	}

	return <Text>{output}</Text>
}

export default DebugCommand
