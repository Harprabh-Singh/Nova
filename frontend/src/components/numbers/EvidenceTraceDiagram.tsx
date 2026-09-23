/* ============================================================================
   Bay 01 — source trace. One answer node bracketed down to the three records
   it was reconciled against. Flat 2D SVG, no chart, no axes.
   ========================================================================== */

const SOURCES = [
	{ marker: "01", name: "Procurement Policy" },
	{ marker: "02", name: "Approval Matrix" },
	{ marker: "03", name: "Role Permissions" },
]

export function EvidenceTraceDiagram() {
	return (
		<svg className="nbr-dia nbr-dia-evidence" viewBox="0 0 260 126" role="presentation" aria-hidden="true">
			{/* the answer */}
			<rect className="nbr-node" x="0.5" y="0.5" width="92" height="22" />
			<text className="nbr-t nbr-t-key" x="10" y="15">
				ANSWER
			</text>

			{/* the bracket down into the evidence */}
			<path className="nbr-wire nbr-wire-trunk" d="M14 23 V 110" />
			{SOURCES.map((source, i) => {
				const y = 46 + i * 32
				return (
					<g key={source.marker} className="nbr-branch" style={{ "--d": `${i * 90}ms` } as React.CSSProperties}>
						<path className="nbr-wire" d={`M14 ${y} H 34`} />
						<text className="nbr-t nbr-t-marker" x="40" y={y + 4}>
							[{source.marker}]
						</text>
						<text className="nbr-t nbr-t-src" x="76" y={y + 4}>
							{source.name}
						</text>
						<circle className="nbr-dot" cx="14" cy={y} r="2" />
					</g>
				)
			})}
		</svg>
	)
}
