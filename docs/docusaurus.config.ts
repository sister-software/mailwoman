import type * as Preset from "@docusaurus/preset-classic"
import type { Config } from "@docusaurus/types"
import { themes as prismThemes } from "prism-react-renderer"

// This runs in Node.js — don't use client-side code here (browser APIs, JSX...)

const config: Config = {
	title: "Mailwoman",
	tagline: "TypeScript-first address parser + geocoder. Runs in Node and the browser.",
	favicon: "img/favicon.ico",

	future: {
		v4: true,
	},

	url: "https://mailwoman.sister.software",
	baseUrl: "/",

	organizationName: "sister-software",
	projectName: "mailwoman",

	onBrokenLinks: "throw",

	i18n: {
		defaultLocale: "en",
		locales: ["en"],
	},

	presets: [
		[
			"classic",
			{
				docs: {
					path: "articles",
					routeBasePath: "docs",
					sidebarPath: "./sidebars.ts",
					editUrl: "https://github.com/sister-software/mailwoman/tree/main/docs/",
				},
				// Blog is disabled until we have actual posts to ship; re-enable by passing
				// `{ showReadingTime: true, ... }` once the changelog/post pipeline is real.
				blog: false,
				theme: {
					customCss: "./src/css/custom.css",
				},
			} satisfies Preset.Options,
		],
	],

	themeConfig: {
		colorMode: {
			respectPrefersColorScheme: true,
		},
		navbar: {
			title: "Mailwoman",
			logo: {
				alt: "Mailwoman Logo",
				src: "img/logo.svg",
			},
			items: [
				{
					type: "docSidebar",
					sidebarId: "tutorialSidebar",
					position: "left",
					label: "Docs",
				},
				{
					href: "https://github.com/sister-software/mailwoman",
					label: "GitHub",
					position: "right",
				},
			],
		},
		footer: {
			style: "dark",
			links: [
				{
					title: "Docs",
					items: [
						{ label: "Plan", to: "/docs/plan" },
						{ label: "Eval reports", to: "/docs/evals/stage1-coarse-v0.1.0-vs-golden-v0.1.2" },
					],
				},
				{
					title: "More",
					items: [
						{ label: "GitHub", href: "https://github.com/sister-software/mailwoman" },
						{ label: "npm", href: "https://www.npmjs.com/package/mailwoman" },
					],
				},
			],
			copyright: `Copyright © ${new Date().getFullYear()} Sister Software.`,
		},
		prism: {
			theme: prismThemes.github,
			darkTheme: prismThemes.dracula,
		},
	} satisfies Preset.ThemeConfig,
}

export default config
