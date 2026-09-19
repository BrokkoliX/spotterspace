#!/bin/bash
#
# scripts/alb-https-apex.sh
#
# One-off change to the live SpotterSpace ALB and DNS (2026-09-19):
#
#   1. HTTP -> HTTPS. The :80 listener's default action and its api.* and www.*
#      host rules are switched from "forward" to a 301 redirect to the same
#      host, path and query over HTTPS.
#   2. Apex -> www. Adds a :443 rule (priority 50) that 301s spotterspace.com to
#      https://www.spotterspace.com, plus a Route 53 alias A record pointing the
#      apex at the ALB. The ACM certificate already covers the apex.
#
# The CDK stack (infrastructure/lib/spotterspace-stack.ts) was updated to
# describe this same end state. It is applied here with the CLI because
# `cdk deploy` is currently blocked by unrelated drift (five CloudWatch alarms
# exist live but not in the stack). See DEPLOYMENT_STATUS.md.
#
# Safe to run more than once. Nothing depends on plain HTTP: ALB health checks
# go straight to the targets, and the keep-warm Lambda calls https:// URLs.
#
# Usage:
#   bash scripts/alb-https-apex.sh plan       # read-only: show what would change
#   bash scripts/alb-https-apex.sh apply      # make the change, then verify
#   bash scripts/alb-https-apex.sh verify     # check from the public internet
#   bash scripts/alb-https-apex.sh rollback   # restore the exact previous state
#
# Every aws call is on ONE line on purpose: earlier ops scripts lost their
# backslash continuations when written to disk (see scripts/aws-pause.sh).

set -euo pipefail

ACCOUNT_ID="654654553862"
R="us-east-1"
DOMAIN="spotterspace.com"
ZONE_ID="Z00113712EMKXVCPQFWZW"
ALB_NAME="spotterspace-alb"
APEX_RULE_PRIORITY="50"

REDIRECT_HTTPS='[{"Type":"redirect","RedirectConfig":{"Protocol":"HTTPS","Port":"443","Host":"#{host}","Path":"/#{path}","Query":"#{query}","StatusCode":"HTTP_301"}}]'
REDIRECT_APEX="[{\"Type\":\"redirect\",\"RedirectConfig\":{\"Protocol\":\"HTTPS\",\"Port\":\"443\",\"Host\":\"www.${DOMAIN}\",\"Path\":\"/#{path}\",\"Query\":\"#{query}\",\"StatusCode\":\"HTTP_301\"}}]"
APEX_CONDITION="[{\"Field\":\"host-header\",\"HostHeaderConfig\":{\"Values\":[\"${DOMAIN}\"]}}]"

discover() {
  local account
  account=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
  if [[ "$account" != "$ACCOUNT_ID" ]]; then
    echo "ERROR: credentials are for account '${account:-<none>}', expected ${ACCOUNT_ID}." >&2
    exit 1
  fi
  ALB_ARN=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --region "$R" --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  ALB_DNS=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --region "$R" --query 'LoadBalancers[0].DNSName' --output text)
  ALB_ZONE=$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --region "$R" --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)
  HTTP80=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --region "$R" --query 'Listeners[?Port==`80`].ListenerArn' --output text)
  HTTPS443=$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" --region "$R" --query 'Listeners[?Port==`443`].ListenerArn' --output text)
  RULE80_API=$(aws elbv2 describe-rules --listener-arn "$HTTP80" --region "$R" --query "Rules[?Priority=='100'].RuleArn" --output text)
  RULE80_WWW=$(aws elbv2 describe-rules --listener-arn "$HTTP80" --region "$R" --query "Rules[?Priority=='200'].RuleArn" --output text)
  APEX_RULE=$(aws elbv2 describe-rules --listener-arn "$HTTPS443" --region "$R" --query "Rules[?Priority=='${APEX_RULE_PRIORITY}'].RuleArn" --output text)
  API_TG=$(aws elbv2 describe-target-groups --names spotterspace-dev-api-tg --region "$R" --query 'TargetGroups[0].TargetGroupArn' --output text)
  WEB_TG=$(aws elbv2 describe-target-groups --names spotterspace-dev-web-tg --region "$R" --query 'TargetGroups[0].TargetGroupArn' --output text)
  for v in ALB_ARN HTTP80 HTTPS443 RULE80_API RULE80_WWW API_TG WEB_TG; do
    if [[ -z "${!v}" || "${!v}" == "None" ]]; then echo "ERROR: could not resolve $v" >&2; exit 1; fi
  done
}

