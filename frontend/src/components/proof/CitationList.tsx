import { proofSources, type ProofSourceId } from "../../data/proofEvidence.ts"

/**
 * SOURCES. Every claim ends here: document, section, version. Hovering an
 * artifact in the room lights the matching citation, which is the whole point
 * of the section -- traceability you can see, not a badge that says "grounded".
 */
export function CitationList({
	active,
	onFocus,
	powered,
}: {
	active: ProofSourceId | null
	onFocus: (id: ProofSourceId | null) => void
	powered: boolean
}) {
	/* All three sources are cited: the two retrieved documents plus the live
	   permission record that authorised the answer. Provenance includes the
	   thing that decided you were allowed to see it. */
	const cited = proofSources
	return (
		<ul className={`pfc-cites${powered ? " is-on" : ""}`} aria-label="Sources">
			{cited.map((source) => (
				<li
					key={source.id}
					className={`pfc-cite${active === source.id ? " is-active" : ""}`}
					onMouseEnter={() => onFocus(source.id)}
					onMouseLeave={() => onFocus(null)}
				>
					<span className="pfc-cite-ref">[{source.ref}]</span>
					<span className="pfc-cite-body">
						<span className="pfc-cite-title">{source.title}</span>
						<span className="pfc-cite-section">&sect; {source.section}</span>
					</span>
				</li>
			))}
		</ul>
	)
}
