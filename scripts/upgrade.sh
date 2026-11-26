#!/bin/bash
# upgrade.sh - Upgrade a Media Resource Manager installation to a release tag.
#
# Usage: scripts/upgrade.sh <tag> [options]
#   <tag>              Release to upgrade to, for example v1.7.0
#   --dry-run          Show the plan and stop. Makes no AWS calls that change
#                      anything and writes no files.
#   --yes, -y          Don't ask for confirmation (for automation)
#   --stack <name>     Pipeline stack to upgrade (default: found by its outputs)
#   --clone            Upgrade the deploy.sh install run from the current
#                      folder (a clone of the repository), not a pipeline
#   --param Key=Value  Set a pipeline stack parameter that the Upgrade notes
#                      call out (repeatable)
#   --repo <url>       Git repository to read the release from (default: the
#                      pipeline's RepoUrl, or the clone's origin)
#
# Runs the steps in docs/UPGRADING.md with the caller's own AWS credentials,
# in the Region of the installation (AWS_REGION or the CLI default):
#   1. Find the install (a CodeBuild pipeline stack, or a deploy.sh clone) and
#      its version, read only.
#   2. Read releases.json at the target tag for every release in between, and
#      choose the quick path (stack keeps its template, GitBranch changes) or
#      the full path (stack gets deploy-pipeline.yaml from the tag).
#   3. Show the plan: releases, path, regional hubs that will need Update,
#      whether DCV sessions disconnect. Ask for confirmation.
#   4. Pipeline: save the stack's parameters and template for a rollback,
#      create a change set, show it, ask again, execute it, and follow the
#      build. Clone: check out the tag and run ./deploy.sh -y.
#   5. List the regional hubs that show Update available, with the console
#      steps to update them. Hubs are updated from the console, where the
#      update runs as the signed-in admin; this script doesn't update them.
#   6. Print the rollback commands.
#
# Needs bash 3.2 or later, the AWS CLI v2, git and Node.js. There is no
# PowerShell version; on Windows run it in AWS CloudShell or WSL.

set -u
set -o pipefail

OFFICIAL_REPO="https://github.com/awslabs/media-resource-manager"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TAG=""
STACK=""
DRY_RUN=false
ASSUME_YES=false
FORCE_CLONE=false
REPO_OVERRIDE=""
PARAM_OVERRIDES=""

usage() {
    sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() { echo "❌ $*" >&2; exit 1; }
warn() { echo "⚠  $*"; }
step() { echo ""; echo "== $*"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --yes|-y) ASSUME_YES=true; shift ;;
        --clone) FORCE_CLONE=true; shift ;;
        --stack)
            [ $# -ge 2 ] || die "--stack needs a stack name"
            STACK="$2"; shift 2 ;;
        --repo)
            [ $# -ge 2 ] || die "--repo needs a URL"
            REPO_OVERRIDE="$2"; shift 2 ;;
        --param)
            [ $# -ge 2 ] || die "--param needs Key=Value"
            case "$2" in
                [A-Za-z]*=*) ;;
                *) die "--param needs Key=Value, got: $2" ;;
            esac
            PARAM_OVERRIDES="$PARAM_OVERRIDES$2"$'\n'; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        -*) die "Unknown option: $1 (see --help)" ;;
        *)
            [ -z "$TAG" ] || die "Only one release tag can be given"
            TAG="$1"; shift ;;
    esac
done

[ -n "$TAG" ] || { usage; exit 2; }
# Only published release tags: never a branch, commit or URL.
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "The target must be a release tag such as v1.7.0, got: $TAG"
if [ -n "$STACK" ] && $FORCE_CLONE; then die "Use --stack or --clone, not both"; fi
if [ -n "$PARAM_OVERRIDES" ] && $FORCE_CLONE; then die "--param applies to pipeline installs; for a clone, edit parameters.json"; fi

for tool in aws git node; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

# json <expression>: evaluate a JavaScript expression on the JSON read from
# stdin (as d). Strings print as they are, arrays one item per line, objects
# as JSON, and null or undefined print nothing.
json() {
    MRM_JS_EXPR="$1" node -e '
let s = "";
process.stdin.on("data", c => { s += c; }).on("end", () => {
  const d = JSON.parse(s || "null");
  const v = new Function("d", "return (" + process.env.MRM_JS_EXPR + ");")(d);
  if (v === undefined || v === null) return;
  if (Array.isArray(v)) { for (const x of v) console.log(x); }
  else if (typeof v === "object") console.log(JSON.stringify(v));
  else console.log(String(v));
});'
}

