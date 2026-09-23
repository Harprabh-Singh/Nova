import { HeroStatus, type HeroRuntimeMode } from "../hero/HeroStatus.tsx"

/* ============================================================================
   Threshold masthead. Same brand lockup as the top of the page, so the last
   screen closes the loop the hero opened.

   The runtime badge reuses HeroStatus, which reads state the backend actually
   reported — it only says "Local demo mode" when that is true.
   ========================================================================== */

export function FinalCtaBrand({ mode }: { mode: HeroRuntimeMode }) {
	return (
		<div className="fct-brand">
			<div className="fct-brand-mark">
				<span className="fct-brand-name">NOVA</span>
				<span className="fct-brand-sub">
					Enterprise
					<br />
					Knowledge
					<br />
					Intelligence
				</span>
			</div>

			<div className="fct-brand-status">
				<HeroStatus mode={mode} />
			</div>
		</div>
	)
}
