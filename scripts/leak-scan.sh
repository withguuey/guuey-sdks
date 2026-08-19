#!/usr/bin/env bash
# leak-scan.sh — publication-hygiene gate for the PUBLIC guuey-sdks mirror.
#
# This tree (oss/ in the private monorepo) is mirrored verbatim to the public
# github.com/withguuey/guuey-sdks repository and published to npm. Nothing
# private may live here: cloud account identifiers, internal resource names,
# operator profiles, private e-mail domains, local paths, or realistic-looking
# credentials. This script fails (exit 1) on any hit in any tracked file, and
# runs (a) in this tree's CI on every push/PR and (b) in the monorepo's mirror
# workflow BEFORE the split+push — a leaking tree is never mirrored.
#
# The SDK source legitimately names credential PREFIXES (the CLI validates
# `guuey_user_` etc.), so credential rules here match a realistic BODY after
# the prefix, not the bare prefix. Documentation placeholders like
# `guuey_user_...` or `guuey_user_<key>` therefore pass; a pasted real key
# fails.
#
# A genuinely public value that trips a rule goes into ALLOW with a reason,
# in a reviewed change — never delete or loosen a rule to get past a failure.
set -euo pipefail

RULES=(
  'AWS account id (sandbox)|285851439369'
  'AWS account id (release)|364660314633'
  'AWS account id (any 12-digit in an arn)|arn:aws:[a-z0-9-]*:[a-z0-9-]*:[0-9]{12}:'
  'user API key body|guuey_user_[A-Za-z0-9_-]{20,}'
  'workspace API key body|guuey_wkz_[A-Za-z0-9_-]{20,}'
  'service token body|guuey_svc_[A-Za-z0-9_-]{20,}'
  'widget app secret body|guuey_widget_[A-Za-z0-9_-]{20,}'
  'anthropic key body|sk-ant-[A-Za-z0-9_-]{20,}'
  'openai key body|sk-proj-[A-Za-z0-9_-]{20,}'
  'private e-mail domain|@loqu\.co\b'
  'internal amplify data table suffix|[A-Za-z]+-[a-z0-9]{26}-NONE\b'
  'internal amplify app host|\bd[0-9a-z]{13}\.amplifyapp\.com'
  'internal aws profile|guuey-prod-admin'
  'internal aws profile|\bguuey-sandbox\b'
  'internal aws profile|\bguuey-release\b'
  'internal cluster name|ggui-agents-'
  'internal cluster name|ggui-engine-'
  'local scratch path|/private/tmp/'
  'local home path|/Users/[a-z][a-z0-9-]*/'
  'devcontainer path|/workspaces/'
  'agent seat config|(^|[^a-zA-Z0-9_./-])\.claude/'
)

# "regex|reason". Reviewed additions only. Keep each entry as narrow as the
# fixture it excuses — a real value pasted next to a fixture must still fail.
ALLOW=(
  'guuey_user_super_secret_value_abc4|login.test.ts fixture — self-describing fake key'
  'guuey_widget_TESTSECRETTESTSECRET|widget.test.ts fixture — self-describing fake secret'
  'guuey_widget_kQ7ZvN3xLeakCanaryTail|widget-auth index.test.ts — leak-canary literal, not a key'
  'sk-ant-api03-deadbeefdeadbeef|config agent.test.ts fixture — deadbeef sentinel'
  'check-templates\.mjs:[0-9]+:.*/workspaces/|the publish guard names its own needle'
)

FORBIDDEN_FILES=(
  'amplify_outputs.json'
  '.env'
  '.env.local'
  '.env.development'
  '.env.production'
  'auth.json'
)

SKIP_PATH_RE='(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|tgz)$'

main() {
  local fail=0 files
  files="$(git ls-files)"
  if [ -z "$files" ]; then
    echo "leak-scan: no tracked files"
    return 0
  fi
  files="$(printf '%s\n' "$files" | grep -vE '^scripts/leak-scan\.sh$' | grep -vE "$SKIP_PATH_RE" || true)"

  local rule desc pattern hits allow allow_re
  for rule in "${RULES[@]}"; do
    desc="${rule%%|*}"
    pattern="${rule#*|}"
    hits="$(printf '%s\n' "$files" | xargs -r grep -InE -- "$pattern" 2>/dev/null || true)"
    for allow in ${ALLOW[@]+"${ALLOW[@]}"}; do
      allow_re="${allow%%|*}"
      hits="$(printf '%s\n' "$hits" | grep -vE -- "$allow_re" || true)"
    done
    hits="$(printf '%s\n' "$hits" | sed '/^$/d')"
    if [ -n "$hits" ]; then
      echo "LEAK [$desc] pattern '$pattern':" >&2
      printf '%s\n' "$hits" | sed 's/^/    /' >&2
      fail=1
    fi
  done

  local f
  for f in "${FORBIDDEN_FILES[@]}"; do
    if printf '%s\n' "$files" | grep -qE "(^|/)${f//./\\.}$"; then
      echo "LEAK [forbidden file] '$f' is tracked" >&2
      fail=1
    fi
  done

  if [ "$fail" -ne 0 ]; then
    cat >&2 <<'EOF'

leak-scan FAILED — this tree is mirrored to a public repository.
Fix the content. If a hit is a genuinely public value, add it to ALLOW in
scripts/leak-scan.sh WITH A REASON, in a reviewed change — never delete or
loosen a rule to get past a failure.
EOF
    return 1
  fi
  echo "leak-scan: clean ($(printf '%s\n' "$files" | sed '/^$/d' | wc -l | tr -d ' ') tracked files scanned)"
}

main "$@"