confirm() {
    if $ASSUME_YES; then
        echo "$1 yes (--yes)"
        return 0
    fi
    local answer=""
    printf '%s (y/N) ' "$1"
    read -r answer || answer=""
    echo ""
    case "$answer" in
        y|Y|yes|YES|Yes) return 0 ;;
    esac
    return 1
}

sha256() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    else shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

# Same naming as the buildspec and CDK (createNamingConventions).
acronym_of() {
    echo "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | awk '{for(i=1;i<=NF;i++) printf toupper(substr($i,1,1))}'
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "Media Resource Manager upgrade to $TAG"
$DRY_RUN && echo "Dry run: nothing will be changed."

# ---------------------------------------------------------------------------
step "1. Find the installation"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>"$WORK/err") \
    || die "Can't read the caller identity: $(cat "$WORK/err")"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null)}}"
[ -n "$REGION" ] || die "Set AWS_REGION to the Region of the installation"
echo "Account: $ACCOUNT  Region: $REGION"

INSTALL=""
if [ -n "$STACK" ]; then
    INSTALL=pipeline
elif $FORCE_CLONE; then
    INSTALL=clone
else
    FOUND=$(aws cloudformation describe-stacks \
        --query "Stacks[?Outputs[?OutputKey=='CodeBuildProjectName'] && Parameters[?ParameterKey=='GitBranch']].StackName" \
        --output text 2>"$WORK/err") || die "Can't list stacks: $(cat "$WORK/err")"
    [ "$FOUND" != None ] || FOUND=""
    FOUND_COUNT=$(echo "$FOUND" | wc -w | tr -d ' ')
    if [ "$FOUND_COUNT" = 1 ]; then
        STACK="$FOUND"
        INSTALL=pipeline
    elif [ "$FOUND_COUNT" -gt 1 ]; then
        die "Found several pipeline stacks ($(echo "$FOUND" | tr '\t\n' '  ')). Pass --stack <name>."
    elif [ -f deploy.sh ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        INSTALL=clone
    else
        die "No pipeline stack in $REGION, and the current folder isn't a clone with deploy.sh. Pass --stack <name>, or run with --clone from the clone you deploy from."
    fi
fi

INSTALLED=""
if [ "$INSTALL" = pipeline ]; then
    STACK_JSON=$(aws cloudformation describe-stacks --stack-name "$STACK" --output json 2>"$WORK/err") \
        || die "Can't read stack $STACK: $(cat "$WORK/err")"
    param() { json "((d.Stacks[0].Parameters || []).find(p => p.ParameterKey === '$1') || {}).ParameterValue" <<<"$STACK_JSON"; }
    output() { json "((d.Stacks[0].Outputs || []).find(o => o.OutputKey === '$1') || {}).OutputValue" <<<"$STACK_JSON"; }
    STACK_STATUS=$(json 'd.Stacks[0].StackStatus' <<<"$STACK_JSON")
    GIT_BRANCH=$(param GitBranch)
    REPO_URL=$(param RepoUrl)
    PRODUCT_NAME=$(param ProductName)
    PROJECT=$(output CodeBuildProjectName)
    BUCKET=$(output ArtifactBucketName)
    [ -n "$PROJECT" ] || die "Stack $STACK has no CodeBuildProjectName output; is it an MRM pipeline stack?"
    echo "Install: CodeBuild pipeline, stack $STACK ($STACK_STATUS), project $PROJECT"
    echo "GitBranch: $GIT_BRANCH"
    case "$STACK_STATUS" in
        CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE|IMPORT_COMPLETE) ;;
        *) die "Stack $STACK is $STACK_STATUS. Wait until it is UPDATE_COMPLETE, or fix it first." ;;
    esac
    if [[ "$GIT_BRANCH" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        INSTALLED="$GIT_BRANCH"
    else
        warn "GitBranch is '$GIT_BRANCH', not a release tag, so the installed version is unknown. The upgrade pins GitBranch to $TAG."
    fi
else
    INSTALLED=$(git describe --tags --exact-match HEAD 2>/dev/null)
    if ! [[ "$INSTALLED" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        INSTALLED=""
        warn "This clone isn't checked out at a release tag, so the installed version is unknown."
    fi
    REPO_URL=$(git remote get-url origin 2>/dev/null)
    PRODUCT_NAME=$(node -e 'try { console.log(require(process.cwd() + "/cdk.json").context.productName || ""); } catch (e) { console.log(""); }')
    echo "Install: deploy.sh from the clone in $(pwd)"
fi
[ -n "$PRODUCT_NAME" ] || PRODUCT_NAME="Media Resource Manager"
ACRONYM=$(acronym_of "$PRODUCT_NAME")
ACRONYM_LOWER=$(echo "$ACRONYM" | tr '[:upper:]' '[:lower:]')
echo "Installed version: ${INSTALLED:-unknown}  Product: $PRODUCT_NAME ($ACRONYM)"

if [ -n "$INSTALLED" ]; then
    NEWER=$(MRM_A="$INSTALLED" MRM_B="$TAG" node -e '
const p = v => v.replace(/^v/, "").split(".").map(Number);
const a = p(process.env.MRM_A), b = p(process.env.MRM_B);
let c = 0; for (let i = 0; i < 3 && !c; i++) c = b[i] - a[i];
console.log(c > 0 ? "newer" : c === 0 ? "same" : "older");')
    case "$NEWER" in
        same) echo "Already at $TAG. Nothing to do."; exit 0 ;;
        older) die "$TAG is older than the installed $INSTALLED. To go back, follow Roll back in docs/UPGRADING.md." ;;
    esac
fi

# ---------------------------------------------------------------------------
step "2. Read the release"

REPO_URL="${REPO_OVERRIDE:-${REPO_URL:-$OFFICIAL_REPO.git}}"
REPO_NORMALIZED="${REPO_URL%/}"
REPO_NORMALIZED="${REPO_NORMALIZED%.git}"
if [ "$REPO_NORMALIZED" != "$OFFICIAL_REPO" ]; then
    warn "The repository is $REPO_URL, not the official $OFFICIAL_REPO. Check that $TAG there is the release you expect."
fi
git clone --quiet --depth 1 --branch "$TAG" "$REPO_URL" "$WORK/src" >/dev/null 2>"$WORK/err" \
    || die "Can't read $TAG from $REPO_URL: $(cat "$WORK/err"). Check the tag, or pass --repo."
RELEASE_TAGS=$(git ls-remote --tags --refs "$REPO_URL" 'v*' 2>"$WORK/err" | sed 's#.*refs/tags/##') \
    || die "Can't list the release tags of $REPO_URL: $(cat "$WORK/err")"

TEMPLATE="$WORK/src/scripts/deploy-pipeline.yaml"
if [ "$INSTALL" = pipeline ]; then
    [ -f "$TEMPLATE" ] || die "$TAG has no scripts/deploy-pipeline.yaml"
    echo "deploy-pipeline.yaml at $TAG: SHA-256 $(sha256 "$TEMPLATE")"
fi

META=""
if [ -f "$WORK/src/releases.json" ]; then
    META="$WORK/src/releases.json"
    echo "Release metadata: releases.json at $TAG"
elif [ -f "$SCRIPT_DIR/../releases.json" ]; then
    META="$SCRIPT_DIR/../releases.json"
    echo "Release metadata: $TAG has no releases.json; using the copy next to this script"
else
    warn "No release metadata found; every release counts as needing the full path."
fi

# Plan: KEY=value lines for the script, '| ' lines to show.
PLAN=$(MRM_META="$META" MRM_TAGS="$RELEASE_TAGS" MRM_INSTALLED="$INSTALLED" MRM_TARGET="$TAG" node -e '
const fs = require("fs");
const env = process.env;
const parse = v => { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v || ""); return m ? m.slice(1).map(Number) : null; };
const cmp = (a, b) => { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const target = env.MRM_TARGET.replace(/^v/, "");
const installed = env.MRM_INSTALLED.replace(/^v/, "");
const meta = env.MRM_META ? (JSON.parse(fs.readFileSync(env.MRM_META, "utf8")).releases || []) : [];
const byVersion = new Map(meta.map(r => [r.version, r]));
const versions = new Set(env.MRM_TAGS.split(/\s+/).filter(parse).map(t => t.replace(/^v/, "")));
versions.add(target);
let range = [...versions].filter(v => cmp(v, target) <= 0 && (!installed || cmp(v, installed) > 0)).sort(cmp);
// Unknown installed version: only releases with metadata can be described.
if (!installed) range = range.filter(v => byVersion.has(v));
const yn = b => b === true ? "yes" : b === false ? "no" : "unknown";
const reasons = [];
const missing = range.filter(v => !byVersion.has(v));
const known = range.map(v => byVersion.get(v)).filter(Boolean);
if (!installed) reasons.push("the installed version is unknown");
if (missing.length) reasons.push("no release metadata for v" + missing.join(", v"));
const tplChanged = known.filter(r => r.pipelineTemplateChanged !== false).map(r => "v" + r.version);
if (tplChanged.length) reasons.push("the pipeline template changed in " + tplChanged.join(", "));
// yes if any release says yes; unknown if a release has no value.
const any = key => known.some(r => r[key] === true) ? "yes"
  : missing.length || known.some(r => typeof r[key] !== "boolean") ? "unknown" : "no";
const t = byVersion.get(target);
console.log("PATH=" + (reasons.length ? "full" : "quick"));
console.log("REASON=" + reasons.join("; "));
console.log("HUBS=" + any("hubUpdate"));
console.log("SESSIONS=" + any("sessionsDisconnect"));
console.log("ADMIN=" + any("adminAction"));
console.log("FINGERPRINT=" + ((t && t.hubFingerprint) || ""));
console.log("RANGE=" + range.map(v => "v" + v).join(" "));
for (const v of range) {
  const r = byVersion.get(v);
  if (!r) { console.log("| v" + v + ": no release metadata. Read its Upgrade notes in CHANGELOG.md."); continue; }
  console.log("| v" + v + ": pipeline template changed " + yn(r.pipelineTemplateChanged) + ", hub update " + yn(r.hubUpdate) +
    ", DCV sessions disconnect " + yn(r.sessionsDisconnect) + ", admin action " + yn(r.adminAction));
  if (r.notes) console.log("|   " + r.notes);
}') || die "Can't read the release metadata"
plan_get() { printf '%s\n' "$PLAN" | sed -n "s/^$1=//p"; }
UPGRADE_PATH=$(plan_get PATH)
TARGET_FINGERPRINT=$(plan_get FINGERPRINT)
[ "$INSTALL" = clone ] && UPGRADE_PATH=deploy.sh

# ---------------------------------------------------------------------------
step "3. Check the installation"

# Regional hubs: records in <acronym>-regional-hubs. Prints one line per hub:
# region<TAB>status<TAB>needs-update(yes|no|unknown)<TAB>display name
hub_list() {
    local fingerprint="$1" hubs_flag="$2" hubs_json
    if ! hubs_json=$(aws dynamodb scan --table-name "$ACRONYM_LOWER-regional-hubs" \
        --projection-expression '#r, #s, templateVersion, displayName' \
        --expression-attribute-names '{"#r":"region","#s":"status"}' --output json 2>"$WORK/err"); then
        if grep -q ResourceNotFoundException "$WORK/err"; then return 0; fi
        echo "ERROR $(cat "$WORK/err")"
        return 0
    fi
    MRM_FP="$fingerprint" MRM_FLAG="$hubs_flag" json '(d.Items || []).map(i => {
      const s = k => (i[k] && i[k].S) || "";
      const updatable = ["available", "update_failed"].includes(s("status"));
      const fp = process.env.MRM_FP;
      const needs = !updatable ? "no" : fp ? (s("templateVersion") !== fp ? "yes" : "no")
        : process.env.MRM_FLAG === "no" ? "no" : process.env.MRM_FLAG === "yes" ? "yes" : "unknown";
      return [s("region"), s("status"), needs, s("displayName") || s("region")].join("\t");
    })' <<<"$hubs_json"
}

HUBS_BEFORE=$(hub_list "$TARGET_FINGERPRINT" "$(plan_get HUBS)")
case "$HUBS_BEFORE" in
    ERROR*) warn "Can't read the regional hubs: ${HUBS_BEFORE#ERROR }"; HUBS_BEFORE="" ;;
esac
HUBS_BUSY=$(printf '%s\n' "$HUBS_BEFORE" | awk -F'\t' '$2 ~ /^(creating|updating|deleting)$/ {print $1 " (" $2 ")"}')
[ -z "$HUBS_BUSY" ] || die "Regional hubs are busy: $HUBS_BUSY. Wait until they are available; don't create, update or delete a hub while the upgrade runs."

if [ "$INSTALL" = pipeline ]; then
    LAST_BUILD=$(aws codebuild list-builds-for-project --project-name "$PROJECT" --query 'ids[0]' --output text 2>"$WORK/err") \
        || die "Can't list builds of $PROJECT: $(cat "$WORK/err")"
    if [ -n "$LAST_BUILD" ] && [ "$LAST_BUILD" != None ]; then
        LAST_STATUS=$(aws codebuild batch-get-builds --ids "$LAST_BUILD" --query 'builds[0].buildStatus' --output text 2>"$WORK/err") \
            || die "Can't read build $LAST_BUILD: $(cat "$WORK/err")"
        [ "$LAST_STATUS" != IN_PROGRESS ] || die "Build $LAST_BUILD is still running. Wait for it to finish; two builds deploying at once fail."
    fi
    # Parameters named with --param must exist in the stack (quick path) or
    # in the target template (full path, checked when the change set is made).
    if [ "$UPGRADE_PATH" = quick ] && [ -n "$PARAM_OVERRIDES" ]; then
        while IFS= read -r kv; do
            [ -n "$kv" ] || continue
            [ -n "$(json "(d.Stacks[0].Parameters || []).some(p => p.ParameterKey === '${kv%%=*}') || null" <<<"$STACK_JSON")" ] \
                || die "Stack $STACK has no parameter ${kv%%=*}"
        done <<<"$PARAM_OVERRIDES"
    fi
    echo "No build running. Stack $STACK is $STACK_STATUS."
else
    [ -z "$(git status --porcelain --untracked-files=no)" ] \
        || die "The clone has uncommitted changes to tracked files. Commit or stash them first."
    echo "The clone has no uncommitted changes."
fi

# ---------------------------------------------------------------------------
step "Plan"

echo "Upgrade ${INSTALLED:-the installation} to $TAG ($(plan_get RANGE | wc -w | tr -d ' ') release(s): $(plan_get RANGE))"
printf '%s\n' "$PLAN" | sed -n 's/^| /  /p'
echo ""
case "$UPGRADE_PATH" in
    quick) echo "Path: quick. The pipeline template didn't change, so the stack keeps its template and only GitBranch changes to $TAG." ;;
    full) echo "Path: full, because $(plan_get REASON). The stack gets deploy-pipeline.yaml from $TAG and GitBranch=$TAG." ;;
    deploy.sh) echo "Path: check out $TAG in this clone and run ./deploy.sh -y." ;;
