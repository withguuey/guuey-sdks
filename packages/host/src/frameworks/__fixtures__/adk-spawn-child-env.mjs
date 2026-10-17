// guuey#2139 test fixture: report, by name only, which provider key variables
// a child of the calling process inherits.
const names = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];
const values = Object.values(process.env).filter((v) => typeof v === "string");
process.stdout.write(
  JSON.stringify({
    keyNames: names.filter((n) => n in process.env),
    sentinelCount: values.filter((v) => v.includes("SENTINEL-2139-")).length,
  }),
);
