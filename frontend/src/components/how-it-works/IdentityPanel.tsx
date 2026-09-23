/**
 * CHAPTER 02 interior — a compact enterprise identity record.
 *
 * Deliberately not a profile card: no avatar, no rounded chip UI. It reads as
 * a record printed by the access system, with one lock indicator that lights
 * when the chapter becomes active.
 */

const ROWS = [
	{ key: "USER", value: "Sarah" },
	{ key: "ROLE", value: "Engineering Manager" },
	{ key: "DEPARTMENT", value: "Engineering" },
	{ key: "TENANT", value: "NovaTech Manufacturing" },
]

function LockGlyph() {
	return (
		<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
			<rect x="3.2" y="7" width="9.6" height="6.4" />
			<path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
			<path d="M8 9.4v1.8" strokeLinecap="round" />
		</svg>
	)
}

export function IdentityPanel() {
	return (
		<div className="hiw-identity" aria-hidden="true">
			<div className="hiw-identity-head">
				<span>IDENTITY RECORD</span>
				<span>ID-4471</span>
			</div>
			<dl className="hiw-identity-rows">
				{ROWS.map((row, i) => (
					<div className="hiw-identity-row" key={row.key} style={{ "--i": i } as React.CSSProperties}>
						<dt>{row.key}</dt>
						<dd>{row.value}</dd>
					</div>
				))}
			</dl>
			<div className="hiw-identity-access">
				<span className="lock">
					<LockGlyph />
				</span>
				<span className="k">ACCESS</span>
				<span className="v">AUTHORIZED</span>
			</div>
		</div>
	)
}
