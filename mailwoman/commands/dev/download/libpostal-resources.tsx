// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman dev download libpostal-resources` — refresh the checked-in libpostal dictionaries
 *   under `core/data/libpostal/dictionaries/` (shallow clone + code-point sort).
 */

import { downloadLibpostalResources } from "@mailwoman/core/tools"
import { Text } from "ink"
import { type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import zod from "zod"

const OptionsSchema = zod.object({
	force: zod.boolean().default(false).describe("Delete an existing dictionaries directory instead of erroring out"),
})

export { OptionsSchema as options }

const DevDownloadLibpostalResources: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() => downloadLibpostalResources(options, (line) => console.error(line)))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">dictionaries installed</Text>

	return null
}

export default DevDownloadLibpostalResources
