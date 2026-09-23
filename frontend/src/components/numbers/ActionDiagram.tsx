/* ============================================================================
   Bay 04 — knowledge becomes action. Two agent classes on one line, with the
   handover between them. Nothing that resembles a dashboard.
   ========================================================================== */

export function ActionDiagram() {
	return (
		<svg className="nbr-dia nbr-dia-action" viewBox="0 0 260 126" role="presentation" aria-hidden="true">
			{/* knowledge agent */}
			<rect className="nbr-node" x="0.5" y="0.5" width="132" height="22" />
			<text className="nbr-t nbr-t-key" x="10" y="15">
				KNOWLEDGE AGENT
			</text>

			{/* handover */}
			<path className="nbr-wire nbr-wire-live" d="M14 23 V 52" />
			<path className="nbr-arrow" d="M10 46 L 14 53 L 18 46" />
			<text className="nbr-t nbr-t-meta" x="26" y="46">
				HANDOVER
			</text>

			{/* incident agent */}
			<rect className="nbr-node nbr-node-live" x="0.5" y="58.5" width="124" height="22" />
			<text className="nbr-t nbr-t-key" x="10" y="73">
				INCIDENT AGENT
			</text>

			{/* the outcome */}
			<path className="nbr-wire nbr-wire-live" d="M14 81 V 102 H 30" />
			<text className="nbr-t nbr-t-live" x="38" y="106">
				WORKFLOW OPENED
			</text>
			<circle className="nbr-pulse" cx="30" cy="102" r="2.6" />
		</svg>
	)
}
