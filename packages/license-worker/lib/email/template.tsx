/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The HTML body as a React tree over react-email's components, which carry the table layout and inline styles mail
 *   clients need. It renders the sections `content.ts` decides and adds no copy of its own. Styles are inline objects:
 *   mail clients drop stylesheets.
 */

import { Body, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from "@react-email/components"
import type React from "react"

import type { EmailBlock, EmailSection } from "#email/content"

const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
const INK = "#1f2328"
const MUTED = "#57606a"
const RULE = "#d0d7de"
const PAPER = "#f6f8fa"

const styles = {
	body: { backgroundColor: "#ffffff", color: INK, fontFamily: FONT, margin: 0, padding: "24px 0" },
	container: { maxWidth: "600px", margin: "0 auto", padding: "0 24px" },
	title: { fontSize: "22px", fontWeight: 600, lineHeight: "30px", margin: "0 0 16px" },
	heading: { fontSize: "16px", fontWeight: 600, lineHeight: "24px", margin: "24px 0 8px" },
	text: { fontSize: "15px", lineHeight: "23px", margin: "0 0 12px" },
	code: {
		backgroundColor: PAPER,
		border: `1px solid ${RULE}`,
		borderRadius: "6px",
		color: INK,
		fontFamily: MONO,
		fontSize: "13px",
		lineHeight: "20px",
		margin: "0 0 12px",
		overflowWrap: "anywhere",
		padding: "12px",
		whiteSpace: "pre-wrap",
	},
	factLabel: { color: MUTED, fontSize: "13px", lineHeight: "20px", margin: 0, paddingRight: "16px" },
	factValue: { fontSize: "15px", lineHeight: "20px", margin: 0 },
	link: { color: "#0969da", fontSize: "15px", lineHeight: "23px" },
	rule: { borderColor: RULE, margin: "20px 0" },
	footer: { color: MUTED, fontSize: "13px", lineHeight: "20px", margin: "16px 0 0" },
} as const satisfies Record<string, React.CSSProperties>

const Block: React.FC<{ block: EmailBlock }> = ({ block }) => {
	switch (block.kind) {
		case "paragraph":
			return <Text style={styles.text}>{block.text}</Text>
		case "code":
			return <pre style={styles.code}>{block.text}</pre>
		case "link":
			return (
				<Text style={styles.text}>
					<Link href={block.url} style={styles.link}>
						{block.label}
					</Link>
				</Text>
			)
		case "facts":
			return (
				<table cellPadding={0} cellSpacing={0} role="presentation" style={{ margin: "0 0 12px" }}>
					<tbody>
						{block.rows.map(([label, value]) => (
							<tr key={label}>
								<td style={styles.factLabel}>{label}</td>
								<td style={styles.factValue}>{value}</td>
							</tr>
						))}
					</tbody>
				</table>
			)
		default:
			return null
	}
}

export interface LicenseEmailTemplateProps {
	title: string
	preview: string
	sections: EmailSection[]
	/**
	 * The sender's address, in the footer, so a reply has somewhere to go.
	 */
	from: string
}

export const LicenseEmailTemplate: React.FC<LicenseEmailTemplateProps> = ({ title, preview, sections, from }) => (
	<Html lang="en">
		<Head />
		<Preview>{preview}</Preview>
		<Body style={styles.body}>
			<Container style={styles.container}>
				<Heading as="h1" style={styles.title}>
					{title}
				</Heading>
				{sections.map((section, index) => (
					<Section key={section.heading ?? index}>
						{section.heading ? (
							<Heading as="h2" style={styles.heading}>
								{section.heading}
							</Heading>
						) : null}
						{section.blocks.map((block, blockIndex) => (
							<Block key={blockIndex} block={block} />
						))}
					</Section>
				))}
				<Hr style={styles.rule} />
				<Text style={styles.footer}>Sent by Sister Software from {from}. Replies reach a person.</Text>
			</Container>
		</Body>
	</Html>
)
