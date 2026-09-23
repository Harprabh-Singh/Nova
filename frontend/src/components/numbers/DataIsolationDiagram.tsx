/* ============================================================================
   Bay 02 — training separation. Your documents sit above a hard barrier;
   the path to model training is struck through, the retrieval path stays open.
   ========================================================================== */

export function DataIsolationDiagram() {
	return (
		<svg className="nbr-dia nbr-dia-privacy" viewBox="0 0 260 126" role="presentation" aria-hidden="true">
			{/* your documents */}
			<rect className="nbr-node" x="0.5" y="0.5" width="124" height="22" />
			<text className="nbr-t nbr-t-key" x="10" y="15">
				YOUR DOCUMENTS
			</text>

			{/* the barrier */}
			<path className="nbr-wire" d="M14 23 V 42" />
			<path className="nbr-barrier" d="M0 52 H 260" />
			<text className="nbr-t nbr-t-meta" x="188" y="48">
				BOUNDARY
			</text>

			{/* struck-through training path */}
			<g className="nbr-blocked">
				<path className="nbr-wire nbr-wire-dead" d="M14 52 V 76" />
				<text className="nbr-t nbr-t-dead" x="26" y="80">
					MODEL TRAINING
				</text>
				<path className="nbr-strike" d="M24 76 H 128" />
				<path className="nbr-cross" d="M9 71 L 19 81 M19 71 L 9 81" />
			</g>

			{/* the open path */}
			<g className="nbr-open">
				<path className="nbr-wire nbr-wire-live" d="M14 100 H 30" />
				<text className="nbr-t nbr-t-live" x="38" y="104">
					RETRIEVAL ONLY
				</text>
			</g>
		</svg>
	)
}
