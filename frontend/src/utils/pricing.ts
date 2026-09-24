// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cost estimator for the create-storage UI. Rates come from the
 * /storage/pricing backend endpoint (live AWS Price List Query API); this
 * module contains only pure arithmetic so the same estimator can be reused
 * from tests, Storybook, or a future review step.
 *
 * Everything here is public-pricing math. It intentionally excludes:
 *   - cross-AZ data transfer (workload-dependent)
 *   - provisioned SSD IOPS above the free-tier default (3 IOPS/GiB)
 *   - backup storage growth beyond the initial file system size
 *   - Reserved or Savings-Plan discounts
 * The caller is expected to surface these caveats to the user.
 */
import type { FsxWindowsRates } from './storageApi';

export interface FsxWindowsEstimateInput {
  resilience?: 'single-az' | 'multi-az';
  storageType?: 'SSD' | 'HDD';
  /** GiB */
  ssdStorageCapacity?: number;
  /** MiBps */
  throughputCapacity?: number;
  /** Days of daily backups; 0 means backups disabled. */
  automaticBackupRetentionPeriod?: number;
}

export interface FsxWindowsEstimateBreakdown {
  storage?: number;
  throughput?: number;
  backup?: number;
}

export interface FsxWindowsEstimate {
  total: number;
  breakdown: FsxWindowsEstimateBreakdown;
  /** True when every priced line item had a live rate available - callers
   *  can decide whether to render "$X" with an "excluding …" disclaimer or
   *  just "~$X" when partial. */
  complete: boolean;
}

/**
 * Compute the estimated monthly cost of an FSx Windows file system given
 * a config and a live rate table. Returns null when no line item could be
 * priced (e.g. Pricing API returned nothing for this Region), so callers
 * can hide the estimate entirely instead of showing $0.
 *
 * Backup cost approximates "one backup per day retained for N days" as
 * `storage × retention days / 30`, which matches the AWS pricing guidance
 * for the initial file system size before backup-storage growth.
 */
export function estimateFsxWindowsMonthlyCost(
  input: FsxWindowsEstimateInput,
  rates: FsxWindowsRates | null | undefined
): FsxWindowsEstimate | null {
  if (!rates) return null;

  const resilience: 'single-az' | 'multi-az' = input.resilience || 'multi-az';
  const storageType: 'SSD' | 'HDD' = input.storageType || 'SSD';
  const capacity = Number(input.ssdStorageCapacity) || 0;
  const throughput = Number(input.throughputCapacity) || 0;
  const retention = Number(input.automaticBackupRetentionPeriod) || 0;

  const storageRate = rates.storage?.[storageType]?.[resilience];
  const throughputRate = rates.throughput?.[resilience];
  const backupRate = rates.backup?.[resilience];

  const breakdown: FsxWindowsEstimateBreakdown = {};
  let complete = true;

  if (storageRate !== undefined && capacity > 0) {
    breakdown.storage = storageRate * capacity;
  } else if (capacity > 0) {
    complete = false;
  }

  if (throughputRate !== undefined && throughput > 0) {
    breakdown.throughput = throughputRate * throughput;
  } else if (throughput > 0) {
    complete = false;
  }

  if (retention > 0 && backupRate !== undefined && capacity > 0) {
    // "Daily backup retained for N days" ≈ N × daily rate. AWS bills backup
    // storage as GB-Mo, and one 30-day-retained backup ≈ 1 GB × 1 mo, so
    // divide by 30 to normalise retention days into a monthly figure.
    breakdown.backup = backupRate * capacity * (retention / 30);
  } else if (retention > 0 && capacity > 0 && backupRate === undefined) {
    complete = false;
  }

  const total = (breakdown.storage || 0) + (breakdown.throughput || 0) + (breakdown.backup || 0);
  if (total === 0 && !complete) return null;

  return { total, breakdown, complete };
}

/** Format a USD amount for display: whole dollars, thousand separators.
 *  Under $10, show one decimal so the number does not read as "$0". */
export function formatUsd(amount: number): string {
  if (!isFinite(amount) || amount < 0) return '-';
  if (amount === 0) return '$0';
  if (amount < 10) return `$${amount.toFixed(2)}`;
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}
