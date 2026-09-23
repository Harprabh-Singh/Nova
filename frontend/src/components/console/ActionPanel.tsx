import { useCallback, useEffect, useMemo, useState } from "react"
import { api, ApiError } from "../../services/api.ts"
import type { ActionCatalogEntry, ActionField, ActionRequest } from "../../types/index.ts"
import "../../styles/actions.css"

/**
 * The governed-action surface inside the chat console.
 *
 * Deliberately minimal, and deliberately two-step:
 *
 *   1. Fill the action's declared fields and press Review. Nothing happens
 *      downstream - the backend validates, authorizes and writes an audit row
 *      in `awaiting_confirmation`.
 *   2. Read exactly what will be done, then Confirm or Discard.
 *
 * The component holds NO authorization logic. `authorized` from the catalogue
 * only greys out a control so a person is not invited to fail; the decision is
 * taken by the server on propose and taken AGAIN on confirm. Equally, the
 * confirm request carries only `{confirm: true}` - the panel cannot change the
 * payload between the review and the execution, because it does not send one.
 */

type Stage = "choose" | "fill" | "review" | "done"

function defaultValue(field: ActionField): string {
	if (field.type === "enum") return field.options?.[0] ?? ""
	if (field.type === "boolean") return "false"
	return ""
}

function FieldControl({
	field,
	value,
	invalid,
	onChange,
}: {
	field: ActionField
	value: string
	invalid?: string
	onChange: (next: string) => void
}) {
	const id = `act-${field.name}`
	return (
		<label className={`wx-field act-field${invalid ? " is-invalid" : ""}`} htmlFor={id}>
			<span className="act-field-label">
				{field.label}
				{field.required ? <i aria-hidden="true"> *</i> : null}
			</span>
			{field.type === "enum" ? (
				<select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
					{(field.options ?? []).map((option) => (
						<option key={option} value={option}>
							{option}
						</option>
					))}
				</select>
			) : field.type === "boolean" ? (
				<select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
					<option value="false">No</option>
					<option value="true">Yes</option>
				</select>
			) : field.type === "text" ? (
				<textarea
					id={id}
					rows={4}
					value={value}
					maxLength={field.maxLength ?? 4000}
					onChange={(event) => onChange(event.target.value)}
				/>
			) : (
				<input
					id={id}
					type={field.type === "integer" ? "number" : field.type === "date" ? "date" : field.type === "email" ? "email" : "text"}
					value={value}
					maxLength={field.maxLength}
					min={field.min}
					max={field.max}
					onChange={(event) => onChange(event.target.value)}
				/>
			)}
			{invalid ? (
				<span className="act-field-error" role="alert">
					{invalid}
				</span>
			) : field.help ? (
				<span className="act-field-help">{field.help}</span>
			) : null}
		</label>
	)
}

