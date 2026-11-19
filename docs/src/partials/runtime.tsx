// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

export const NodeRequirement: React.FC = () => (
	<>
		Node.js <code>{"^24.22.3 || >=26.13.1"}</code>
	</>
)

export const ECMAScriptModuleProject: React.FC = () => (
	<>
		ECMAScript module project with <code>"type": "module"</code> in its <code>package.json</code>
	</>
)

export const CommonPrerequisites: React.FC = () => (
	<>
		<li>
			<NodeRequirement />
		</li>
		<li>
			<ECMAScriptModuleProject />
		</li>
	</>
)
