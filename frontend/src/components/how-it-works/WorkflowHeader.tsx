/**
 * Section masthead. The headline spans the full composition — the chapters sit
 * underneath it on the same visual plane, never beside it — and stays legible
 * for the whole horizontal journey.
 */
export function WorkflowHeader() {
	return (
		<header className="hiw-head">
			<span className="hiw-kicker">How it works</span>
			{/* Two stacked lines: at display scale the phrases cannot share one
			    line without running past the right edge on wide viewports. */}
			<h2 className="hiw-title">
				<span className="solid">Five moves.</span>
				<span className="outline">Zero guesswork.</span>
			</h2>
			<p className="hiw-sub">
				Your knowledge <i>→</i> who is asking <i>→</i> what they may see <i>→</i> what evidence matters <i>→</i>{" "}
				what action happens
			</p>
		</header>
	)
}
