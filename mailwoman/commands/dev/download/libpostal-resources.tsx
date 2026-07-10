/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev download libpostal-resources` — refresh the checked-in libpostal dictionaries
 *   under `core/data/libpostal/dictionaries/` (shallow clone + code-point sort).
 */

import { downloadLibpostalResources } from "@mailwoman/core/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

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
