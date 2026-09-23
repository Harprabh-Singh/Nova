/* ============================================================================
   The last rule on the page. Technical signature, brand stamp and the page
   marker — nothing else. This closes the document rather than starting a
   new block of content.
   ========================================================================== */

export function FinalCtaFooter() {
	return (
		<footer className="fct-foot">
			<span className="fct-foot-sig">Retrieval-first / Secure / Grounded / Actionable</span>

			<span className="fct-foot-stamp">
				NOVA // Enterprise Knowledge Intelligence
				<b className="fct-foot-page">01 / 01</b>
			</span>
		</footer>
	)
}