apex_record_batch() {
  # $1 = UPSERT | DELETE
  echo "{\"Comment\":\"apex -> ALB (alb-https-apex.sh)\",\"Changes\":[{\"Action\":\"$1\",\"ResourceRecordSet\":{\"Name\":\"${DOMAIN}.\",\"Type\":\"A\",\"AliasTarget\":{\"HostedZoneId\":\"${ALB_ZONE}\",\"DNSName\":\"dualstack.${ALB_DNS}.\",\"EvaluateTargetHealth\":false}}}]}"
}

wait_dns() {
  local change_id="$1"
  echo "  Waiting for Route 53 to propagate (${change_id##*/})..."
  aws route53 wait resource-record-sets-changed --id "$change_id"
  echo "  Route 53 change is INSYNC."
}

cmd_apply() {
  discover
  echo "[1/4] :80 default action -> 301 to HTTPS"
  aws elbv2 modify-listener --listener-arn "$HTTP80" --default-actions "$REDIRECT_HTTPS" --region "$R" --query 'Listeners[0].DefaultActions[0].Type' --output text

  echo "[2/4] :80 api.* and www.* rules -> 301 to HTTPS"
  aws elbv2 modify-rule --rule-arn "$RULE80_API" --actions "$REDIRECT_HTTPS" --region "$R" --query 'Rules[0].Actions[0].Type' --output text
  aws elbv2 modify-rule --rule-arn "$RULE80_WWW" --actions "$REDIRECT_HTTPS" --region "$R" --query 'Rules[0].Actions[0].Type' --output text

  echo "[3/4] :443 rule: ${DOMAIN} -> 301 https://www.${DOMAIN}"
  if [[ -n "$APEX_RULE" && "$APEX_RULE" != "None" ]]; then
    aws elbv2 modify-rule --rule-arn "$APEX_RULE" --conditions "$APEX_CONDITION" --actions "$REDIRECT_APEX" --region "$R" --query 'Rules[0].Priority' --output text | sed 's/^/  updated existing rule, priority /'
  else
    aws elbv2 create-rule --listener-arn "$HTTPS443" --priority "$APEX_RULE_PRIORITY" --conditions "$APEX_CONDITION" --actions "$REDIRECT_APEX" --region "$R" --query 'Rules[0].Priority' --output text | sed 's/^/  created rule, priority /'
  fi

  echo "[4/4] Route 53: ${DOMAIN} A (alias) -> ALB"
  wait_dns "$(aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "$(apex_record_batch UPSERT)" --query 'ChangeInfo.Id' --output text)"

  echo
  cmd_verify
}

cmd_plan() {
  discover
  echo "Read-only. Current state and what 'apply' would change:"
  printf '  :80 default action   %s -> redirect\n' "$(aws elbv2 describe-listeners --listener-arns "$HTTP80" --region "$R" --query 'Listeners[0].DefaultActions[0].Type' --output text)"
  printf '  :80 api.* rule       %s -> redirect\n' "$(aws elbv2 describe-rules --rule-arns "$RULE80_API" --region "$R" --query 'Rules[0].Actions[0].Type' --output text)"
  printf '  :80 www.* rule       %s -> redirect\n' "$(aws elbv2 describe-rules --rule-arns "$RULE80_WWW" --region "$R" --query 'Rules[0].Actions[0].Type' --output text)"
  if [[ -n "$APEX_RULE" && "$APEX_RULE" != "None" ]]; then echo "  :443 apex rule       exists (will be updated)"; else echo "  :443 apex rule       absent -> create at priority ${APEX_RULE_PRIORITY}"; fi
  local rec
  rec=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" --query "ResourceRecordSets[?Name=='${DOMAIN}.' && Type=='A'] | [0].AliasTarget.DNSName" --output text)
  echo "  ${DOMAIN} A record  ${rec/None/absent} -> alias dualstack.${ALB_DNS}"
}

