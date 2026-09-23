import { heroStrip } from "../../data/heroDocuments.ts"

/**
 * Thin technical strip. Structural product truths only — no invented metrics.
 */
export function HeroBottomStrip() {
	return (
		<div className="nvh-strip">
			<ul className="nvh-strip-list">
				{heroStrip.map((item, index) => (
					<li key={item}>
						{index > 0 ? (
							<span className="nvh-strip-sep" aria-hidden="true">
								//
							</span>
						) : null}
						{item}
					</li>
				))}
			</ul>
	
		</div>
	)
}
