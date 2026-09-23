# Machine Failure SOP

Department: Manufacturing Operations
Category: sop
Classification: internal
Version: 2026.2
Effective date: 2026-03-01
Owner: Manufacturing Operations Head

## 1. Purpose

Defines the machine failure procedure: what an operator must do when a production machine fails, stalls, produces an unrecognised alarm, or becomes unsafe.

## 2. Immediate actions (first 5 minutes)

1. **Stop the machine** using the cycle stop; use the emergency stop if there is any risk to people.
2. **Make the area safe.** Do not open guards while any axis is moving.
3. **Do not attempt repair** unless you are a certified maintenance technician with a work order.
4. **Inform the shift supervisor** immediately with the machine ID, alarm code and what you observed.
5. **Quarantine suspect parts** produced in the last cycle window and tag them for Quality.

## 3. Reporting the failure

Raise a machine incident record with these fields:

- `machine_id` (for example M-204)
- `description` of the failure and any alarm code
- `severity`: low, medium, high or critical
- `location` (plant, line and cell)
- `observed_at` (date and time)
- `reporter` (name of the person reporting)

A record must be raised even if the machine recovers on its own.

## 4. Severity definitions

| Severity | Definition | Response target |
| --- | --- | --- |
| Critical | Injury risk, fire, or full line stoppage | Maintenance on site within 15 minutes; Manufacturing Operations head informed immediately |
| High | Single machine down, production order at risk | Maintenance within 30 minutes |
| Medium | Degraded operation, workaround exists | Same shift |
| Low | Cosmetic or intermittent, no output impact | Next planned maintenance |

## 5. Maintenance response

Maintenance performs lockout/tagout, diagnoses the fault, and records root cause and parts consumed in the work order. Spares needed to restore production may be purchased as an emergency purchase under the Procurement Policy (up to ₹50,000 with department-head confirmation).

## 6. Restart authorisation

A machine may only be returned to production after:

1. Maintenance closes the work order with a root-cause note.
2. A first-article part passes dimensional inspection.
3. The shift supervisor records the restart time in the shift log.

For critical failures, the Quality lead must also approve the restart.

## 7. Escalation

If the machine is not restored within the response target, follow the Production Escalation Procedure. Safety-related failures are additionally reported under the Incident Reporting Procedure.

## 8. Follow-up

Every high or critical failure receives a root-cause analysis within five working days, with corrective actions tracked to closure by Manufacturing Operations and Engineering.
