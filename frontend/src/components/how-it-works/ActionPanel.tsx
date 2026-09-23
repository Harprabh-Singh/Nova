/**
 * CHAPTER 05 interior — an enterprise activity record.
 *
 * Clearly labelled as a simulated action. The status flips from READY to
 * COMPLETED when the chapter becomes active, which is the only "state change"
 * animation in the section.
 */

const ROWS = [
	{ key: "USER", value: "Sarah" },
	{ key: "TIME", value: "14:23" },
	{ key: "ACTION ID", value: "ACT-2026-1187" },
]

export function ActionPanel() {
	return (
		<div className="hiw-action" aria-hidden="true">
			<div className="hiw-action-head">
				<span>SIMULATED ACTION</span>
				<span className="hiw-action-status">
					<i className="from">READY</i>
					<i className="to">COMPLETED</i>
				</span>
			</div>
			<p className="hiw-action-title">Action recorded</p>
			<p className="hiw-action-body">Purchase request guidance provided</p>
			<dl className="hiw-action-rows">
				{ROWS.map((row, i) => (
					<div key={row.key} style={{ "--i": i } as React.CSSProperties}>
						<dt>{row.key}</dt>
						<dd>{row.value}</dd>
					</div>
				))}
			</dl>
		</div>
	)
}
