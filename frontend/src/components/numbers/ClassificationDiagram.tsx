/* ============================================================================
   Bay 03 — classification ladder. The four tiers the backend actually
   enforces, resolved before retrieval runs. RESTRICTED reads as the enforced
   ceiling and carries the lime marker.
   ========================================================================== */

const TIERS = ["Public", "Internal", "Confidential", "Restricted"]

export function ClassificationDiagram() {
	return (
		<div className="nbr-dia nbr-dia-access" aria-hidden="true">
			<ul className="nbr-ladder">
				{TIERS.map((tier, i) => (
					<li
						key={tier}
						className={"nbr-tier" + (i === TIERS.length - 1 ? " is-ceiling" : "")}
						style={{ "--d": `${i * 80}ms`, "--fill": `${((i + 1) / TIERS.length) * 100}%` } as React.CSSProperties}
					>
						<span className="nbr-tier-bar" />
						<span className="nbr-tier-name">{tier}</span>
						<span className="nbr-tier-dot" />
					</li>
				))}
			</ul>
			<p className="nbr-aside">
				Right context.
				<br />
				Right people.
			</p>
		</div>
	)
}