export function ActionPanel({ conversationId }: { conversationId?: string | null }) {
	const [open, setOpen] = useState(false)
	const [catalog, setCatalog] = useState<ActionCatalogEntry[]>([])
	const [simulated, setSimulated] = useState(true)
	const [stage, setStage] = useState<Stage>("choose")
	const [selected, setSelected] = useState<ActionCatalogEntry | null>(null)
	const [values, setValues] = useState<Record<string, string>>({})
	const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
	const [pending, setPending] = useState<{ request: ActionRequest; prompt: string; warning: string } | null>(null)
	const [outcome, setOutcome] = useState<ActionRequest | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)

	const load = useCallback(async () => {
		try {
			const result = await api.actionCatalog()
			setCatalog(result.actions)
			setSimulated(result.simulated)
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "Actions are unavailable.")
		}
	}, [])

	useEffect(() => {
		if (open && catalog.length === 0) void load()
	}, [open, catalog.length, load])

	const reset = () => {
		setStage("choose")
		setSelected(null)
		setValues({})
		setFieldErrors({})
		setPending(null)
		setOutcome(null)
		setError(null)
	}

	const choose = (entry: ActionCatalogEntry) => {
		setSelected(entry)
		setValues(Object.fromEntries(entry.input.map((field) => [field.name, defaultValue(field)])))
		setFieldErrors({})
		setError(null)
		setStage("fill")
	}

	/** Only non-empty fields are sent: the schema decides what is required. */
	const payload = useMemo(() => {
		const out: Record<string, string | number | boolean> = {}
		for (const field of selected?.input ?? []) {
			const raw = values[field.name] ?? ""
			if (raw === "") continue
			if (field.type === "integer") out[field.name] = Number(raw)
			else if (field.type === "boolean") out[field.name] = raw === "true"
			else out[field.name] = raw
		}
		return out
	}, [selected, values])

	const review = async () => {
		if (!selected || busy) return
		setBusy(true)
		setError(null)
		setFieldErrors({})
		try {
			const result = await api.proposeAction({
				actionId: selected.id,
				input: payload,
				conversationId: conversationId ?? undefined,
			})
			setPending({ request: result.request, prompt: result.confirmation.prompt, warning: result.confirmation.warning })
			setStage("review")
		} catch (caught) {
			// invalid_input comes back with per-field detail; show it against the
			// field rather than as one unreadable sentence.
			const fields = (caught as ApiError & { fields?: Record<string, string> })?.fields
			if (fields) setFieldErrors(fields)
			setError(caught instanceof Error ? caught.message : "The action could not be requested.")
		} finally {
			setBusy(false)
		}
	}

	const decide = async (confirm: boolean) => {
		if (!pending || busy) return
		setBusy(true)
		setError(null)
		try {
			const result = await api.confirmAction(pending.request.id, confirm)
			setOutcome(result.request)
			setStage("done")
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : "The action could not be completed.")
		} finally {
			setBusy(false)
		}
	}

	if (!open) {
		return (
			<button type="button" className="wx-btn small act-toggle" onClick={() => setOpen(true)}>
				Enterprise actions <i aria-hidden="true">&rarr;</i>
			</button>
		)
	}

	return (
		<section className="wx-slab act-panel" aria-label="Governed enterprise actions">
			<header className="act-head">
				<div>
					<span className="wx-label">Enterprise actions</span>
					<span className={`wx-chip${simulated ? " is-sim" : ""}`}>
						{simulated ? "SIMULATED ACTION" : "LIVE - writes to a real system"}
					</span>
				</div>
				<div className="act-head-buttons">
					{stage !== "choose" ? (
						<button type="button" className="wx-btn small" onClick={reset} disabled={busy}>
							Start over
						</button>
					) : null}
					<button type="button" className="wx-btn small" onClick={() => setOpen(false)}>
						Close
					</button>
				</div>
			</header>

			{stage === "choose" ? (
				<ul className="act-list">
					{catalog.map((entry) => (
						<li key={entry.id}>
							<button type="button" className="act-card" disabled={!entry.authorized} onClick={() => choose(entry)}>
								<strong>{entry.name}</strong>
								<span>{entry.description}</span>
								<em>
									{entry.authorized
										? `Requires ${entry.requiredPermission}`
										: `Not permitted for your role (${entry.requiredPermission})`}
								</em>
							</button>
						</li>
					))}
					{catalog.length === 0 ? <li className="wx-empty">No actions available.</li> : null}
				</ul>
			) : null}

			{stage === "fill" && selected ? (
				<form
					className="act-form"
					onSubmit={(event) => {
						event.preventDefault()
						void review()
					}}
				>
					<p className="act-lede">{selected.description}</p>
					<div className="wx-grid c2">
						{selected.input.map((field) => (
							<FieldControl
								key={field.name}
								field={field}
								value={values[field.name] ?? ""}
								invalid={fieldErrors[field.name]}
								onChange={(next) => setValues((current) => ({ ...current, [field.name]: next }))}
							/>
						))}
					</div>
					<button type="submit" className="wx-btn solid" disabled={busy}>
						{busy ? "Checking\u2026" : "Review"}
					</button>
				</form>
			) : null}

			{stage === "review" && pending ? (
				<div className="act-review">
					<p className="act-prompt">{pending.prompt}</p>
					<p className={`wx-alert${simulated ? "" : " is-live"}`}>{pending.warning}</p>
					<dl className="act-summary">
						{Object.entries(pending.request.input).map(([key, value]) => (
							<div key={key}>
								<dt>{key}</dt>
								<dd>{String(value)}</dd>
							</div>
						))}
					</dl>
					<div className="act-decide">
						<button type="button" className="wx-btn solid" disabled={busy} onClick={() => void decide(true)}>
							{busy ? "Submitting\u2026" : "Confirm and submit"}
						</button>
						<button type="button" className="wx-btn small" disabled={busy} onClick={() => void decide(false)}>
							Discard
						</button>
					</div>
				</div>
			) : null}

			{stage === "done" && outcome ? (
				<div className="wx-receipt act-receipt">
					<span className="wx-label">
						{outcome.status === "succeeded" ? "Action completed" : outcome.status === "rejected" ? "Action discarded" : "Action not completed"}
					</span>
					{outcome.result ? (
						<>
							<p className="act-ref">{outcome.result.reference}</p>
							<p>{outcome.result.summary}</p>
							<dl className="act-summary">
								{Object.entries(outcome.result.detail).map(([key, value]) => (
									<div key={key}>
										<dt>{key}</dt>
										<dd>{String(value)}</dd>
									</div>
								))}
							</dl>
						</>
					) : (
						<p>{outcome.error?.message ?? "Nothing was submitted."}</p>
					)}
					<p className="act-audit">
						Audit id {outcome.id} &middot; {outcome.simulated ? "simulated" : "live"} &middot; executed by{" "}
						{outcome.executor}
					</p>
					<button type="button" className="wx-btn small" onClick={reset}>
						New action
					</button>
				</div>
			) : null}

			{error ? (
				<p className="wx-alert" role="alert">
					{error}
				</p>
			) : null}
		</section>
	)
}

export default ActionPanel
