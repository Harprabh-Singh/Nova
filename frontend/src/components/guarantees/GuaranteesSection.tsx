import { GuaranteesHeader } from "./GuaranteesHeader.tsx"
import { GuaranteeGrid } from "./GuaranteeGrid.tsx"
import { GuaranteeFooter } from "./GuaranteeFooter.tsx"
import "../../styles/guarantees.css"

/* ============================================================================
   NOVA — THE GUARANTEE GRID

   Another wall inside the same building as the hero, the proof chamber and
   the five moves: the architecture photograph again, graded darker so the
   plaques stay the strongest objects on screen, plus the same survey grid and
   the same grain.

   The section answers "what can I trust NOVA to do?", so the six panels read
   as guarantees rather than features. They are intentionally quiet — icon,
   number, title, copy, metadata and nothing else. All of the richness comes
   from material, shadow, spacing, light and the weight of the hover.

   No 3D anywhere: the depth is hard offset shadows and lift, nothing more.
   ========================================================================== */

export function GuaranteesSection({ onEnter }: { onEnter: () => void }) {
	return (
		<section className="gtc" id="capabilities" aria-labelledby="gtc-title">
			{/* The room. Purely decorative layers, all CSS. */}
			<div className="gtc-env" aria-hidden="true">
				<div className="gtc-env-image" />
				<div className="gtc-env-grade" />
				<div className="gtc-env-columns" />
				<div className="gtc-env-grid" />
				<div className="gtc-env-floor" />
				<div className="gtc-env-vignette" />
				<div className="gtc-env-grain" />
			</div>

			<div className="gtc-inner">
				<GuaranteesHeader />
				<GuaranteeGrid />
				<GuaranteeFooter onEnter={onEnter} />
			</div>
		</section>
	)
}
