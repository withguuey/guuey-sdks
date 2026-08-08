// Emits a realistic pnpm >=11 fatal ignored-builds failure on stderr, with
// the marker SPLIT across two writes (chunk-boundary regression for the
// scanner's tail carry) and then repeated whole (once-only regression for
// the hint), before dying the way the real install does.
process.stderr.write("[my-mcp] > pnpm install\n[my-mcp]  ERR_PNPM_IGNO");
setTimeout(() => {
  process.stderr.write(
    "RED_BUILDS  Ignored build scripts: esbuild.\n" +
      "[my-mcp] ERR_PNPM_IGNORED_BUILDS again in the epilogue\n" +
      "[my-mcp] Command failed with exit code 1: pnpm install\n",
  );
  setTimeout(() => process.exit(1), 20);
}, 60);
