import { GuaranteeCard } from "./GuaranteeCard.tsx"
import { guarantees } from "../../data/guarantees.ts"

/* ============================================================================
   The wall itself: 3 × 2 on desktop, 2 × 3 on tablet, a single column on
   phones. Disciplined columns, with per-card vertical offsets coming from the
   data so the rows read as mounted plaques rather than a card gallery.
   ========================================================================== */

export function GuaranteeGrid() {
	return (
		<div className="gtc-grid">
			{guarantees.map((guarantee, index) => (
				<GuaranteeCard key={guarantee.id} guarantee={guarantee} index={index} />
			))}
		</div>
	)
}
