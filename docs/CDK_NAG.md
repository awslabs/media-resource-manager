# CDK Nag

[cdk-nag](https://github.com/cdklabs/cdk-nag) checks the CDK app against the
AWS Solutions rule pack (`AwsSolutionsChecks`). It is **opt-in**: it runs only
when you synthesize with `-c nag=true`. A normal `cdk synth`, `cdk deploy` or
pipeline build does not run it, and the templates are the same with or without
the flag (the checks only add annotations).

Turning it on in the build is tracked in
[#61](https://github.com/awslabs/media-resource-manager/issues/61).

## Usage

```bash
# Synthesize with cdk-nag on; findings are printed as synth errors/warnings
npm run nag

# Same synth, plus a summary by severity, rule and stack
npm run nag-report
```

Both commands synthesize into `cdk.out.nag/` (gitignored), so they don't touch
`cdk.out/`. The app needs the same `cdk.json`, `parameters.json`, built
frontend and AWS credentials as a normal synth; pass a profile after `--`, for
example `npm run nag -- --profile <your-profile>`.

- `npm run nag` exits non-zero when there are findings, because the CLI
  reports cdk-nag errors as synth errors.
- `npm run nag-report` runs `scripts/generate-nag-report.sh`. It saves the
  synth output to `reports/cdk-nag-report_<timestamp>.txt` (gitignored),
  prints the counts, and exits 0 once the synth has run. It exits non-zero
  only when the build fails or the synth fails without reporting any finding.
- cdk-nag also writes one CSV report per stack,
  `cdk.out.nag/AwsSolutions-*-NagReport.csv`, listing every rule result with
  its compliance state (non-compliant or suppressed) and suppression reason.

How it is wired: `lib/nag.ts` exports `addNagChecks(app)`, which adds the
`AwsSolutionsChecks` aspect when the `nag` context value is `true`.
`bin/media-resource-manager.ts` calls it after all stacks are created.

## Reading the output

The CDK CLI prints each finding as:

```
ERROR AwsSolutions-IAM5: The IAM entity contains wildcard permissions ... (Construct Annotations)
   MRM-Api/SomeFunction/ServiceRole/DefaultPolicy/Resource
```

`ERROR` is a rule cdk-nag treats as an error, `WARNING` a rule it treats as a
warning. The indented line is the construct path; its first segment is the
stack. Other `ERROR` or `WARNING` lines (for example a context lookup without
credentials) come from CDK itself, not cdk-nag, and the report lists them
separately.

## Current findings

With cdk-nag 2.38.2 (the version in `package-lock.json`), a synth reports
**639 findings** (637 errors, 2 warnings) and 426 suppressed results across
19 stacks. By rule: IAM5 482, L1 96, IAM4 37, SMG4 6, SF1 3, SF2 3, S10 2, and
10 other rules with 1 each. The stacks with the most findings are MRM-Api (92),
MRM-Storage (88) and MRM-DataSync (61).

`AwsSolutions-L1` flags every Lambda function whose runtime is older than the
newest runtime cdk-nag knows about. Its count grows with each cdk-nag upgrade
even when the app does not change, so compare counts only across runs with the
same cdk-nag version. Any future "fail on findings" gate has to handle L1
(suppress it or pin cdk-nag).

These counts are a snapshot; run `npm run nag-report` for the current numbers.

## Suppressions

Suppressions are applied per stack in `bin/media-resource-manager.ts` with
`NagSuppressions.addStackSuppressions(...)`, each with a reason and, for the
IAM rules, an `appliesTo` list. They are written into the templates as
`cdk_nag` metadata whether or not the checks run.

`lib/nag-suppressions.ts` (`NagSuppressionHelper`) is a set of generic,
stack-wide suppression helpers that nothing imports. It is not part of the
current suppression set; calling it would add new suppressions (and change
template metadata), so treat it as a starting point for the triage below, not
as active configuration.

When you add a suppression, scope it as narrowly as you can (`appliesTo`, or
`NagSuppressions.addResourceSuppressions` on one construct) and give a reason
that explains why the finding is acceptable.

## Next steps (#61)

Done: the opt-in flag and report, and this document. Still open:

- Triage the findings stack by stack: fix them, or add scoped suppressions
  with specific reasons.
- When a stack is clean, run the checks by default so new findings fail the
  build. This needs a decision on `AwsSolutions-L1` first.
