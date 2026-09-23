/* ============================================================================
   The words on the wall. Two lines, solid off-white — no outline here: every
   earlier section used the outlined pairing, so the closing headline reads as
   the one decisive statement on the page.

   The reflection is an aria-hidden copy of the same text, flipped and faded
   into the floor. It is a duplicate for the eye only; screen readers get the
   heading once.
   ========================================================================== */

export function FinalCtaHeading() {
	return (
		<div className="fct-heading-wrap">
			<h2 className="fct-heading" id="fct-title">
				<span>Ask your first</span>
				<span>Question</span>
			</h2>

			<p className="fct-heading-echo" aria-hidden="true">
				<span>Ask your first</span>
				<span>Question</span>
			</p>
		</div>
	)
}
