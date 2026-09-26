# guuey

The real CLI lives at [`@guuey/cli`](https://www.npmjs.com/package/@guuey/cli) — this
bare-name package is a thin forwarder so that `npx guuey <command>` works anywhere:

```bash
npx guuey login
npx guuey deploy
```

It resolves `@guuey/cli`'s bin at run time and forwards every argument. Inside a
scaffolded project (`npx @guuey/create-agentic-app`) the pinned local `@guuey/cli`
already provides the `guuey` bin; this package covers every other directory — and
keeps the name where it belongs.

From 1.29.0, each `guuey` release runs exactly one `@guuey/cli` release, the one
with the same minor and patch: `guuey` 1.29.0 runs `@guuey/cli` 0.29.0. Every
`@guuey/cli` release comes with its `guuey` release.

## Support

Questions and help: the guuey community on Discord — https://guuey.com/discord.
Bugs and feature requests: https://github.com/withguuey/guuey-sdks/issues.