cmd_rollback() {
  discover
  echo "[1/3] :80 back to forward (default -> web, api.* -> api, www.* -> web)"
  aws elbv2 modify-listener --listener-arn "$HTTP80" --default-actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${WEB_TG}\"}]" --region "$R" --query 'Listeners[0].DefaultActions[0].Type' --output text
  aws elbv2 modify-rule --rule-arn "$RULE80_API" --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${API_TG}\"}]" --region "$R" --query 'Rules[0].Actions[0].Type' --output text
  aws elbv2 modify-rule --rule-arn "$RULE80_WWW" --actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${WEB_TG}\"}]" --region "$R" --query 'Rules[0].Actions[0].Type' --output text

  echo "[2/3] Removing :443 apex rule"
  if [[ -n "$APEX_RULE" && "$APEX_RULE" != "None" ]]; then aws elbv2 delete-rule --rule-arn "$APEX_RULE" --region "$R"; echo "  deleted"; else echo "  not present"; fi

  echo "[3/3] Removing Route 53 apex record"
  if aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" --query "ResourceRecordSets[?Name=='${DOMAIN}.' && Type=='A'] | [0].Name" --output text | grep -q "${DOMAIN}"; then
    wait_dns "$(aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "$(apex_record_batch DELETE)" --query 'ChangeInfo.Id' --output text)"
  else
    echo "  not present"
  fi
  echo "Rolled back."
}

check() {
  # $1 = label, $2 = url, $3 = expected "code" or "code target"
  local got
  # ALB rule priorities and curl output are strings; normalise both sides.
  got=$(curl -s -o /dev/null -m 20 -w '%{http_code} %{redirect_url}' "$2" || true)
  got="${got% }"
  # The ALB may or may not spell out the default :443 in Location; accept both.
  got=$(printf '%s' "$got" | sed 's#:443/#/#g')
  local want
  want=$(printf '%s' "$3" | sed 's#:443/#/#g')
  if [[ "$got" == "$want" ]]; then printf '  ok    %-26s %s\n' "$1" "$got"; else printf '  FAIL  %-26s got [%s] want [%s]\n' "$1" "$got" "$want"; FAILED=1; fi
}

cmd_verify() {
  echo "Verifying from the public internet..."
  FAILED=0
  check "http www"         "http://www.${DOMAIN}/explore?x=1" "301 https://www.${DOMAIN}:443/explore?x=1"
  check "http api"         "http://api.${DOMAIN}/health"      "301 https://api.${DOMAIN}:443/health"
  check "http apex"        "http://${DOMAIN}/"                "301 https://${DOMAIN}:443/"
  check "https apex"       "https://${DOMAIN}/explore?x=1"    "301 https://www.${DOMAIN}:443/explore?x=1"
  check "https www"        "https://www.${DOMAIN}/"           "200"
  check "https api health" "https://api.${DOMAIN}/health"     "200"
  if [[ "$FAILED" == "0" ]]; then echo "All checks passed."; else echo "Some checks failed. DNS for the apex can take a few minutes on your resolver; re-run: bash $0 verify"; exit 1; fi
}

case "${1:-}" in
  apply)    cmd_apply ;;
  plan)     cmd_plan ;;
  verify)   cmd_verify ;;
  rollback) cmd_rollback ;;
  *) echo "Usage: $0 <plan|apply|verify|rollback>"; exit 1 ;;
esac
