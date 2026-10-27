#!/bin/sh
set -eu

: "${GITLAB_URL:?set GITLAB_URL}"
: "${GITLAB_ADMIN_TOKEN:?set GITLAB_ADMIN_TOKEN}"
: "${GITLAB_PROJECT_ID:?set GITLAB_PROJECT_ID}"
: "${CORVEX_WEBHOOK_URL:?set CORVEX_WEBHOOK_URL}"
: "${CORVEX_WEBHOOK_SECRET:?set CORVEX_WEBHOOK_SECRET}"

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

api="${GITLAB_URL%/}/api/v4/projects/${GITLAB_PROJECT_ID}/hooks"

hooks="$(curl --fail-with-body --silent --show-error \
  --header "PRIVATE-TOKEN: ${GITLAB_ADMIN_TOKEN}" "$api")"
hook_id="$(printf '%s' "$hooks" | jq -r --arg url "$CORVEX_WEBHOOK_URL" \
  '.[] | select(.url == $url) | .id' | head -n 1)"

method=POST
endpoint="$api"
if [ -n "$hook_id" ]; then
  method=PUT
  endpoint="${api}/${hook_id}"
fi

response="$(curl --fail-with-body --silent --show-error \
  --request "$method" \
  --header "PRIVATE-TOKEN: ${GITLAB_ADMIN_TOKEN}" \
  --data-urlencode "url=${CORVEX_WEBHOOK_URL}" \
  --data-urlencode "token=${CORVEX_WEBHOOK_SECRET}" \
  --data-urlencode "note_events=true" \
  --data-urlencode "merge_requests_events=false" \
  --data-urlencode "push_events=false" \
  --data-urlencode "enable_ssl_verification=true" \
  "$endpoint")"

if [ -z "$hook_id" ]; then
  hook_id="$(printf '%s' "$response" | jq -r '.id')"
fi
if [ -z "$hook_id" ] || [ "$hook_id" = "null" ]; then
  echo "GitLab did not return a webhook ID." >&2
  exit 1
fi

verified="$(curl --fail-with-body --silent --show-error \
  --header "PRIVATE-TOKEN: ${GITLAB_ADMIN_TOKEN}" "${api}/${hook_id}")"
if ! printf '%s' "$verified" | jq -e --arg url "$CORVEX_WEBHOOK_URL" \
  '.url == $url and .note_events == true and .merge_requests_events == false and
   .push_events == false and .enable_ssl_verification == true' >/dev/null; then
  echo "GitLab webhook configuration did not match the requested settings." >&2
  exit 1
fi

echo "GitLab webhook ${method} completed for project ${GITLAB_PROJECT_ID}."
