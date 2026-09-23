import { proofAnnotations } from "../../data/proofEvidence.ts"

type Props = {
	onEnter: () => void
}

/**
 * Technical marginalia. Same voice as the hero's annotations -- monospace,
 * tiny, surveyed -- placed in the negative space so the composition reads as
 * an engineered document rather than a marketing slide.
 *
 * The "Try it yourself" CTA lives in the same group as 01–05, directly below
 * 05 / ANSWER, so it reads as a logical continuation of the trace and never
 * overlaps with the heading typography block.
 */
export function ProofAnnotationStack({ onEnter }: Props) {
	return (
		<div className="pfc-ann-group">
			<ul className="pfc-ann-stack" aria-hidden="true">
				{proofAnnotations.map((item, index) => (
					<li key={item.id} className={`pfc-ann tone-${item.tone}`} style={{ transitionDelay: `${index * 0.05}s` }}>
						<span className="pfc-ann-tick" />
						{item.label}
					</li>
				))}
			</ul>
			<div className="pfc-ann-cta-wrap">
				<button
					type="button"
					className="pfc-ann-cta"
					onClick={onEnter}
				>
					Try it yourself <span aria-hidden="true">&rarr;</span>
				</button>
			</div>
		</div>
	)
}

export function ProofAnnotationFloats() {
	return (
		<div className="pfc-annotations">
			<span className="pfc-ann-float pfc-ann-tenant" aria-hidden="true">
				TENANT
				<b>NOVATECH MANUFACTURING</b>
			</span>
			<span className="pfc-ann-float pfc-ann-indexed" aria-hidden="true">KNOWLEDGE / INDEXED</span>

		</div>
	)
}
