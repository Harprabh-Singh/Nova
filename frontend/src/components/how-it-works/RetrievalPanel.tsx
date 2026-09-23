/**
 * CHAPTER 03 interior — authorized sources converging on one relevant result.
 *
 * The connector lines are a single inline SVG (2D, no canvas). They draw
 * themselves toward the highlighted source when the chapter becomes active.
 */

const SOURCES = [
	{ no: "01", title: "Procurement Policy", hit: true },
	{ no: "02", title: "Approval Matrix", hit: false },
	{ no: "03", title: "Engineering SOP", hit: false },
	{ no: "04", title: "Safety Procedures", hit: false },
]

const MATCHES = ["SEMANTIC", "POLICY", "VERSION"]

export function RetrievalPanel() {
	return (
		<div className="hiw-retrieval" aria-hidden="true">
			<div className="hiw-retrieval-head">
				<span>SEMANTIC SEARCH</span>
				<span>04 AUTHORIZED</span>
			</div>
			<div className="hiw-retrieval-body">
				<svg className="hiw-retrieval-lines" viewBox="0 0 40 120" preserveAspectRatio="none">
					<path d="M40 16 C 18 16, 18 16, 2 16" />
					<path d="M40 46 C 18 46, 18 22, 2 16" />
					<path d="M40 76 C 18 76, 18 26, 2 16" />
					<path d="M40 106 C 18 106, 18 30, 2 16" />
				</svg>
				<ul className="hiw-retrieval-list">
					{SOURCES.map((source, i) => (
						<li
							key={source.no}
							className={source.hit ? "is-hit" : ""}
							style={{ "--i": i } as React.CSSProperties}
						>
							<span className="no">{source.no}</span>
							<span className="t">{source.title}</span>
							<span className="dot" />
						</li>
					))}
				</ul>
			</div>
			<div className="hiw-retrieval-matches">
				{MATCHES.map((match, i) => (
					<span key={match} style={{ "--i": i } as React.CSSProperties}>
						{match} <i>MATCH</i>
					</span>
				))}
			</div>
		</div>
	)
}
