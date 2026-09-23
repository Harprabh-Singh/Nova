/** Top-left brand block. The mark is hand-authored SVG, never a raster image. */
export function HeroBrand() {
	return (
		<div className="nvh-brand">
			<span className="nvh-brand-row">
				<svg className="nvh-mark" viewBox="0 0 32 32" aria-hidden="true">
					<path
						d="M16 1.5 18.4 12 29 16 18.4 20 16 30.5 13.6 20 3 16l10.6-4Z"
						fill="none"
						stroke="currentColor"
						strokeWidth="1"
						strokeLinejoin="round"
					/>
					<circle cx="16" cy="16" r="2.1" fill="currentColor" />
				</svg>
				<span className="nvh-wordmark">NOVA</span>
			</span>
			<span className="nvh-brand-sub">
				Enterprise
				<br />
				Knowledge
				<br />
				Intelligence
			</span>
		</div>
	)
}
