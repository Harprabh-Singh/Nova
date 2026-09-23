import type { Persona } from "../../types/index.ts"

/* ============================================================================
   One identity record in the register. A compact enterprise row — initials
   block, name, role · department, role code — not a card and not a dropdown
   option. No photos, no generated faces.

   It is a <button> with aria-pressed so selection is keyboard operable and
   announced, rather than a div that only responds to hover.
   ========================================================================== */

export const initialsOf = (name: string) =>
	name
		.split(/\s+/)
		.map((part) => part[0])
		.filter(Boolean)
		.slice(0, 2)
		.join("")
		.toUpperCase()

export function PersonaRow({
	persona,
	selected,
	disabled,
	onSelect,
}: {
	persona: Persona
	selected: boolean
	disabled: boolean
	onSelect: () => void
}) {
	return (
		<li>
			<button
				type="button"
				className={`persona-row${selected ? " is-selected" : ""}`}
				aria-pressed={selected}
				disabled={disabled}
				onClick={onSelect}
			>
				<span className="initials" aria-hidden="true">
					{initialsOf(persona.name)}
				</span>

				<span className="who">
					<strong>{persona.name}</strong>
					<small>
						{persona.title || persona.roleName} · {persona.department}
					</small>
				</span>

				<span className="code">
					{persona.roleKey}
					<i aria-hidden="true" />
				</span>
			</button>
		</li>
	)
}
