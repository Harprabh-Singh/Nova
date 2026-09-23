import { heroPipeline } from "../../data/heroDocuments.ts"

/**
 * Sparse technical annotations — real HTML, machine-like, deliberately small.
 * The tenant name arrives from tenant configuration, never hard-coded into
 * application logic.
 */
export function HeroAnnotations({ tenantName }: { tenantName: string }) {
	return (
		<>
			<ol className="nvh-pipeline" aria-label="How NOVA answers">
				{heroPipeline.map((step) => (
					<li key={step.no}>
						<span className="nvh-pipeline-no">{step.no}</span>
						<span className="nvh-pipeline-slash" aria-hidden="true">
							/
						</span>
						<span className="nvh-pipeline-label">{step.label}</span>
					</li>
				))}
			</ol>

			<div className="nvh-annot nvh-annot-tenant">
				<span className="nvh-annot-key">Tenant</span>
				<span className="nvh-annot-value">{tenantName}</span>
			</div>

			<dl className="nvh-annot nvh-annot-system" aria-hidden="true">
				<div>
					<dt>Knowledge</dt>
					<dd>Indexed</dd>
				</div>
				<div>
					<dt>Access</dt>
					<dd>Authorized</dd>
				</div>
				<div>
					<dt>Source</dt>
					<dd>Verified</dd>
				</div>
			</dl>
		</>
	)
}
