import type { CSSProperties } from "react"
import type { WorkflowStep } from "../../data/workflowSteps.ts"
import { DocumentStack } from "./DocumentStack.tsx"
import { IdentityPanel } from "./IdentityPanel.tsx"
import { RetrievalPanel } from "./RetrievalPanel.tsx"
import { GroundingPanel } from "./GroundingPanel.tsx"
import { ActionPanel } from "./ActionPanel.tsx"

/**
 * One chapter of the journey.
 *
 * A large architectural information panel: dark translucent material, one thin
 * accent edge, editorial chapter numbering, and a small live system inside.
 * Nothing here is an image — every interior is HTML/SVG so it stays crisp,
 * selectable and readable by assistive technology.
 */

const VISUALS = {
	documents: DocumentStack,
	identity: IdentityPanel,
	retrieval: RetrievalPanel,
	grounding: GroundingPanel,
	action: ActionPanel,
} as const

type Props = {
	step: WorkflowStep
	index: number
	active: boolean
	passed: boolean
	onActivate: (index: number) => void
}

export function WorkflowCard({ step, index, active, passed, onActivate }: Props) {
	const Visual = VISUALS[step.visual]

	return (
		<article
			className={`hiw-card${active ? " is-active" : ""}${passed ? " is-passed" : ""}`}
			data-accent={step.accent}
			data-index={index}
			style={
				{
					"--rot": `${step.rotate}deg`,
					"--off": `${step.offset}vh`,
				} as CSSProperties
			}
			tabIndex={0}
			aria-current={active ? "step" : undefined}
			aria-label={`Chapter ${step.id}, ${step.label}`}
			onFocus={() => onActivate(index)}
		>
			<span className="hiw-card-edge" aria-hidden="true" />

			<header className="hiw-card-head">
				<span className="hiw-card-no" aria-hidden="true">
					{step.id}
				</span>
				<span className="hiw-card-label">{step.label}</span>
			</header>

			<h3 className="hiw-card-title">{step.title}</h3>

			<div className="hiw-card-copy">
				{step.body.map((line) => (
					<p key={line}>{line}</p>
				))}
			</div>

			<div className="hiw-card-visual">
				<Visual />
			</div>

			<footer className="hiw-card-meta">
				{step.meta.map((item) => (
					<span key={item}>{item}</span>
				))}
			</footer>

			<span className="hiw-card-stamp" aria-hidden="true">
				{step.stamp}
			</span>
		</article>
	)
}
