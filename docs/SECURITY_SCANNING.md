# Security Scanning

Scan this repository with [ASH](https://github.com/awslabs/automated-security-helper)
(Automated Security Helper). ASH runs a set of scanners over the source tree,
applies the suppressions in `.ash.yaml`, and writes one combined report.

## Run ASH

ASH 3 needs Python 3.10 or later and [uv](https://docs.astral.sh/uv/). Install it
as a uv tool (pin the release you want):

```bash
uv tool install "automated-security-helper @ git+https://github.com/awslabs/automated-security-helper.git@v3.8.0"
ash dependencies install --tool gitleaks --tool opengrep   # optional binary scanners
```

Then, from the repository root:

```bash
ash --mode local --source-dir . --output-dir .ash/ash_output
```

- `--python-based-scanners-only` runs only the scanners ASH installs from PyPI
  (bandit, checkov, cfn-lint, detect-secrets, semgrep), with no binary downloads.
- `--no-fail-on-findings` reports findings without a non-zero exit code.
- `ash report` prints a short summary of the last scan; the full reports
  (SARIF, HTML, Markdown, JUnit) are in `.ash/ash_output/reports/`. `.ash/` is
  gitignored.

The [ASH GitHub Actions guide](https://awslabs.github.io/automated-security-helper/main/how-to/ci/github-actions/)
covers running the same scan in CI.

## `.ash.yaml`

`.ash.yaml` is ASH's configuration. It sets:

- `global_settings.severity_threshold`: `MEDIUM`. Findings at or above it fail
  the scan.
- `global_settings.ignore_paths`: generated or third-party directories ASH skips
  (`cdk.out*`, `node_modules`, `frontend/dist`, `.ash`), each with a reason.
- `global_settings.suppressions`: reviewed false positives, by rule ID and path
  (and line where the finding is pinned), each with a reason.
- `scanners.semgrep.options.exclude_rule` and
  `scanners.opengrep.options.exclude_rule`: the semgrep rules below.

Add a suppression only with a reason that a reviewer can check against the code.
A suppression pinned to a line goes stale when the file changes: re-check the
line when ASH reports the finding again.

### Documented semgrep exclusions

ASH passes each one to semgrep and opengrep as `--exclude-rule`. The legacy
`npm run security:semgrep` and `scripts/run-security-scans.sh` pass the same list.

| Rule | Reason |
| --- | --- |
| `typescript.react.portability.i18next.jsx-not-internationalized.jsx-not-internationalized` | The admin UI (`frontend/src/**/*.tsx`) is English-only; localization isn't a requirement. |
| `gitlab.nodejs_scan.javascript-ssrf-rule-node_ssrf` | False positive: the frontend's `fetch` URLs (`frontend/src/utils/auth.ts`, `frontend/src/utils/api.ts`) come from the deployment's `config.json` (API URL, Cognito domain, region), not from user input. |
| `python.lang.best-practice.sleep.arbitrary-sleep` | Intentional: the Python Lambdas poll or wait for AWS and Active Directory state, for example AD replication in `lambda/ad-user-manager/index.py` and DCV session status in `lambda/dcv-session-manager/index.py`. |

## What each scanner reads

ASH configures its scanners itself. Most per-tool config files in the tree are
**not** read by ASH; they're kept for the legacy commands below.

| Scanner | Checks | Config file in this repo | Read by ASH? |
| --- | --- | --- | --- |
| bandit | Python security issues | none | ASH passes bandit an empty config; it doesn't read a `.bandit` from the tree. Paths are skipped with `global_settings.ignore_paths`. |
| semgrep / opengrep | Static analysis (TypeScript, JavaScript, Python) | `.semgrepignore` (legacy only) | No. ASH ignores `.semgrepignore`; it uses `ignore_paths` and the `exclude_rule` lists above. |
| checkov | CloudFormation and Dockerfile misconfiguration | `.checkov.yaml` | No. ASH doesn't read a `.checkov.yaml` from the scanned tree, so the `skip-check` list there applies only to `npm run security:checkov`. ASH reports those checks; triage them as ASH suppressions. |
| detect-secrets | Secrets in the working tree | none | Tuned with `.ash.yaml` suppressions. |
| gitleaks | Secrets in the working tree (ASH) or git history (legacy) | `.gitleaks.toml`, `.gitleaksignore` | No. ASH uses gitleaks' default rules and reports findings that `.gitleaksignore` would drop, so they can be suppressed in `.ash.yaml` instead. |
| cfn-lint, cfn-nag, cfn-guard, cdk-nag | CloudFormation templates in the tree (`scripts/*.yaml`) | none | Configured in `.ash.yaml` if needed. The CDK app's own cdk-nag checks run during `cdk synth` (`npm run nag`); see [CDK_NAG.md](CDK_NAG.md). |
| grype, syft, trivy, npm-audit | Dependency vulnerabilities and SBOM | none | Configured in `.ash.yaml` if needed. |

### Why both gitleaks configs and detect-secrets exist

ASH's secret scanners (detect-secrets, and gitleaks when installed) scan the
current working tree. `npm run security:gitleaks` runs `gitleaks detect`, which
scans the **git history** as well. `.gitleaks.toml` (allowlisted paths and
known false-positive patterns) and `.gitleaksignore` (fingerprints of two
historical findings in old commits) exist for that history scan. Keep them
until a history scan runs some other way.

## Legacy scripts

These predate ASH and run each tool directly, if it's installed:

- `npm run security:all` (`scripts/run-security-scans.sh`): bandit, cfn_nag,
  checkov, gitleaks (`--no-git`), semgrep and grype, with reports in
  `security-reports/` (gitignored).
- `npm run security:bandit`, `security:checkov`, `security:gitleaks`,
  `security:semgrep`, `security:cfn-nag`, `security:grype`: one tool each.
  These read `.checkov.yaml`, `.gitleaks.toml` and `.semgrepignore`.

They'll be removed once ASH covers them, apart from the gitleaks history scan.
