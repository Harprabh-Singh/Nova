import { proofSources, type ProofSourceId } from "../../data/proofEvidence.ts"

/**
 * RETRIEVAL stage of the trace: what was actually pulled, in rank order, with
 * department and version. Reads as an evidence register, never as chat.
 */
export function RetrievalRows({
	active,
	onFocus,
	powered,
}: {
	active: ProofSourceId | null
	onFocus: (id: ProofSourceId | null) => void
	powered: boolean
}) {
	return (
		<ol className="pfc-rows" aria-label="Retrieved evidence">
			{proofSources.map((source, index) => (
				<li
					key={source.id}
					className={`pfc-row${active === source.id ? " is-active" : ""}${powered ? " is-on" : ""}`}
					style={{ transitionDelay: `${0.08 * index}s` }}
					onMouseEnter={() => onFocus(source.id)}
					onMouseLeave={() => onFocus(null)}
				>
					<span className="pfc-row-no">{source.ref}</span>
					<span className="pfc-row-body">
						<span className="pfc-row-title">{source.title}</span>
						<span className="pfc-row-meta">
							{source.department} &middot; {source.version}
						</span>
					</span>
					<span className="pfc-row-state">{source.state}</span>
					<span className="pfc-row-bar" aria-hidden="true" />
				</li>
			))}
		</ol>
	)
}
