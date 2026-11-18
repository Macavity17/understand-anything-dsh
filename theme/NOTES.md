# Reproducible DeepSeek blue theme

Supported upstream: **Understand-Anything 2.9.8**, release `v2.9.8`, commit
`b861852dda79273bd9d2e01c3160d42e2df510d2`.

The payloads reproduce the existing three-file theme customization from the
user's local 2.9.8 working copy, including the blue swatch, Dark DeepSeek preset,
default theme selection and CSS tokens. Other presets remain available. An
existing browser's saved theme selection may override the new default.

`upstream-2.9.8.json` records SHA-256 hashes of both pristine release files and
patched payloads. `upstream-2.9.8.patch` is a human-reviewable diff of the same
bytes; the preparation script uses the hash-validated full payloads, not fuzzy
patch application. Installation test fixtures contain the pristine three files
from the pinned release. These upstream-derived files retain the upstream MIT
license (https://github.com/Egonex-AI/Understand-Anything/blob/v2.9.8/LICENSE).

Run `node scripts/prepare-upstream.mjs --upstream <checkout> --check` to preflight
without writing. Omit `--check` to replay. Requires Node.js >=22. Missing files,
unsupported versions, edited preimages, symlink targets and corrupt payloads
fail explicitly before any theme write. Repeating preparation accepts exact
already-patched bytes and does not rewrite them. No skills, agents, dashboard
server configuration, token authentication or dependency manifests are patched.

A fresh installer clone verifies the pinned commit. Existing ZIP/local checkouts
are accepted only with upstream plugin version 2.9.8 and matching three theme
file hashes; this is **not** whole-tree integrity verification. Updating to a
new upstream version requires explicitly reviewing and shipping new baseline
hashes and payloads. The installer never pulls or checks out existing Git trees.

Use a fresh isolated checkout for testing, not a running dashboard copy. The
installer installs frozen-lockfile dependencies and builds core plus the normal
dashboard; it does not use `build:demo`, start a server or register a bundle.
Bundle registration remains a DSH AI `plugin_manager` tool operation, not a
shell command. Skills are registered by the bundle Host rather than by links in
`~/.dsh/skills`.
