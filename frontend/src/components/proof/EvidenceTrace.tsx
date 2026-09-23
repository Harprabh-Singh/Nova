import { proofQuestion, type ProofSourceId } from "../../data/proofEvidence.ts"
import { RetrievalRows } from "./RetrievalRows.tsx"
import { AuthorizationBlock } from "./AuthorizationBlock.tsx"
import { GroundedAnswer } from "./GroundedAnswer.tsx"
import { CitationList } from "./CitationList.tsx"

/**
 * NOVA://ANSWER TRACE
 *
 * Explicitly NOT a chat window. There is no avatar, no bubble, no send box and
 * no typing dots. It is an evidence instrument: a query, the register of what
 * was retrieved, the clearance that allowed it, the grounded sentence, and the
 * sources it is answerable to -- in that order, because that is the order the
 * backend actually works in.
 *
 * The frame is intentionally broken: the header rail and the source column
 * extend past the panel edge and the connectors enter through it, so it reads
 * as built into the room rather than dropped on top of it.
 */
export function EvidenceTrace({
	active,
	onFocus,
	phase,
}: {
	active: ProofSourceId | null
	onFocus: (id: ProofSourceId | null) => void
	/** 0 dark, 1 frame, 2 retrieval, 3 authorization, 4 answer + sources */
	phase: number
}) {
	return (
		<article className={`pfc-trace-panel phase-${Math.min(phase, 4)}`} aria-label="NOVA answer trace">
			<header className="pfc-panel-head">
				<span className="pfc-panel-id">NOVA://ANSWER TRACE</span>
				<span className="pfc-panel-status">
					<span className="pfc-dot" aria-hidden="true" />
					Grounded
				</span>
			</header>

			<section className="pfc-stage-block pfc-query">
				<span className="pfc-stage-label">Query</span>
				<p className="pfc-query-text">{proofQuestion}</p>
			</section>

			<section className="pfc-stage-block pfc-retrieval">
				<span className="pfc-stage-label">Retrieval</span>
				<RetrievalRows active={active} onFocus={onFocus} powered={phase >= 2} />
			</section>

			<section className="pfc-stage-block pfc-authorization">
				<span className="pfc-stage-label">Authorized context</span>
				<AuthorizationBlock powered={phase >= 3} />
			</section>

			<section className="pfc-stage-block pfc-grounded">
				<span className="pfc-stage-label">Grounded answer</span>
				<GroundedAnswer powered={phase >= 4} />
			</section>

			<section className="pfc-stage-block pfc-sources">
				<span className="pfc-stage-label">Sources</span>
				<CitationList active={active} onFocus={onFocus} powered={phase >= 4} />
			</section>

			<footer className="pfc-panel-foot" aria-hidden="true">
				<span>TENANT / NOVATECH MANUFACTURING</span>
				<span>SOURCE / VERIFIED</span>
				<span>SYSTEM / LOCAL</span>
			</footer>
		</article>
	)
}
