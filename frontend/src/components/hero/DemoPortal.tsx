/**
 * Circular portal CTA. A real, keyboard-accessible <button>; the rings, glow
 * and arrow movement are CSS.
 */
export function DemoPortal({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button type="button" className="nvh-portal" onClick={onClick}>
			<span className="nvh-portal-text">
				<span className="nvh-portal-line">Enter</span>
				<span className="nvh-portal-line strong">{label}</span>
				<span className="nvh-portal-arrow" aria-hidden="true">
					→
				</span>
			</span>
		</button>
	)
}

/** Extremely quiet secondary action. */
export function HeroScrollCue({ onClick }: { onClick: () => void }) {
	return (
		<button type="button" className="nvh-scrollcue" onClick={onClick}>
			Scroll to discover
			<span className="nvh-scrollcue-arrow" aria-hidden="true">
				↓
			</span>
		</button>
	)
}

/** Secondary route into onboarding, kept as a hairline text action. */
export function HeroOnboardLink({ onClick }: { onClick: () => void }) {
	return (
		<button type="button" className="nvh-onboard" onClick={onClick}>
			<span>Onboard your company</span>
			<span className="nvh-onboard-rule" aria-hidden="true" />
		</button>
	)
}
