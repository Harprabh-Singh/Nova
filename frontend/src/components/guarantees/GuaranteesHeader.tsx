/* ============================================================================
   Masthead for the guarantee wall. The headline spans the composition — the
   grid sits underneath it, never beside it — and the support copy is pushed
   to the upper right at metadata scale so it never competes.
   ========================================================================== */

export function GuaranteesHeader() {
	return (
		<header className="gtc-head">
			<span className="gtc-kicker">What you get</span>

			{/* Two stacked lines: solid off-white, then the lime outline. That
			    contrast is the section's primary visual signature. */}
			<h2 className="gtc-title">
				<span className="solid">Built for trust.</span>
				<span className="outline">Tuned for speed.</span>
			</h2>

			<div className="gtc-head-aside">
				<p className="gtc-lede">
					Six guarantees that hold on every single answer, whoever is asking and whatever they are allowed to see.
				</p>
				<p className="gtc-tally">
					<b>06</b> guarantees <span>/</span> <b>0</b> exceptions
				</p>
			</div>

			<span className="gtc-head-rule" aria-hidden="true" />
		</header>
	)
}
