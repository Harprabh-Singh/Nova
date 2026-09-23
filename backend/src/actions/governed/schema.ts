/**
 * Strict input validation for governed actions.
 *
 * Three rules, and they are the whole point of this file:
 *
 *  1. UNKNOWN FIELDS ARE REJECTED. Not stripped - rejected. A payload with a
 *     field the action does not declare is either a client bug or an attempt to
 *     reach a parameter the schema does not expose (tenantId, status, reporter,
 *     an internal flag), and silently dropping it would hide both.
 *  2. Every declared field is bound: type, length, range and enum membership.
 *     `maxLength` is not cosmetic - it is the ceiling on what NOVA will forward
 *     to a downstream system of record.
 *  3. The output is a NEW object built only from declared fields, so nothing
 *     from the request body can reach an executor by reference.
 *
 * Validation errors are returned per field, because "invalid_input" with no
 * field name is useless to the person filling the form and equally useless in
 * an audit row.
 */
import { GovernedActionError } from "./types.ts"
import type { ActionDefinition, ActionField, ActionInput } from "./types.ts"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/
/** Deliberately conservative: one @, a dot in the domain, no spaces. */
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/

/** Control characters are stripped: they have no place in a ticket subject. */
function clean(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim()
}

function validateField(field: ActionField, raw: unknown, errors: Record<string, string>): unknown {
	const absent = raw === undefined || raw === null || (typeof raw === "string" && clean(raw) === "")
	if (absent) {
		if (field.required) errors[field.name] = `${field.label} is required.`
		return undefined
	}

	switch (field.type) {
		case "boolean": {
			if (typeof raw === "boolean") return raw
			if (raw === "true") return true
			if (raw === "false") return false
			errors[field.name] = `${field.label} must be true or false.`
			return undefined
		}
		case "integer": {
			const value = typeof raw === "number" ? raw : Number(String(raw).trim())
			if (!Number.isInteger(value)) {
				errors[field.name] = `${field.label} must be a whole number.`
				return undefined
			}
			if (field.min !== undefined && value < field.min) {
				errors[field.name] = `${field.label} must be at least ${field.min}.`
				return undefined
			}
			if (field.max !== undefined && value > field.max) {
				errors[field.name] = `${field.label} must be at most ${field.max}.`
				return undefined
			}
			return value
		}
		case "enum": {
			const value = clean(String(raw))
			if (!field.options || !field.options.includes(value)) {
				// The allowed list is part of the published contract, so naming it
				// is not a disclosure - it is in the action catalogue already.
				errors[field.name] = `${field.label} must be one of: ${(field.options ?? []).join(", ")}.`
				return undefined
			}
			return value
		}
		case "date": {
			const value = clean(String(raw))
			if (!ISO_DATE.test(value) && !ISO_DATETIME.test(value)) {
				errors[field.name] = `${field.label} must be an ISO date (YYYY-MM-DD) or ISO timestamp.`
				return undefined
			}
			if (Number.isNaN(Date.parse(value))) {
				errors[field.name] = `${field.label} is not a real date.`
				return undefined
			}
			return value
		}
		case "email": {
			const value = clean(String(raw)).toLowerCase()
			if (value.length > (field.maxLength ?? 320) || !EMAIL.test(value)) {
				errors[field.name] = `${field.label} must be a valid email address.`
				return undefined
			}
			return value
		}
		case "string":
		case "text":
		default: {
			if (typeof raw === "object") {
				errors[field.name] = `${field.label} must be text.`
				return undefined
			}
			const value = clean(String(raw))
			const min = field.minLength ?? 1
			const max = field.maxLength ?? (field.type === "text" ? 4000 : 200)
			if (value.length < min) {
				errors[field.name] = `${field.label} must be at least ${min} characters.`
				return undefined
			}
			if (value.length > max) {
				errors[field.name] = `${field.label} must be at most ${max} characters.`
				return undefined
			}
			return value
		}
	}
}

/**
 * Validate a raw body against an action's declared input.
 * Throws GovernedActionError("invalid_input") listing every offending field -
 * one round trip, not one field per round trip.
 */
export function validateActionInput(definition: ActionDefinition, raw: unknown): ActionInput {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new GovernedActionError("invalid_input", "The action input must be an object of fields.")
	}
	const body = raw as Record<string, unknown>
	const errors: Record<string, string> = {}
	const declared = new Set(definition.input.map((field) => field.name))

	for (const key of Object.keys(body)) {
		if (!declared.has(key)) {
			errors[key] = `"${key}" is not an input of ${definition.id}.`
		}
	}

	const output: ActionInput = {}
	for (const field of definition.input) {
		const value = validateField(field, body[field.name], errors)
		if (value !== undefined) output[field.name] = value as string | number | boolean
	}

	if (Object.keys(errors).length > 0) {
		throw new GovernedActionError(
			"invalid_input",
			`${definition.name} could not be requested: ${Object.values(errors).join(" ")}`,
			errors,
		)
	}
	return output
}
