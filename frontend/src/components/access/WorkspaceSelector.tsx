/* ============================================================================
   Workspace (tenant) selector. Options come from /api/tenants via the
   session provider — NovaTech is seed data, not a hard-coded branch, so the
   platform stays reusable for any onboarded company.

   A native <select> on purpose: the accessibility is already solved and this
   is not the place to reinvent it.
   ========================================================================== */

export function WorkspaceSelector({
	tenants,
	value,
	disabled,
	onChange,
}: {
	tenants: Array<{ id: string; name: string; industry: string }>
	value: string
	disabled: boolean
	onChange: (tenantId: string) => void
}) {
	return (
		<div className="workspace-field">
			<label className="field-label" htmlFor="access-workspace">
				Workspace
			</label>

			<div className="control">
				<select
					id="access-workspace"
					value={value}
					disabled={disabled || tenants.length === 0}
					onChange={(event) => onChange(event.target.value)}
				>
					{tenants.length === 0 ? <option value="">No workspaces available</option> : null}
					{tenants.map((tenant) => (
						<option key={tenant.id} value={tenant.id}>
							{tenant.name} — {tenant.industry}
						</option>
					))}
				</select>
				<span className="chevron" aria-hidden="true" />
			</div>
		</div>
	)
}
