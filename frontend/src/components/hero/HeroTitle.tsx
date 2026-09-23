/**
 * The hero statement. Real <h1>, real text nodes, sized with clamp() so the
 * same typographic system recomposes from 390px to 1920px.
 */
export function HeroTitle() {
	return (
		<h1 className="nvh-title">
			<span className="nvh-title-knowledge">Knowledge</span>
			<span className="nvh-title-line">
				<span className="nvh-title-into">into</span>
				<span className="nvh-title-action">Action</span>
			</span>
		</h1>
	)
}
