# Contributing

Thanks for helping. Bugs and ideas go in an [issue](https://github.com/devswha/herdr-web-ui/issues/new/choose);
security problems never do: see [SECURITY.md](SECURITY.md). For a larger change, open an issue first so
the approach can be agreed before you build it. Small fixes can go straight to a PR.

**Features.** Open a [feature request](https://github.com/devswha/herdr-web-ui/issues/new?template=feature_request.yml)
and wait for a maintainer's yes before you write code; a feature PR without one may be closed, however
well it is built. The app is a bridge to herdr, so a feature should either mirror something herdr's
own TUI does, or meet a need that widely used coding-agent apps already meet (the Codex and Claude
apps, Paseo, T3 Code and the like). A convenience none of them offers, or one that adds a new setting
or UI concept for a narrow case, is likely to be declined: every one stays for good, to be maintained
and tested on every release.

Everything a PR is checked against is in this repository: this file, the
[review rules](.github/REVIEW.md), the [development guide](docs/development.md),
[DESIGN.md](DESIGN.md) and the `AGENTS.md` files ([root](AGENTS.md), [server](server/AGENTS.md),
[src](src/AGENTS.md)), which hold the invariants that people and coding agents both follow.
Contributions are licensed under the repository's [MIT license](LICENSE). Say in the PR when code is
adapted from another project, with its license.

## Set up

- Linux (x64, arm64), macOS or Windows x64. Windows uses the screen mirror and needs no terminal addon; Alpine and 32-bit ARM have no addon build.
- Bun 1.4 or newer, Node 18 or newer on Linux/macOS (it runs the terminal-attach sidecar), herdr 0.9.0 or newer for
  the integration tests. CI runs Bun 1.4.2, Node 22 and herdr 0.9.3, all pinned in
  [.github/actions/setup-ci/action.yml](.github/actions/setup-ci/action.yml).

```bash
bun install
bun run server   # API + WebSocket on :7317
bun run dev      # Vite on :5173, proxies /api and /ws
```

Neither command updates itself; only `bun run start` and the plugin run the updater.

## Branches and pull requests

- Fork, branch from `main` (`feat/…`, `fix/…`, `chore/…`, `docs/…`) and open the PR against `main`.
  There is no `develop` branch; releases are `vX.Y.Z` tags on `main`.
- Independent changes should use independent PRs from `main`. The only exception is a stack explicitly
  managed by a maintainer for a genuine code dependency; code conflicts and approval gates are
  scheduling constraints, not reasons to stack. See the [coordinated-work procedure](docs/development.md#coordinated-work).
  Contributors must not assume elevated permissions or that a stack has been authorized.
- One change per PR. Changes that cannot stand apart, because one needs another's code, may share
  a PR: keep each as its own commit, in the order they depend on each other, and say in the
  description what needs what. PRs are squash merged, so the PR title becomes the commit:
  `type(scope): summary`, for example `fix(chat): keep the finished turn finished after Send`.
  The merge adds `(#N)`.
- Fill in the [PR template](.github/pull_request_template.md): what changed and how you checked it.
- CI on a fork's PR waits until a maintainer approves the run. That approval is not a review.

## Checks

`bun run check fast` runs the **Fast checks** CI job, and `bun run check full` adds the
**Integration and browser** job, on a herdr of its own apart from the one you work in
([docs/development.md](docs/development.md#checks)).

**Fast checks** is these, one by one; none needs herdr:

```bash
bun run generate:types --check   # shared/herdr-api.generated.ts matches scripts/herdr-schema.json
bun run typecheck
bun run build
bun run test:unit
```

**Integration and browser** needs herdr on `PATH` (or `HERDR_WEB_HERDR_BIN`) and Chrome
(`CHROME_PATH`, default `/opt/google/chrome/chrome`):

```bash
bun run test:integration   # runs the files 4 at a time on `herdr-web-ui-test-1` to `-4`, which it
                           # stops itself; HERDR_TEST_SHARDS=1 runs them one by one on `-1`
bun run test:ui            # builds, then browser regression on `herdr-web-ui-test`; stop it with
                           # herdr --session herdr-web-ui-test server stop
```

`bun test` runs the unit and integration suites together. Remote-PC changes also have
`bun run test:ssh`. Tests and screenshots use panes and state they create themselves, never your
running terminals: see [development](docs/development.md#checks).

### Focused terminal smoke

Run the terminal keyboard checks without the full integration/browser suites:

```bash
bun run smoke:terminal
bun run smoke:terminal arrows backspace
bun run smoke:terminal ctrl-enter pane-shortcuts
```

With no arguments, all four cases run. Arguments select cases by the names shown above;
an unknown name fails before the fixture starts. Install dependencies with `bun install` first.
This command needs Bun, Node and herdr as described in **Set up**, plus Chrome/Chromium:
set `CHROME_PATH`, use `/opt/google/chrome/chrome` on Linux, or install the matching browser with
`bun node_modules/playwright-core/cli.js install chromium`. `HERDR_WEB_HERDR_BIN` can select herdr.

`smoke:terminal` builds `dist/`, then uses `check run` to allocate a disposable herdr session,
config and state. Its fixture creates two workspaces with real PTYs, a loopback bridge on an
ephemeral port, and a headless browser. It never attaches to your existing panes or workspaces.
Do not set `HERDR_TEST_LIVE=1`; live mode and direct unisolated fixture use are refused.
If `dist/` is already current, skip rebuilding with
`bun run check run bun scripts/terminal-smoke.ts arrows` (the same case arguments apply).

A passing command exits 0. A failed check or prerequisite exits nonzero; unknown cases and
the fixture's unsafe-environment guard exit 2 in the child command. `check run` reports child
failures instead of treating them as passes. On success or a thrown check, the fixture closes
its browser, stops its bridge, closes its workspaces/panes and removes its temporary root;
the wrapper stops its disposable herdr and removes its config/state. `CHECK_DIR`, when explicitly
set, retains the wrapper directory for inspection, not a running daemon. The printed check-report
path contains the result and command logs; a terminal smoke PASS is not a full-CI PASS.

### Focused pending-input smoke

Run `bun run smoke:pending-input` for the real foreground-agent queue/reconnect scene,
without the full browser journey. It uses the same consumer module as `ui-regression.ts`
and the guarded isolated terminal fixture. It retains Queue, Send now, Stop, uncertain
reload and discard checks; the reconnect oracle observes both legacy input and submit,
the current socket/pane, bridge acceptance and the owned raw PTY recorder. Constructed
early, duplicate, missing, wrong-route/text and rejected-ack controls must fail.

Set `CHECK_BROWSER_EVIDENCE_DIR` to retain raw phase/socket/pane frames, PTY bytes,
DOM and a screenshot. With an already-current build, use
`bun run check run bun scripts/pending-input-smoke.ts`. A focused PASS is not full CI.
A diagnostic failure still closes the owned workspace and temporary root, then reports
the original error.

## What a change needs

- **HTTP or WebSocket contract:** change both sides through `shared/protocol.ts` and cover it with a
  contract test (`server/api.contract.test.ts` for endpoints). A test that needs a live herdr is named
  `*.contract.test.ts`.
- **herdr wire types:** never edit `shared/herdr-api.generated.ts`; run `bun run generate:types`.
- **UI text:** every new `t("…")` string needs an entry in `src/lib/i18n.ko.ts`, `i18n.ja.ts`
  and `i18n.zh.ts`, with the same placeholders. `bun run test:unit` fails on a missing, unused or
  untranslated entry.
- **UI languages:** the app keeps English, Korean, Japanese and Simplified Chinese and does not take
  new ones. Every language has to translate each later string, so a PR that adds a language is
  closed.
- **UI:** component CSS uses the tokens in `src/styles.css` (see [DESIGN.md](DESIGN.md)).
- **Color palettes:** the app keeps three (Amber, Charcoal, Catppuccin) and does not take new ones.
  Every palette is a light and a dark block that each later token change has to fill in, so a PR
  that adds a palette is closed.
- **The browser demo:** the [demo](https://herdrweb.dev/demo/) redeploys on every
  merge to `main`. A feature meant to show there needs an answer in `site/demo/transport.ts`; anything
  else gets its 404.
- **Changelog:** a change users notice gets a small file in [changelog.d/](changelog.d/README.md)
  with its `### Added`, `### Changed` or `### Fixed` lines; do not edit CHANGELOG.md, and do not
  bump versions. The link to your PR and your name are added at release, so you can leave them out.

## Releases

Maintainers only: see [development](docs/development.md#releasing). App releases are cut by the
Release workflow; never push a `vX.Y.Z` tag by hand, since installed updaters act on tags alone.
Remote-PC runtime bundles are published with a `remote-vN` tag, and an app release requires the matching one.
