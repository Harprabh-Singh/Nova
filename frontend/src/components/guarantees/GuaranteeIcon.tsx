import type { GuaranteeIconName } from "../../data/guarantees.ts"

/* ============================================================================
   Six monoline technical glyphs, drawn small on purpose. They are markers,
   not illustrations — a 38px container and a hairline stroke, so the card's
   typography always outranks them.
   ========================================================================== */

const PATHS: Record<GuaranteeIconName, JSX.Element> = {
	/* Retrieval: a bolt reduced to three strokes. */
	retrieval: (
		<>
			<path d="M12.5 2.5 5 13h5.5l-1 8.5L18 10.5h-5.5l1-8Z" />
		</>
	),
	/* Permission: shield with a closed gate line. */
	permission: (
		<>
			<path d="M12 2.5 4.5 5.6v6.1c0 4.6 3.1 8.2 7.5 9.8 4.4-1.6 7.5-5.2 7.5-9.8V5.6L12 2.5Z" />
			<path d="M8.8 11.8h6.4" />
		</>
	),
	/* Citation: section mark rendered as two brackets. */
	citation: (
		<>
			<path d="M9 4.5H4.5v15H9" />
			<path d="M15 4.5h4.5v15H15" />
			<path d="M11.4 9h1.2" />
			<path d="M11.4 15h1.2" />
		</>
	),
	/* Inspection: an aperture, not an eyeball. */
	inspection: (
		<>
			<rect x="3" y="6" width="18" height="12" />
			<path d="M3 12h4.5M16.5 12H21" />
			<path d="M10.4 12h3.2" />
		</>
	),
	/* Workflow: knowledge handed to an action. */
	workflow: (
		<>
			<rect x="3" y="3.5" width="6.5" height="5.5" />
			<rect x="14.5" y="15" width="6.5" height="5.5" />
			<path d="M9.5 6.2h4.8a3 3 0 0 1 3 3v5.8" />
		</>
	),
	/* Tenant: isolated volume. */
	tenant: (
		<>
			<path d="M12 2.8 20.5 7v10L12 21.2 3.5 17V7L12 2.8Z" />
			<path d="M3.5 7 12 11.3 20.5 7" />
			<path d="M12 11.3v9.9" />
		</>
	),
}

export function GuaranteeIcon({ icon }: { icon: GuaranteeIconName }) {
	return (
		<span className="gtc-icon" aria-hidden="true">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
				{PATHS[icon]}
			</svg>
		</span>
	)
}