esac
if [ -n "$PARAM_OVERRIDES" ]; then
    echo "Parameters to set: $(printf '%s' "$PARAM_OVERRIDES" | tr '\n' ' ')"
fi
case "$(plan_get SESSIONS)" in
    yes) echo "DCV sessions: may disconnect while gateways are replaced. Plan the upgrade outside working hours." ;;
    no) echo "DCV sessions: not expected to disconnect." ;;
    *) echo "DCV sessions: unknown; read the Upgrade notes of the releases above." ;;
esac
[ "$(plan_get ADMIN)" = no ] || echo "Admin action: read the notes above before you go on."
HUB_NEEDS=$(printf '%s\n' "$HUBS_BEFORE" | awk -F'\t' '$3 == "yes" {print "  " $1 " (" $4 ", " $2 ")"}')
HUB_UNKNOWN=$(printf '%s\n' "$HUBS_BEFORE" | awk -F'\t' '$3 == "unknown" {print "  " $1 " (" $4 ", " $2 ")"}')
if [ -n "$HUB_NEEDS" ]; then
    echo "Regional hubs that will need Update after the deploy:"
    echo "$HUB_NEEDS"
elif [ -n "$HUB_UNKNOWN" ]; then
    echo "Regional hubs that may need Update after the deploy (checked again after it):"
    echo "$HUB_UNKNOWN"
