# Engineering Standards

Department: Engineering
Category: standard
Classification: internal
Version: 2026.1
Effective date: 2026-01-15
Owner: Engineering Manager

## 1. Design standards

- All mechanical designs follow the NovaTech drawing template with revision blocks and tolerance tables.
- Tolerances default to ISO 2768-m unless the drawing states otherwise.
- Every assembly must have a bill of materials with vendor part numbers and an approved alternate where available.
- Design reviews are mandatory at concept, detailed design and pre-production gates.

## 2. Software and controls standards

- PLC programs use structured text with commented function blocks; ladder logic is allowed only for safety interlocks.
- All control software is version controlled; binaries are never edited on the machine.
- Line-side HMI applications must fail safe: loss of network must stop motion, not continue it.
- Automated tests are required for any control logic that moves an axis or energises a heater.

## 3. Code review

1. Two reviewers for production control code, one reviewer for tooling scripts.
2. Reviews check safety interlocks, error handling, logging and rollback.
3. No self-approval, including for the Engineering Manager.

## 4. Documentation

Every engineering change produces or updates: the drawing, the SOP, the maintenance plan and the training note. Undocumented changes are treated as non-conformances.

## 5. Tooling and environments

| Environment | Purpose | Who can deploy |
| --- | --- | --- |
| Bench | Developer testing | Any engineer |
| Line simulator | Integration testing | Controls engineers |
| Production line | Live manufacturing | Engineering Manager approval only |

## 6. Measurement and validation

New or modified processes require a capability study (minimum Cpk 1.33) before production release, signed by Quality. Validation data is stored with the change record.
