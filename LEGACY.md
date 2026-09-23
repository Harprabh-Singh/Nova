# NOVA - component ownership and legacy register

This file exists so a future agent never has to guess which implementation is
authoritative. If you add a competing implementation of anything below, you are
introducing a bug, not a feature.

## Canonical ownership

| Concern | Canonical implementation |
| --- | --- |
| Design tokens | `frontend/src/styles/tokens.css` (`--nova-*`) |
| Shared system vocabulary | `frontend/src/components/shared/system.tsx` |
| Landing (APPROVED VISUAL FOUNDATION - preserve) | `frontend/src/pages/LandingPage.tsx` + `components/{hero,proof,how-it-works,numbers,guarantees,final-cta}/` + `frontend/src/landing.css` |
| Access / login | `frontend/src/pages/LoginPage.tsx` + `components/access/*` + `styles/access.css` |
| Console shell + chat | `components/console/ConsoleShell.tsx`, `components/console/ConsoleMessage.tsx`, `pages/ChatPage.tsx`, `styles/console.css` |
| Knowledge | `pages/KnowledgePage.tsx`, `pages/UploadPage.tsx` |
| Admin | `pages/AdminPages.tsx` (renders through `AdminConsole` in `ConsoleShell.tsx`) |
| Settings | `pages/SettingsPage.tsx` |
| Routing | `frontend/src/hooks/useRouter.tsx` + the switch in `frontend/src/App.tsx` |
| API client | `frontend/src/services/api.ts` |
| Session / auth state | `frontend/src/providers/SessionProvider.tsx` |
| Types | `frontend/src/types/index.ts` |
| HTTP + routing (backend) | `backend/src/api/http.ts`, `backend/src/api/server.ts` |
| Edge security | `backend/src/api/security.ts` |
| Authorization policy | `backend/src/authorization/policy.ts` |
| Conversation persistence | `backend/src/conversations/service.ts` |
| Audit log | `backend/src/observability/logger.ts` |

## Removed in this pass (verified unreferenced before deletion)

| File | Why | Replaced by |
| --- | --- | --- |
| `frontend/src/components/AppShell.tsx` | Pre-console application frame. No import anywhere; every authenticated page renders through `ConsoleShell`. | `components/console/ConsoleShell.tsx` |
| `frontend/src/components/PersonaSelector.tsx` | Only consumer was `AppShell`. | Persona selection lives in `components/access/PersonaRegister.tsx` |
| `frontend/src/components/ChatMessage.tsx` | Superseded chat bubble. Unreferenced. | `components/console/ConsoleMessage.tsx` |
| `frontend/src/components/chat/NovaMessage.tsx` | Second superseded chat bubble - a third parallel implementation of the same concept. Unreferenced. | `components/console/ConsoleMessage.tsx` |
| `frontend/src/components/ScrollVideoAnimation.tsx` | Frame-sequence scroll player from an earlier hero concept. Unreferenced. | `components/hero/*` + `lib/anim.tsx` |
| `frontend/src/styles/chat.css` | Styles for the deleted chat components. Not imported by any module. | `styles/console.css` |
| `frontend/src/styles/auth.css` | Styles for the pre-rebuild login. Not imported by any module. | `styles/access.css` |

Deletion method: each file was checked for inbound imports and string
references across `frontend/src` before removal. None had any.

## Deliberately kept

- `frontend/src/components/ui.tsx` - `Alert` and `Spinner` are still used by
  `App.tsx` for the boot and fatal-error states. `ModeBadge` in that file lost
  its last consumer with `AppShell`; it is retained because it is three lines
  and is the natural primitive if a non-console surface needs the badge.
  Prefer `SystemBadge` in `components/shared/system.tsx` for new work.
- `scripts/fix4.py`, `fix5.py`, `fix6.py` - one-off migration scripts from an
  earlier redesign. They are not part of any npm script. Safe to delete; kept
  only because they document how the console CSS was migrated.

## Rules

1. Colour, spacing, type and motion values live in `tokens.css`. A component
   that hard-codes a hex for a semantic role that already has a token is a
   defect.
2. Metadata presentation (labels, status marks, traces, evidence headers) goes
   through `components/shared/system.tsx`.
3. The landing page is the approved visual foundation. Other surfaces adapt to
   it; it does not get redesigned to match them.
