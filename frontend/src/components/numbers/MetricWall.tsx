import { metrics } from "../../data/metrics.ts"
import { MetricPanel } from "./MetricPanel.tsx"

/* ============================================================================
   The wall. Four bays sharing hairline dividers and one continuous baseline,
   framed by thin structural uprights so it reads as architecture rather than
   as a row of metric cards.
   ========================================================================== */

export function MetricWall() {
	return (
		<div className="nbr-wall">
			<span className="nbr-wall-upright left" aria-hidden="true" />
			<span className="nbr-wall-upright right" aria-hidden="true" />

			<div className="nbr-bays">
				{metrics.map((metric, i) => (
					<MetricPanel key={metric.id} metric={metric} index={i} />
				))}
			</div>

			{/* Baseline plus the faint reflection that ties the wall to the floor. */}
			<span className="nbr-wall-base" aria-hidden="true" />
			<span className="nbr-wall-reflect" aria-hidden="true" />
		</div>
	)
}
