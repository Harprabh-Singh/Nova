import type { WorkflowStep } from "../../data/workflowSteps.ts"

/**
 * Editorial progress rail — not a carousel.
 *
 * No dots-and-arrows chrome and no "1 / 5" counter: a single hairline with the
 * five chapter names printed underneath it, and one small lime signal that
 * travels with the reader. The markers double as the keyboard navigation for
 * the whole section.
 */

type Props = {
	steps: WorkflowStep[]
	active: number
	onSelect: (index: number) => void
}

export function WorkflowProgress({ steps, active, onSelect }: Props) {
	return (
		<nav className="hiw-progress" aria-label="How it works chapters">
			<span className="hiw-progress-hint">
				Drag / swipe / scroll <i>→</i>
			</span>
			<ol className="hiw-progress-rail">
				<span className="hiw-progress-line" aria-hidden="true">
					<i />
				</span>
				{steps.map((step, index) => (
					<li key={step.id} className={index === active ? "is-active" : index < active ? "is-passed" : ""}>
						<button
							type="button"
							onClick={() => onSelect(index)}
							aria-current={index === active ? "step" : undefined}
						>
							<span className="mark" aria-hidden="true" />
							<span className="no">{step.id}</span>
							<span className="name">{step.label}</span>
						</button>
					</li>
				))}
			</ol>
		</nav>
	)
}
