// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * mrm-get-storage-pricing - fetch live AWS FSx pricing from the Price List
 * Query API and return a compact rate table for the create-storage UI to
 * compute per-configuration monthly cost estimates.
 *
 * Design notes
 * ------------
 * The Price List Query API only exists in us-east-1 and ap-south-1, so this
 * Lambda always talks to us-east-1 for the pricing endpoint regardless of
 * which Region MRM is deployed in. Prices for other Regions are looked up
 * via the `regionCode` product-attribute filter, not the SDK endpoint.
 *
 * A short in-memory cache keyed by region avoids hammering the Pricing API
 * across warm container invocations. The API is slow (multiple seconds per
 * call) and its rates change on the order of quarters, not requests, so a
 * 6 hour TTL is plenty.
 *
 * If any product family fails to fetch, the response omits it rather than
 * failing the whole call - the frontend hides the estimate for whatever it
 * cannot price, and never blocks the create flow.
 */
const { PricingClient, GetProductsCommand } = require('@aws-sdk/client-pricing');

const pricing = new PricingClient({ region: 'us-east-1' });

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map(); // region -> { at: number, payload: object }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
  'Access-Control-Allow-Methods': 'GET,OPTIONS'
};

/**
 * Read every price-list entry for a single (fileSystemType, region) pair.
 * Handles pagination and returns each entry as its parsed product+terms
 * object. The Pricing API returns each entry as a stringified JSON blob
 * inside the top-level `PriceList` array; we parse them here so the rest
 * of the code operates on real objects.
 */
async function fetchAllProducts(fileSystemType, region) {
  const products = [];
  let nextToken;
  do {
    const resp = await pricing.send(new GetProductsCommand({
      ServiceCode: 'AmazonFSx',
      Filters: [
        { Type: 'TERM_MATCH', Field: 'fileSystemType', Value: fileSystemType },
        { Type: 'TERM_MATCH', Field: 'regionCode',      Value: region },
      ],
      MaxResults: 100,
      NextToken: nextToken,
    }));
    for (const raw of resp.PriceList || []) {
      try { products.push(JSON.parse(raw)); }
      catch (err) { console.warn('Failed to parse PriceList entry:', err.message); }
    }
    nextToken = resp.NextToken;
  } while (nextToken);
  return products;
}

/**
 * From a parsed product, pull the first on-demand USD rate. The Pricing
 * response nests: terms.OnDemand.{sku-hash}.priceDimensions.{sku-hash}
 * .pricePerUnit.USD. There is only ever one entry at each level for these
 * FSx storage/throughput products, so it is safe to take the first.
 */
function priceOf(product) {
  const od = product && product.terms && product.terms.OnDemand;
  if (!od) return null;
  const term = Object.values(od)[0];
  if (!term || !term.priceDimensions) return null;
  const dim = Object.values(term.priceDimensions)[0];
  const usd = dim && dim.pricePerUnit && dim.pricePerUnit.USD;
  return usd ? parseFloat(usd) : null;
}

/**
 * Reduce the FSx-Windows product list into the compact rate table the UI
 * consumes. The frontend never sees raw Pricing-API shape.
 *
 * Shape:
 *   storage: { SSD: { 'single-az': $/GB-Mo, 'multi-az': $/GB-Mo }, HDD: {...} }
 *   throughput: { 'single-az': $/MiBps-Mo, 'multi-az': $/MiBps-Mo }
 *   backup: { 'single-az': $/GB-Mo, 'multi-az': $/GB-Mo }
 */
function extractFsxWindowsRates(products) {
  const rates = {
    storage: { SSD: {}, HDD: {} },
    throughput: {},
    backup: {},
  };
  for (const p of products) {
    const a = (p.product && p.product.attributes) || {};
    const family = p.product && p.product.productFamily;
    const deployment = (a.deploymentOption || '').toLowerCase(); // 'single-az' | 'multi-az'
    if (deployment !== 'single-az' && deployment !== 'multi-az') continue;
    const usd = priceOf(p);
    if (usd === null) continue;

    if (family === 'Storage' && (a.storageType === 'SSD' || a.storageType === 'HDD')) {
      rates.storage[a.storageType][deployment] = usd;
    } else if (family === 'Storage' && (a.usagetype || '').includes('BackupUsage')) {
      rates.backup[deployment] = usd;
    } else if (family === 'Provisioned Throughput') {
      rates.throughput[deployment] = usd;
    }
    // Provisioned IOPS omitted - the create flow does not surface a knob
    // for provisioned IOPS above defaults, so including it would only add
    // noise to the estimate.
  }
  return rates;
}

async function buildFsxWindowsSection(region) {
  try {
    const products = await fetchAllProducts('Windows', region);
    if (products.length === 0) return null;
    return extractFsxWindowsRates(products);
  } catch (err) {
    console.warn(`FSx Windows price fetch failed for ${region}: ${err.name} ${err.message}`);
    return null;
  }
}

async function getPayloadForRegion(region) {
  const now = Date.now();
  const cached = cache.get(region);
  if (cached && (now - cached.at) < CACHE_TTL_MS) {
    return { ...cached.payload, cacheHit: true };
  }
  const fsxWindows = await buildFsxWindowsSection(region);
  const payload = {
    region,
    currency: 'USD',
    unit: 'per month',
    asOf: new Date().toISOString(),
    source: 'AWS Price List Query API',
    fsxWindows,
  };
  cache.set(region, { at: now, payload });
  return { ...payload, cacheHit: false };
}

exports.handler = async (event) => {
  const region = (event.queryStringParameters && event.queryStringParameters.region)
    || process.env.AWS_REGION
    || 'us-east-1';

  try {
    const payload = await getPayloadForRegion(region);
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify(payload),
    };
  } catch (err) {
    console.error('Unexpected pricing error:', err);
    return {
      statusCode: 200, // Never block the create flow; return empty rates so
                       // the UI simply hides the estimate.
      headers: corsHeaders,
      body: JSON.stringify({ region, currency: 'USD', unit: 'per month', fsxWindows: null, error: err.message }),
    };
  }
};
