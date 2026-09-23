/**
 * CHAPTER 04 interior — a citation trace.
 *
 * answer ↓ source ↓ verified evidence. Kept extremely clean: one grounded
 * sentence, two references, one verification stamp.
 */

const CITATIONS = [
	{ ref: "01", title: "Procurement Policy", section: "§4.2" },
	{ ref: "02", title: "Approval Matrix", section: "§3.1" },
]

export function GroundingPanel() {
	return (
		<div className="hiw-ground" aria-hidden="true">
			<div className="hiw-ground-head">
				<span>GROUNDED ANSWER</span>
				<span>02 SOURCES</span>
			</div>
			<p className="hiw-ground-answer">Department-head approval is required.</p>
			<span className="hiw-ground-drop" />
			<ul className="hiw-ground-cites">
				{CITATIONS.map((cite, i) => (
					<li key={cite.ref} style={{ "--i": i } as React.CSSProperties}>
						<span className="ref">[{cite.ref}]</span>
						<span className="t">{cite.title}</span>
						<span className="s">{cite.section}</span>
					</li>
				))}
			</ul>
			<div className="hiw-ground-verified">
				<span className="tick" />
				SOURCE VERIFIED
			</div>
		</div>
	)
}
