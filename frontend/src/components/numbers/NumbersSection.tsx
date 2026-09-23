import { NumbersHeader } from "./NumbersHeader.tsx"
import { MetricWall } from "./MetricWall.tsx"
import { NumbersFooter } from "./NumbersFooter.tsx"
import "../../styles/numbers.css"

/* ============================================================================
   NOVA — THE EVIDENCE WALL ("By the numbers")

   The chapter after the guarantee grid. Where that section said what NOVA
   promises, this one shows the engineering underneath it, so the register
   drops: darker room, fewer objects, one continuous wall of four bays instead
   of six separate plaques.

   The handover is deliberate. The guarantee grid's hairline card borders keep
   running down into this section as structural uprights, the survey grid stays
   on the same 120px module, and the background only lifts once the headline
   has landed. No hard cut, no new environment.

   Every number on this wall is checked against the implementation — see the
   header of data/metrics.ts. Nothing here is a marketing statistic.

   No 3D: depth is layering, shadow, scale and a slow parallax on the room.
   ========================================================================== */

export function NumbersSection() {
	return (
		<section className="nbr" id="numbers" aria-labelledby="nbr-title">
			{/* The room. Decorative only, all CSS. */}
			<div className="nbr-env" aria-hidden="true">
				<div className="nbr-env-image" />
				<div className="nbr-env-grade" />
				<div className="nbr-env-shaft" />
				<div className="nbr-env-columns" />
				<div className="nbr-env-grid" />
				<div className="nbr-env-floor" />
				<div className="nbr-env-vignette" />
				<div className="nbr-env-grain" />
			</div>

			{/* Carries the guarantee grid's vertical rules down into this room so
			    the two sections read as one continuous wall. */}
			<div className="nbr-seam" aria-hidden="true" />

			<div className="nbr-inner">
				<NumbersHeader />
				<MetricWall />
				<NumbersFooter />
			</div>
		</section>
	)
}
