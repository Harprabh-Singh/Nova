/* ============================================================================
   Masthead for the evidence wall. Same typographic signature as the rest of
   the site — solid off-white against a thin lime outline — spanning the full
   composition, with the support copy pushed right at metadata scale.
   ========================================================================== */

export function NumbersHeader() {
	return (
		<header className="nbr-head">
			<span className="nbr-kicker">By the numbers</span>

			<h2 className="nbr-title" id="nbr-title">
				<span className="solid">Engineered</span>
				<span className="outline">to be believed.</span>
			</h2>

			<div className="nbr-head-aside">
				<p className="nbr-lede">The same evidence should produce the same answer.</p>
				<p className="nbr-sig">Measured / Traceable / Versioned / Local-first</p>
			</div>

			<span className="nbr-head-rule" aria-hidden="true" />
		</header>
	)
}
