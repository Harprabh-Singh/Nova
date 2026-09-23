/* ============================================================================
   The two doors. Primary dominates; the secondary carries the same footprint
   but inverted material, so the choice is obvious without shouting.

   Both are real routes — /chat (via the page's session-aware entry helper)
   and /onboarding. No dead buttons.
   ========================================================================== */

export function FinalCtaButtons({
	onEnter,
	onOnboard,
}: {
	onEnter: () => void
	onOnboard: () => void
}) {
	return (
		<div className="fct-cta">
			<button type="button" className="fct-btn primary" onClick={onEnter}>
				<span>Enter the demo</span>
				<span className="fct-btn-arrow" aria-hidden="true">
					→
				</span>
			</button>

			<button type="button" className="fct-btn secondary" onClick={onOnboard}>
				<span>Onboard your company</span>
			</button>
		</div>
	)
}
