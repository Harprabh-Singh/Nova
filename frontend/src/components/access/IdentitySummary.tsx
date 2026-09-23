import type { Persona } from "../../types/index.ts"

/* ============================================================================
   The resolved record — a compact readout strip, not a panel. It reports
   the identity the backend will be asked to resolve: user, role,
   department, and the access code that retrieval will actually enforce.
   ========================================================================== */

export function IdentitySummary({ persona }: { persona: Persona }) {
	return (
		<div className="identity-summary" aria-live="polite">
			<span className="head">
				<i aria-hidden="true" />
				Identity resolved
			</span>

			<dl>
				<div>
					<dt>User</dt>
					<dd>{persona.name}</dd>
				</div>
				<div>
					<dt>Role</dt>
					<dd>{persona.roleName}</dd>
				</div>
				<div>
					<dt>Dept</dt>
					<dd>{persona.department}</dd>
				</div>
				<div>
					<dt>Access</dt>
					<dd className="is-code">{persona.roleKey}</dd>
				</div>
			</dl>
		</div>
	)
}
