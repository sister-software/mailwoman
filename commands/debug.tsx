// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { Spinner } from "@inkjs/ui"
import { Text } from "ink"
import { createAddressParser, createDiagnosticReport } from "mailwoman"
import { PositionalCommandComponent } from "mailwoman/sdk/cli"
import { useEffect, useState } from "react"
import zod from "zod"

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