elif [ -n "$HUBS_BEFORE" ]; then
    echo "Regional hubs: none will need Update."
else
    echo "Regional hubs: none."
fi
echo ""
if [ "$INSTALL" = pipeline ]; then
    echo "Steps: save the stack's parameters and template for a rollback, create a change set and show it, ask again, execute it, follow the build (30-45 minutes), then list the hubs to update."
else
    echo "Steps: fetch $TAG, check it out, run ./deploy.sh -y, then list the hubs to update."
fi

if $DRY_RUN; then
    echo ""
    echo "Dry run: stopped before any change."
    exit 0
fi
confirm "Start the upgrade?" || { echo "Stopped. Nothing was changed."; exit 1; }

# ---------------------------------------------------------------------------
print_rollback() {
    echo ""
    echo "To roll back to ${INSTALLED:-the previous version}:"
    echo "  aws s3 cp $ROLLBACK_TEMPLATE s3://$BUCKET/mrm-upgrade/rollback-$TS/deploy-pipeline.yaml"
    echo "  aws cloudformation update-stack --stack-name $STACK --capabilities CAPABILITY_NAMED_IAM \\"
    echo "    --template-url https://$BUCKET.s3.$REGION.amazonaws.com/mrm-upgrade/rollback-$TS/deploy-pipeline.yaml \\"
    echo "    --parameters file://$ROLLBACK_PARAMS"
    echo "The update starts a build of the previous version. Then update the regional hubs again; see Roll back in docs/UPGRADING.md."
}

