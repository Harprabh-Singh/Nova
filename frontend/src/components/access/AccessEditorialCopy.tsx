import { AccessPrinciples } from "./AccessPrinciples.tsx"

/* ============================================================================
   The identity statement, printed into the left wall of the room. This is
   the primary typographic object on the page and the product argument
   itself: the answer is a function of who is asking, so identity has to be
   resolved before anything is retrieved.
   ========================================================================== */

export function AccessEditorialCopy() {
	return (
		<section className="access-copy">
			<span className="access-kicker">
				<b>01</b>
				<s aria-hidden="true" />
				Access
			</span>

			<h1 className="access-heading" id="access-title">
				<span>The answer</span>
				<span>depends on</span>
				<span className="outline">who asks.</span>
			</h1>

			<p className="access-body">
				NOVA applies your role and clearance at retrieval time, before a single word is generated. Pick a persona and
				the same question will return a different answer — that is the point.
			</p>

			<AccessPrinciples />
		</section>
	)
}
