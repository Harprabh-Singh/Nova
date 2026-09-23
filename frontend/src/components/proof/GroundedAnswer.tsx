import { proofAnswer } from "../../data/proofEvidence.ts"

/**
 * GROUNDED ANSWER. It arrives last, after retrieval and authorization, and it
 * is deliberately short: the weight of the section sits on the evidence above
 * it, not on the sentence.
 */
export function GroundedAnswer({ powered }: { powered: boolean }) {
	return (
		<div className={`pfc-answer${powered ? " is-on" : ""}`}>
			<p className="pfc-answer-text">{proofAnswer}</p>
			<span className="pfc-answer-rule" aria-hidden="true" />
		</div>
	)
}
