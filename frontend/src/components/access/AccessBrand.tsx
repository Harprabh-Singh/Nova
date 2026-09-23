/* ============================================================================
   Masthead. The NOVA lockup stands on the architecture at real scale.

   The runtime badge reports backend-verified state only — it says
   "Connecting" until health lands, and it never claims Azure.
   ========================================================================== */

export function AccessBrand() {
	return (
		<div className="access-brand">
			<span className="mark" aria-hidden="true" />
			<span>
				<span className="wordmark">NOVA</span>
				<span className="descriptor">
					Enterprise
					<br />
					Knowledge
					<br />
					Intelligence
				</span>
			</span>
		</div>
	)
}

export function AccessStatus({ mode }: { mode: string }) {
	return (
		<div className="access-status">
			<i aria-hidden="true" />
			{mode}
		</div>
	)
}
