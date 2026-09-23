import { forwardRef } from "react"
import type { WorkflowStep } from "../../data/workflowSteps.ts"
import { WorkflowCard } from "./WorkflowCard.tsx"

/**
 * The rail the five chapters live on.
 *
 * On desktop the track is transform-driven: the section is pinned and vertical
 * scroll progress is written straight to `translate3d`, so no React render
 * happens per frame. On mobile the same markup becomes a native scroll-snap
 * strip, because forcing vertical-to-horizontal mapping onto a phone makes the
 * interaction worse.
 */

type Props = {
	steps: WorkflowStep[]
	active: number
	onActivate: (index: number) => void
}

export const WorkflowTrack = forwardRef<HTMLDivElement, Props>(function WorkflowTrack(
	{ steps, active, onActivate },
	ref,
) {
	return (
		<div className="hiw-track" ref={ref}>
			{steps.map((step, index) => (
				<WorkflowCard
					key={step.id}
					step={step}
					index={index}
					active={index === active}
					passed={index < active}
					onActivate={onActivate}
				/>
			))}
			<span className="hiw-track-tail" aria-hidden="true" />
		</div>
	)
})
