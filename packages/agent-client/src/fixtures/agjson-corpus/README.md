# The request-shape-2 body corpus (W6)

This directory holds the invoke bodies this client has sent as request shape 2 (the silverprotocol `AgInput`
start arm that `buildInvokeBodyV2` builds), so every runtime can be held to accept every body a released client
sends.

- **One JSON file per released client version**, named for that version (for example `0.38.0.json`). Each file is
  a JSON array of shape-2 bodies, exactly as that release put them on the wire.
- **`next.json` is the to-be-released set:** the bodies the current builder produces from
  `../invoke-body-v2-cases.ts`. `invoke-body-v2.test.ts` pins it to the builder. At a release, its bodies are
  copied into that release's file.
- **Files are appended, never edited or deleted.** A released body is a promise to the runtimes that read it; a
  change to one would hide the body an older client still sends.
- `invoke-body-v2.test.ts` runs every body in every file here through silverprotocol's receiver check
  (`checkAgInput`), which must accept it.

Test-only: `src/fixtures/**` is excluded from the build and the npm pack, so this corpus ships in no bundle and no
tarball.
