/* ============================================================================
   Closing statement for the wall. A long dark strip — the same material as
   the charcoal plaques, mounted with the same hard shadow — carrying the
   final claim and the one live action in the section.
   ========================================================================== */

export function GuaranteeFooter({ onEnter }: { onEnter: () => void }) {
	return (
		<div className="gtc-foot">
			<div className="gtc-foot-strip">
				<p className="gtc-foot-copy">
					All six hold on <span>every</span> answer — not just the easy ones.
				</p>
				<button className="gtc-foot-cta" type="button" onClick={onEnter}>
					See it answer <span aria-hidden="true">→</span>
				</button>
			</div>

			<div className="gtc-foot-meta">
				<span>NOVA // Guarantees</span>
				<span>Secure / Private / Verifiable / Yours</span>
			</div>
		</div>
	)
}
