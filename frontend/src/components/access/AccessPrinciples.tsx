/* ============================================================================
   Three technical annotations, not feature cards. They state how
   authorization actually works in NOVA: the backend resolves identity and
   filters chunks before anything reaches the model.
   ========================================================================== */

const PRINCIPLES = [
	"Identity resolved before retrieval",
	"Unauthorized knowledge never reaches the model",
	"Every answer cites the document it came from",
]

export function AccessPrinciples() {
	return (
		<ul className="access-principles">
			{PRINCIPLES.map((text, index) => (
				<li key={text} className="access-principle">
					<b>{String(index + 1).padStart(2, "0")}</b>
					<i aria-hidden="true" />
					<span>{text}</span>
				</li>
			))}
		</ul>
	)
}
