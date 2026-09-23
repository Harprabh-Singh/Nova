# Security Incident Response Plan

Department: IT & Security
Category: plan
Classification: internal
Version: 2026.1
Effective date: 2026-01-05
Owner: Head of IT & Security

## 1. Scope

Covers suspected or confirmed compromise of NovaTech systems, accounts or data, including plant control networks.

## 2. Severity levels

| Level | Definition | Response |
| --- | --- | --- |
| SEV1 | Production systems or plant network compromised, or confirmed data theft | Immediate war room, executive notification |
| SEV2 | Confirmed compromise of a user account or server, contained | Response within 1 hour |
| SEV3 | Suspicious activity, no confirmed compromise | Response same business day |
| SEV4 | Policy violation with low risk | Handled in normal ticket flow |

## 3. Response phases

1. **Detect and report** - anyone can report to the security desk; automated alerts feed the same queue.
2. **Triage** - assign severity, incident commander and scribe.
3. **Contain** - isolate hosts, disable accounts, block indicators. Plant network isolation requires Manufacturing Operations coordination to avoid unsafe stops.
4. **Eradicate** - remove persistence and patch the exploited weakness.
5. **Recover** - restore from validated backups and monitor for recurrence.
6. **Review** - blameless post-incident review within ten working days.

## 4. Evidence handling

Preserve logs and disk images before remediation where feasible. Evidence is stored with restricted access and a chain-of-custody record.

## 5. Communication

Only the Head of IT & Security or a delegate communicates externally. Employees must not discuss incidents publicly or on social media.

## 6. Regulatory and customer notification

Legal assesses notification duties for personal-data breaches. Customer notification for contract-covered data follows the contractual window, typically 72 hours from confirmation.
