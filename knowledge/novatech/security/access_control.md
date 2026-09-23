# Access Control Policy

Department: IT & Security
Category: policy
Classification: internal
Version: 2026.1
Effective date: 2026-01-05
Owner: Head of IT & Security

## 1. Principles

Access is granted on least privilege and need-to-know, tied to a named individual, approved by the data owner, and reviewed periodically.

## 2. Role-based access

Access is assigned through role templates rather than individually. A role template defines system access, document classification ceiling and physical zones. Requests outside a template require data-owner approval and expire after 90 days unless renewed.

## 3. Document access rules

| Classification | Who may read |
| --- | --- |
| Public | Anyone, including external parties |
| Internal | All employees of the company |
| Confidential | Members of the owning department at manager level, plus named individuals |
| Restricted | Named individuals only, approved by the data owner and security |

Knowledge assistants and search tools must apply the same rules as the source system: a user must never see content through a tool that they could not open directly.

## 4. Joiner, mover, leaver

- **Joiner**: access provisioned from the role template before day one.
- **Mover**: previous access is removed within two working days of a role change; it is not carried over by default.
- **Leaver**: all access revoked on the last working day; badge returned and accounts disabled the same day.

## 5. Privileged access

Administrative accounts are separate from daily-use accounts, require multi-factor authentication, and all privileged sessions are logged.

## 6. Access reviews

Department heads certify their team's access quarterly. Confidential and restricted access is reviewed monthly. Unused access is removed automatically after 60 days of inactivity.

## 7. Physical access

Badge zones mirror the digital model. Visitors are escorted at all times and are never granted plant-floor badge access.
