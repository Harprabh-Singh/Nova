import type { Persona } from "../../types/index.ts"
import { PersonaRow } from "./PersonaRow.tsx"

/* ============================================================================
   The identity register. Personas come from the backend (/api/personas for
   the selected tenant) — nothing here is hard-coded, so onboarding a new
   company populates this list on its own.
   ========================================================================== */

export function PersonaRegister({
	personas,
	selectedId,
	disabled,
	loading,
	onSelect,
}: {
	personas: Persona[]
	selectedId: string | null
	disabled: boolean
	loading: boolean
	onSelect: (persona: Persona) => void
}) {
	return (
		<div className="persona-register">
			<span className="field-label" id="access-persona-label">
				Persona
				<em>{personas.length ? `${personas.length} identities` : "—"}</em>
			</span>

			{loading ? (
				<ul className="persona-skeleton" aria-hidden="true">
					<li />
					<li />
					<li />
				</ul>
			) : personas.length === 0 ? (
				<p className="persona-empty">
					No identities in this workspace yet. Seed the demo data, or onboard a company to create its first
					administrator.
				</p>
			) : (
				<ul className="rows" role="group" aria-labelledby="access-persona-label">
					{personas.map((persona) => (
						<PersonaRow
							key={persona.id}
							persona={persona}
							selected={persona.id === selectedId}
							disabled={disabled}
							onSelect={() => onSelect(persona)}
						/>
					))}
				</ul>
			)}
		</div>
	)
}