if [ "$INSTALL" = pipeline ]; then
    step "4. Upgrade the pipeline stack"
    TS=$(date -u +%Y%m%dT%H%M%SZ)
    ROLLBACK_PARAMS="mrm-rollback-$STACK-$TS.json"
    ROLLBACK_TEMPLATE="mrm-rollback-$STACK-$TS.yaml"
    json 'JSON.stringify(d.Stacks[0].Parameters.map(p => ({ ParameterKey: p.ParameterKey, ParameterValue: p.ParameterValue })), null, 2)' \
        <<<"$STACK_JSON" >"$ROLLBACK_PARAMS" || die "Can't write $ROLLBACK_PARAMS"
    aws cloudformation get-template --stack-name "$STACK" --template-stage Original \
        --query TemplateBody --output text >"$ROLLBACK_TEMPLATE" 2>"$WORK/err" \
        || die "Can't save the stack's template: $(cat "$WORK/err")"
    echo "Saved the current parameters to $ROLLBACK_PARAMS and the template to $ROLLBACK_TEMPLATE"

    CHANGE_SET="mrm-upgrade-${TAG//./-}-$TS"
    if [ "$UPGRADE_PATH" = full ]; then
        [ -n "$BUCKET" ] || die "Stack $STACK has no ArtifactBucketName output for the template upload"
        TEMPLATE_KEY="mrm-upgrade/$TAG/deploy-pipeline.yaml"
        aws s3 cp "$TEMPLATE" "s3://$BUCKET/$TEMPLATE_KEY" --only-show-errors 2>"$WORK/err" \
            || die "Can't upload the template to s3://$BUCKET: $(cat "$WORK/err")"
        TEMPLATE_URL="https://$BUCKET.s3.$REGION.amazonaws.com/$TEMPLATE_KEY"
        TEMPLATE_PARAMS=$(aws cloudformation validate-template --template-url "$TEMPLATE_URL" \
            --query 'Parameters[].ParameterKey' --output text 2>"$WORK/err") \
            || die "The template from $TAG doesn't validate: $(cat "$WORK/err")"
        TEMPLATE_ARGS=(--template-url "$TEMPLATE_URL")
    else
        TEMPLATE_PARAMS=$(json 'd.Stacks[0].Parameters.map(p => p.ParameterKey)' <<<"$STACK_JSON")
        TEMPLATE_ARGS=(--use-previous-template)
    fi
    # Every parameter the template and the stack share keeps its value, except
    # GitBranch and --param ones. A parameter new in the template takes its
    # default.
    MRM_TEMPLATE_PARAMS="$TEMPLATE_PARAMS" MRM_OVERRIDES="GitBranch=$TAG"$'\n'"$PARAM_OVERRIDES" json '(() => {
      const have = new Set(d.Stacks[0].Parameters.map(p => p.ParameterKey));
      const overrides = new Map(process.env.MRM_OVERRIDES.split("\n").filter(Boolean)
        .map(kv => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
      const keys = process.env.MRM_TEMPLATE_PARAMS.split(/\s+/).filter(Boolean);
      const unknown = [...overrides.keys()].filter(k => !keys.includes(k));
      if (unknown.length) throw new Error("The template has no parameter " + unknown.join(", "));
      return JSON.stringify(keys.filter(k => overrides.has(k) || have.has(k)).map(k => overrides.has(k)
        ? { ParameterKey: k, ParameterValue: overrides.get(k) }
        : { ParameterKey: k, UsePreviousValue: true }));
    })()' <<<"$STACK_JSON" >"$WORK/parameters.json" 2>"$WORK/err" || die "$(cat "$WORK/err")"

    aws cloudformation create-change-set --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
        --change-set-type UPDATE "${TEMPLATE_ARGS[@]}" --capabilities CAPABILITY_NAMED_IAM \
        --parameters "file://$WORK/parameters.json" --output text --query Id >/dev/null 2>"$WORK/err" \
        || die "Can't create the change set: $(cat "$WORK/err")"
    echo "Created change set $CHANGE_SET. Waiting for it..."
    delete_change_set() {
        aws cloudformation delete-change-set --stack-name "$STACK" --change-set-name "$CHANGE_SET" >/dev/null 2>&1 \
            || warn "Can't delete change set $CHANGE_SET; delete it from the stack's Change sets tab."
    }
    if ! aws cloudformation wait change-set-create-complete --stack-name "$STACK" --change-set-name "$CHANGE_SET" 2>/dev/null; then
        REASON=$(aws cloudformation describe-change-set --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
            --query StatusReason --output text 2>/dev/null)
        delete_change_set
        die "The change set failed: ${REASON:-unknown reason}. The stack is unchanged."
    fi
    CS_JSON=$(aws cloudformation describe-change-set --stack-name "$STACK" --change-set-name "$CHANGE_SET" --output json 2>"$WORK/err") \
        || die "Can't read the change set: $(cat "$WORK/err")"
    # Summary: removed and replaced resources first, then parameter changes.
    SUMMARY=$(MRM_STACK_JSON="$STACK_JSON" json '(() => {
      const old = new Map((JSON.parse(process.env.MRM_STACK_JSON).Stacks[0].Parameters || []).map(p => [p.ParameterKey, p.ParameterValue]));
      const rank = c => c.Action === "Remove" ? 0 : (c.Replacement === "True" || c.Replacement === "Conditional") ? 1 : 2;
      const changes = (d.Changes || []).map(c => c.ResourceChange).filter(Boolean).sort((a, b) => rank(a) - rank(b));
      const lines = changes.map(c => "  " + c.Action + " " + c.LogicalResourceId + " (" + c.ResourceType + ")" +
        (c.Replacement ? " replacement: " + c.Replacement : "") + (rank(c) < 2 ? "  <-- check the release notes" : ""));
      const params = (d.Parameters || []).filter(p => old.get(p.ParameterKey) !== p.ParameterValue).map(p =>
        "  parameter " + p.ParameterKey + ": " + (old.has(p.ParameterKey) ? "\"" + old.get(p.ParameterKey) + "\"" : "(new)") + " -> \"" + p.ParameterValue + "\"");
      const adMode = (d.Parameters || []).find(p => p.ParameterKey === "AdMode");
      const adChanged = adMode && old.has("AdMode") && old.get("AdMode") !== adMode.ParameterValue;
      const adNew = adMode && !old.has("AdMode") && adMode.ParameterValue !== "";
      return lines.concat(params, adChanged || adNew ? ["ADMODE " + (old.get("AdMode") || "(not set)") + " -> " + adMode.ParameterValue] : []);
    })()' <<<"$CS_JSON")
    echo "Change set $CHANGE_SET:"
    printf '%s\n' "$SUMMARY" | grep -v '^ADMODE '
    ADMODE_CHANGE=$(printf '%s\n' "$SUMMARY" | sed -n 's/^ADMODE //p')
    # An AdMode set with --param is the caller's choice.
    if [ -n "$ADMODE_CHANGE" ] && ! printf '%s' "$PARAM_OVERRIDES" | grep -q '^AdMode='; then
        delete_change_set
        die "The change set changes AdMode ($ADMODE_CHANGE), which would switch the directory type. Deleted the change set; the stack is unchanged. Pass --param AdMode=<current mode> and run again."
    fi
    if ! confirm "Execute change set $CHANGE_SET?"; then
        delete_change_set
        echo "Deleted the change set. The stack is unchanged."
        exit 1
    fi
    aws cloudformation execute-change-set --stack-name "$STACK" --change-set-name "$CHANGE_SET" 2>"$WORK/err" \
        || die "Can't execute the change set: $(cat "$WORK/err")"
    echo "Waiting for the stack update..."
    if ! aws cloudformation wait stack-update-complete --stack-name "$STACK" 2>"$WORK/err"; then
        FINAL=$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].StackStatus' --output text 2>/dev/null)
        print_rollback
        die "The stack update ended in ${FINAL:-an unknown state}. Check the stack's Events tab."
    fi
    echo "Stack $STACK updated."

    step "5. Follow the build"
    # The stack update starts a build when GitBranch changes. Start one if it
    # doesn't appear.
    BUILD_ID=""
    for _ in 1 2 3 4 5 6 7 8; do
        LATEST=$(aws codebuild list-builds-for-project --project-name "$PROJECT" --query 'ids[0]' --output text 2>/dev/null)
        if [ -n "$LATEST" ] && [ "$LATEST" != None ] && [ "$LATEST" != "$LAST_BUILD" ]; then
            BUILD_ID="$LATEST"
            break
        fi
        sleep 15
    done
    if [ -z "$BUILD_ID" ]; then
        echo "No build started with the stack update; starting one."
        BUILD_ID=$(aws codebuild start-build --project-name "$PROJECT" --query build.id --output text 2>"$WORK/err") \
            || die "Can't start a build: $(cat "$WORK/err")"
    fi
    echo "Build: $BUILD_ID"
    LAST_PHASE=""
    while true; do
        read -r BUILD_STATUS BUILD_PHASE < <(aws codebuild batch-get-builds --ids "$BUILD_ID" \
            --query 'builds[0].[buildStatus,currentPhase]' --output text 2>/dev/null)
        case "${BUILD_STATUS:-}" in
            IN_PROGRESS)
                if [ "${BUILD_PHASE:-}" != "$LAST_PHASE" ]; then echo "  $(date -u +%H:%M:%S) $BUILD_PHASE"; LAST_PHASE="$BUILD_PHASE"; fi
                sleep 60 ;;
            SUCCEEDED) echo "Build succeeded."; break ;;
            "") sleep 60 ;;
            *)
                LOG_LINK=$(aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].logs.deepLink' --output text 2>/dev/null)
                print_rollback
                die "Build $BUILD_ID ended in $BUILD_STATUS. Log: ${LOG_LINK:-see Build history of project $PROJECT}" ;;
        esac
    done
