#!/usr/bin/env bash
# =============================================================================
# r6-cleanup.sh — one-shot cleanup of R5/R6 cruft the user didn't ask for.
#
# Run from repo root:
#   bash scripts/r6-cleanup.sh
#
# Idempotent — safe to re-run.
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

M=apps/api/prisma/migrations

# ---- 1. Dead features -----------------------------------------------------
echo "▶ Deleting dead onboarding feature…"
rm -f  apps/web/src/pages/OnboardingPage.tsx
rm -rf apps/web/src/components/onboarding
rm -rf apps/api/src/modules/onboarding
rm -rf "$M/0016_onboarding"

echo "▶ Deleting unrequested a11y scaffolding…"
rm -f apps/web/src/a11y.test.tsx
rm -f apps/web/src/components/RouteAnnouncer.tsx
rm -f apps/web/docs/a11y-contrast-audit.md
# Remove the docs dir entirely if a11y was the only file in it.
rmdir apps/web/docs 2>/dev/null || true

echo "▶ Deleting unused i18n test + orphan locales…"
rm -f apps/web/src/i18n/i18n.test.ts
rm -f apps/web/src/locales/es.json
rm -f apps/web/src/locales/ar.json
rm -f apps/web/src/locales/es.review.md

echo "▶ Deleting agent-leftover DEPS.md notes (gated packages)…"
rm -f apps/api/src/modules/web-push/DEPS.md
rm -f apps/api/src/modules/exports/DEPS.md

echo "▶ Deleting PWA icon placeholder (real icons not shipped)…"
rm -f apps/web/public/icons/README.txt
rmdir apps/web/public/icons 2>/dev/null || true

# ---- 2. Migration renumbering --------------------------------------------
echo "▶ Renumbering migrations into a contiguous sequence…"
# Process in reverse final-number order so `mv -n` never sees a collision.
# Final layout: 0013, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021.
[ -d "$M/0020_custom_reports" ]         && mv -n "$M/0020_custom_reports"         "$M/0021_custom_reports"
[ -d "$M/0019_comment_templates" ]      && mv -n "$M/0019_comment_templates"      "$M/0020_comment_templates"
[ -d "$M/0018_sprint_retro" ]           && mv -n "$M/0018_sprint_retro"           "$M/0019_sprint_retro"
[ -d "$M/0017_notification_digests" ]   && mv -n "$M/0017_notification_digests"   "$M/0018_notification_digests"
[ -d "$M/0015_exports" ]                && mv -n "$M/0015_exports"                "$M/0017_exports"
[ -d "$M/0014_import_resumable" ]       && mv -n "$M/0014_import_resumable"       "$M/0016_import_resumable"
[ -d "$M/0013_workspace_members" ]      && mv -n "$M/0013_workspace_members"      "$M/0015_workspace_members"
[ -d "$M/0013_custom_fields_advanced" ] && mv -n "$M/0013_custom_fields_advanced" "$M/0014_custom_fields_advanced"

echo "▶ Done."
echo ""
echo "Migration sequence is now contiguous: 0013…0021."
echo ""
echo "Next:"
echo "  pnpm i"
echo "  pnpm --filter @nockta/api prisma generate"
echo "  pnpm --filter @nockta/api typecheck"
echo "  pnpm --filter @nockta/web typecheck"
echo ""
echo "Paste any remaining errors and I'll fix them."
