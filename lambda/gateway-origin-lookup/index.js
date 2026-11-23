// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom resource: values the gateway's CloudFront browser path needs that are
 * only known in the account (lib/dcv-infrastructure-stack.ts).
 *
 * - SubnetIds: the given subnets outside the Availability Zone IDs where
 *   CloudFront VPC origins aren't supported (AZ names map to different IDs in
 *   each account), comma-separated.
 * - PrefixListId: CloudFront's origin-facing prefix list in this Region.
 * - HostedZoneName: the Route 53 hosted zone's domain, when a zone ID is given.
 *
 * Read-only. Nothing to clean up on delete.
 */

// Both clients are provided by the Lambda runtime.
const { EC2Client, DescribeSubnetsCommand, DescribeManagedPrefixListsCommand } = require('@aws-sdk/client-ec2');
const { Route53Client, GetHostedZoneCommand } = require('@aws-sdk/client-route-53');

/**
 * @param {{ SubnetId: string, AvailabilityZoneId: string }[]} subnets
 * @param {string[]} excludedAzIds
 * @param {string[]} order subnet IDs in the order they were given
 */
function selectSubnets(subnets, excludedAzIds, order) {
  const allowed = subnets
    .filter(subnet => !excludedAzIds.includes(subnet.AvailabilityZoneId))
    .sort((a, b) => order.indexOf(a.SubnetId) - order.indexOf(b.SubnetId));
  const zones = new Set(allowed.map(subnet => subnet.AvailabilityZoneId));
  if (zones.size < 2) {
    throw new Error(
      'The CloudFront browser path needs private subnets in at least two Availability Zones that support ' +
      `CloudFront VPC origins (not ${excludedAzIds.join(', ')}). Add subnets in other zones, or set DcvBrowserPath to direct.`);
  }
  // An ALB takes one subnet per zone.
  const seen = new Set();
  return allowed.filter(subnet => !seen.has(subnet.AvailabilityZoneId) && seen.add(subnet.AvailabilityZoneId));
}

async function lookup(props, clients) {
  const subnetIds = props.SubnetIds || [];
  const excluded = props.ExcludedAzIds || [];
  const ec2 = clients.ec2;

  const described = await ec2.send(new DescribeSubnetsCommand({ SubnetIds: subnetIds }));
  const selected = selectSubnets(described.Subnets || [], excluded, subnetIds);

  const lists = await ec2.send(new DescribeManagedPrefixListsCommand({
    Filters: [{ Name: 'prefix-list-name', Values: [props.PrefixListName] }],
  }));
  const prefixListId = lists.PrefixLists && lists.PrefixLists[0] && lists.PrefixLists[0].PrefixListId;
  if (!prefixListId) throw new Error(`Prefix list ${props.PrefixListName} not found`);

  let hostedZoneName = '';
  if (props.HostedZoneId) {
    const zone = await clients.route53.send(new GetHostedZoneCommand({ Id: props.HostedZoneId }));
    hostedZoneName = zone.HostedZone.Name.replace(/\.$/, '');
  }

  return {
    SubnetIds: selected.map(subnet => subnet.SubnetId).join(','),
    PrefixListId: prefixListId,
    HostedZoneName: hostedZoneName,
  };
}

exports.handler = async (event) => {
  console.log('Request:', event.RequestType, JSON.stringify(event.ResourceProperties));
  const physicalId = event.PhysicalResourceId || 'gateway-origin-lookup';
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: physicalId };
  }
  const data = await lookup(event.ResourceProperties, { ec2: new EC2Client({}), route53: new Route53Client({}) });
  console.log('Result:', JSON.stringify(data));
  return { PhysicalResourceId: physicalId, Data: data };
};

// Exported for tests.
exports.lookup = lookup;
exports.selectSubnets = selectSubnets;
