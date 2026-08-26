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
