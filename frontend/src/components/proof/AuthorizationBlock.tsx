import { proofAuthorization } from "../../data/proofEvidence.ts"

/**
 * AUTHORIZED CONTEXT: who is asking, and what that identity is cleared to
 * open. Permission is resolved before generation, so it is shown before the
 * answer -- the layout is the argument.
 */
export function AuthorizationBlock({ powered }: { powered: boolean }) {
	return (
		<div className={`pfc-auth${powered ? " is-on" : ""}`}>
			<div className="pfc-auth-who">
				<span className="pfc-auth-name">{proofAuthorization.name}</span>
				<span className="pfc-auth-role">{proofAuthorization.role}</span>
			</div>
			<div className="pfc-auth-state">
				<span className="pfc-auth-key">Access</span>
				<span className="pfc-auth-value">
					<span className="pfc-dot" aria-hidden="true" />
					{proofAuthorization.access}
				</span>
			</div>
		</div>
	)
}
