/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The body's app: the host check first, then the route. A production host serving the other body's build renders
 *   the error rather than the other world, so a misconfigured Workers Builds project is visible on its first load.
 */

import "./styles/app.css"
import { useEffect } from "react"

import { BODY_CONFIGS } from "#bodies/index"
import { assertHostMatchesBody, currentBody } from "#body"
import { routeForPath } from "#routes"

function NotFound({ pathname, title }: { pathname: string; title: string }) {
	return (
		<section className="not-found" data-testid="not-found">
			<h1>Not here</h1>
			<p>
				<code>{pathname}</code> is not a page of {title}. <a href="/">Go to the globe.</a>
			</p>
		</section>
	)
}

function WrongBody({ message }: { message: string }) {
	return (
		<section className="not-found" data-testid="wrong-body">
			<h1>Wrong world</h1>
			<p>{message}</p>
		</section>
	)
}

export function App() {
	const body = currentBody()
	const config = BODY_CONFIGS[body]

	useEffect(() => {
		document.title = config.title
	}, [config.title])

	try {
		assertHostMatchesBody(location.hostname, body)
	} catch (error) {
		return <WrongBody message={(error as Error).message} />
	}

	const route = routeForPath(location.pathname)

	if (route === null) return <NotFound pathname={location.pathname} title={config.title} />

	return (
		<main data-route={route.kind} data-body={body}>
			<h1>{config.title}</h1>
		</main>
	)
}
