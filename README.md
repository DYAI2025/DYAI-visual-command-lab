# DYAI Visual Command Lab

Standalone Visual Command Lab implementation. Bootstrap/migration is tracked by Jira DYAI-47 and GitHub issue #1.

Canonical decisions: Confluence D-013, D-014, D-016 and D-017. Product/technical baseline: 04.1 v0.5. UI/UX baseline: 04.2 v1.3.

Migration source for verified contracts/click dummy: `DYAI-Studio/DYAI-slash-cmnd@9a4f3360d0df1ead2e3b14f3568803f0260d9c27`.

Migration source for the DYAI-37 generation boundary: draft PR `DYAI-Studio/DYAI-slash-cmnd#3` at `967e0e0522e7dd8bcedcfffaa4296aa7ce195b7d`, ported and reconciled into this repository (PR #3 here), not adopted as-is. Both old sources are migration evidence only; this repository is canonical (D-017).

Initial page screenshots (EN/DE, desktop 1440×900 and mobile 390×844, first screen and full page): `docs/screenshots/`.

Durable Command/Recipe/Category persistence (DYAI-39): `docs/persistence.md` (opt-in via `COMMAND_STORE_ADAPTER=sqlite`).

Not production-ready. Production hosting and production database hosting remain open decisions.
