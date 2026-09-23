/**
 * The proof statement.
 *
 * Not a text block: a typographic composition laid onto the architecture. The
 * words sit on different planes of the room (wall, centre plane, floor line),
 * some of them crossing behind the ANSWER TRACE panel, so the type belongs to
 * the environment rather than sitting in a column beside it.
 *
 * Copy is fixed and must not be rewritten.
 */
export function ProofHeading() {
	return (
		<h2 className="pfc-heading">
			<span className="pfc-line pfc-line-most">
				<span className="pfc-word">Most</span>
				<span className="pfc-word">Assistants</span>
			</span>

			<span className="pfc-line pfc-line-guess">
				<span className="pfc-word pfc-guess">
					Guess.
					{/* Hand-drawn strike: an SVG path, not text-decoration, so the
					    line can be slightly imperfect and can draw itself in. */}
					<svg className="pfc-strike" viewBox="0 0 300 20" preserveAspectRatio="none" aria-hidden="true">
						<path d="M2 12 C 64 7, 126 14, 188 9 S 268 11, 298 8" />
					</svg>
				</span>
			</span>

			<span className="pfc-line pfc-line-nova">
				<span className="pfc-word">NOVA</span>
				<span className="pfc-word pfc-retrieves">
					<span className="pfc-marker" aria-hidden="true" />
					<span className="pfc-retrieves-text">Retrieves.</span>
				</span>
			</span>

			<span className="pfc-line pfc-line-proof">
				<span className="pfc-word pfc-difference">The difference</span>
				<span className="pfc-word pfc-is">is</span>
				<span className="pfc-word pfc-proof">Proof.</span>
			</span>
		</h2>
	)
}
