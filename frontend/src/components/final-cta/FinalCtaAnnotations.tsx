/* ============================================================================
   Wall annotations. Small technical type set against the two side walls —
   present, but never competing with the headline. Hidden on mobile, where the
   composition is recomposed as a single column.
   ========================================================================== */

const LEFT = ["Your", "knowledge", "should", "work", "harder."]
const RIGHT = ["Same", "answers.", "Higher", "standards."]

export function FinalCtaAnnotations() {
	return (
		<div className="fct-annotations" aria-hidden="true">
			<p className="fct-annotation left">
				{LEFT.map((line) => (
					<span key={line}>{line}</span>
				))}
			</p>

			<p className="fct-annotation right">
				{RIGHT.map((line) => (
					<span key={line}>{line}</span>
				))}
			</p>
		</div>
	)
}