else
    step "4. Deploy $TAG from the clone"
    PREVIOUS_REF=$(git rev-parse --abbrev-ref HEAD)
    [ "$PREVIOUS_REF" != HEAD ] || PREVIOUS_REF=$(git rev-parse --short HEAD)
    git fetch --quiet "$REPO_URL" "refs/tags/$TAG:refs/tags/$TAG" 2>"$WORK/err" || die "Can't fetch $TAG: $(cat "$WORK/err")"
    git checkout --quiet "$TAG" 2>"$WORK/err" || die "Can't check out $TAG: $(cat "$WORK/err")"
    echo "Checked out $TAG (was $PREVIOUS_REF). Running ./deploy.sh -y"
    if ! ./deploy.sh -y; then
        die "deploy.sh failed. To go back: git checkout $PREVIOUS_REF && ./deploy.sh"
    fi
fi

# ---------------------------------------------------------------------------
step "6. Regional hubs"

# After the deploy, the list API's REGIONAL_HUB_TEMPLATE_VERSION is the
# fingerprint the console compares hubs with.
DEPLOYED_FINGERPRINT=$(aws lambda get-function-configuration --function-name "$ACRONYM_LOWER-list-regional-hubs" \
    --query 'Environment.Variables.REGIONAL_HUB_TEMPLATE_VERSION' --output text 2>/dev/null)
