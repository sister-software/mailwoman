import GlossaryTerm from "@theme-original/GlossaryTerm"
import React from "react"

const GlossaryTermWrapper: React.FC = (props) => {
	return (
		<span className="glossary-term-wrapper">
			<GlossaryTerm {...props} />
		</span>
	)
}

export default GlossaryTermWrapper
