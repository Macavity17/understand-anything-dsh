# Reproducible DeepSeek blue theme

Supported upstream: **Understand-Anything 2.9.8**, release `v2.9.8`, commit
`b861852dda79273bd9d2e01c3160d42e2df510d2`.

The four payloads retain the user's existing three-file customization (blue
swatch, Dark DeepSeek preset, default theme and CSS tokens), plus a pinned
`themes/ThemeContext.tsx` startup fix. The branded local launcher explicitly sets
`VITE_DSH_THEME=deepseek`: its initial render selects Dark DeepSeek even when
`ua-theme` contains gold, and async project metadata cannot reset this selection.
The override does not erase or replace localStorage on boot, including React
StrictMode effect replay. Theme-picker changes remain available and are persisted
as explicit user preferences. A normal Vite launch without this exact override
retains saved preference > project metadata > default selection precedence.

`upstream-2.9.8.json` records SHA-256 hashes of both pristine release files and
patched payloads, and the exact prior three-file `types.ts` payload hash for
upgrades. `upstream-2.9.8.patch` is a human-reviewable zero-context diff of the
same bytes; the preparation script uses hash-validated full payloads, not fuzzy
patch application. Installation test fixtures contain the pristine four files
from the pinned release. These upstream-derived files retain the upstream MIT
license (https://github.com/Egonex-AI/Understand-Anything/blob/v2.9.8/LICENSE).

Run `node scripts/prepare-upstream.mjs --upstream <checkout> --check` to preflight
without writing. Omit `--check` to replay. Requires Node.js >=22. Missing files,
unsupported versions, edited preimages, symlink targets and corrupt payloads
fail explicitly before any theme write. Repeating preparation accepts exact
already-patched bytes and does not rewrite them. No skills, agents, dashboard
server configuration, token authentication or dependency manifests are patched.

A fresh installer clone verifies the pinned commit. Existing ZIP/local checkouts
are accepted only with upstream plugin version 2.9.8 and matching four theme
file hashes (including the exact previous three-file patch state for upgrade);
this is **not** whole-tree integrity verification. Updating to a
new upstream version requires explicitly reviewing and shipping new baseline
hashes and payloads. The installer never pulls or checks out existing Git trees.

Use a fresh isolated checkout for testing, not a running dashboard copy. The
installer installs frozen-lockfile dependencies and builds core plus the normal
dashboard; it does not use `build:demo`, start a server or register a bundle.
Bundle registration remains a DSH AI `plugin_manager` tool operation, not a
shell command. Skills are registered by the bundle Host rather than by links in
`~/.dsh/skills`.

Behavior regressions in `test/dashboard.test.mjs` transpile the shipped TS/TSX
with installed TypeScript and run the actual provider using controlled React
state/effect and localStorage mocks. They cover gold preferences, StrictMode
mount effect replay, delayed metadata, ordinary-launch precedence, picker
changes, repeated launches and unavailable storage. TypeScript is resolved from
`UA_UPSTREAM_ROOT` (default `~/.understand-anything/repo`), or an explicit
`UA_THEME_TYPESCRIPT` module path. These five tests report an explicit skip when
TypeScript is not installed; installer/launcher tests remain dependency-free.
This is a deterministic behavior harness, not a browser/React DOM screenshot test.