[ "$DEPLOYED_FINGERPRINT" != None ] || DEPLOYED_FINGERPRINT=""
HUBS_AFTER=$(hub_list "${DEPLOYED_FINGERPRINT:-$TARGET_FINGERPRINT}" "$(plan_get HUBS)")
case "$HUBS_AFTER" in
    ERROR*) warn "Can't read the regional hubs: ${HUBS_AFTER#ERROR }"; HUBS_AFTER="" ;;
esac
TO_UPDATE=$(printf '%s\n' "$HUBS_AFTER" | awk -F'\t' '$3 != "no" && $1 != "" {print $1 " (" $4 ")"}')
if [ -z "$TO_UPDATE" ]; then
    echo "No regional hub needs an update."
else
    echo "These regional hubs show Update available:"
    printf '%s\n' "$TO_UPDATE" | sed 's/^/  /'
    echo "Update them in the MRM console, one at a time:"
    echo "  1. Open Regions."
    echo "  2. On the hub's row, click Update, then Update to confirm."
    echo "  3. Wait until the status is Available again before you update the next hub."
    if [ "$(plan_get SESSIONS)" != no ]; then
        echo "  A hub Update can replace the hub's DCV Connection Gateway, which disconnects DCV sessions in that Region."
    fi
fi

echo ""
echo "✅ Upgraded to $TAG. Check the console as in Verify in docs/UPGRADING.md."
[ "$INSTALL" = pipeline ] && print_rollback
exit 0
