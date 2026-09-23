# Deployment SOP

Department: Engineering
Category: sop
Classification: internal
Version: 2026.1
Effective date: 2026-01-15
Owner: Controls Engineering Lead

## 1. Purpose

Defines how control software, HMI applications and line configuration changes are deployed to production equipment without risking safety, quality or output.

## 2. Pre-deployment checklist

- Change record approved under the Change Management Policy.
- Tests passed on the line simulator, with results attached.
- Rollback package prepared and verified.
- Shift supervisor informed and a deployment window agreed.
- Quality notified if the change affects a controlled characteristic.

## 3. Deployment window

Production deployments run during planned downtime, normally between shift C and shift A (05:00-06:00) or on scheduled maintenance days. Unplanned deployments require Engineering Manager approval.

## 4. Deployment steps

1. Place the line in maintenance mode and apply lockout/tagout where physical access is needed.
2. Back up the current program and configuration to the controlled repository.
3. Load the approved package; verify checksum against the release record.
4. Run the dry-cycle validation set (no material) and confirm interlocks.
5. Run five supervised production cycles and check first-article quality.
6. Release the line to the shift supervisor and record the deployment.

## 5. Rollback

If any validation step fails, roll back immediately using the backup taken in step 2. Rollback does not require new approval. Report the failed deployment in the change record within 24 hours.

## 6. Post-deployment

Monitor scrap rate and cycle time for the next full shift. A rise in scrap above 1.5x baseline triggers a non-conformance review with Quality.
