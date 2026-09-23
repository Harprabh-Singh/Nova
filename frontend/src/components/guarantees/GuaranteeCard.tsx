import { GuaranteeIcon } from "./GuaranteeIcon.tsx"
import type { Guarantee } from "../../data/guarantees.ts"

/* ============================================================================
   One guarantee, as a physical editorial plaque mounted on the wall.

   Intentionally minimal: icon, number, title, description, metadata. No mini
   dashboards, no screenshots, no diagrams. The richness lives in the material,
   the hard offset shadow, the grid and the hover — not inside the card.
   ========================================================================== */

export function GuaranteeCard({ guarantee, index }: { guarantee: Guarantee; index: number }) {
	return (
		<article
			className={`gtc-card${guarantee.lit ? " is-lit" : ""}`}
			data-accent={guarantee.accent}
			data-theme={guarantee.theme}
			tabIndex={0}
			style={{ "--off": `${guarantee.offset}px`, "--i": index } as React.CSSProperties}
		>
			{/* The accent: one short vertical rule that grows on hover. */}
			<span className="gtc-card-edge" aria-hidden="true" />

			<header className="gtc-card-head">
				<GuaranteeIcon icon={guarantee.icon} />
				<span className="gtc-card-no" aria-hidden="true">
					{guarantee.id}
				</span>
			</header>

			<div className="gtc-card-body">
				<h3 className="gtc-card-title">{guarantee.title}</h3>
				<p className="gtc-card-copy">{guarantee.description}</p>
			</div>

			<footer className="gtc-card-meta">{guarantee.metadata}</footer>
		</article>
	)
}
