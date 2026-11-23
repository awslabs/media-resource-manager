// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom resource: a customer-managed prefix list holding every IPv4 CIDR
 * block associated with a VPC (lib/dcv-infrastructure-stack.ts).
 *
 * An imported VPC can have secondary CIDR blocks, and MRM's subnets may sit in
 * any of them. Security group rules that mean "from within the VPC" reference
 * this list, so they cover every block. The stack updates the resource on each
 * deploy, so a block associated later is added on the next deploy.
 *
 * Physical ID: the prefix list ID. Data: PrefixListId.
 */

// Provided by the Lambda runtime.
const {
  EC2Client,
  DescribeVpcsCommand,
  CreateManagedPrefixListCommand,
  DescribeManagedPrefixListsCommand,
  GetManagedPrefixListEntriesCommand,
  ModifyManagedPrefixListCommand,
  DeleteManagedPrefixListCommand,
} = require('@aws-sdk/client-ec2');

// IPv4 CIDR blocks per VPC: 5 by default. MaxEntries is what a referencing
// security group rule counts against the rules-per-group quota.
const MIN_MAX_ENTRIES = 5;
const DESCRIPTION = 'VPC CIDR block';

/** Associated IPv4 CIDR blocks of a VPC, primary first. */
async function vpcCidrs(ec2, vpcId) {
  const result = await ec2.send(new DescribeVpcsCommand({ VpcIds: [vpcId] }));
  const vpc = result.Vpcs && result.Vpcs[0];
  if (!vpc) throw new Error(`VPC ${vpcId} not found`);
  const associated = (vpc.CidrBlockAssociationSet || [])
    .filter(a => a.CidrBlockState && a.CidrBlockState.State === 'associated')
    .map(a => a.CidrBlock);
  const cidrs = [vpc.CidrBlock, ...associated].filter(Boolean);
  return [...new Set(cidrs)];
}

async function waitForState(ec2, prefixListId, sleep) {
  for (let i = 0; i < 30; i++) {
    const result = await ec2.send(new DescribeManagedPrefixListsCommand({ PrefixListIds: [prefixListId] }));
    const list = result.PrefixLists[0];
    if (list.State.endsWith('-complete')) return list;
    if (list.State.endsWith('-failed')) throw new Error(`Prefix list ${prefixListId}: ${list.State} ${list.StateMessage || ''}`);
    await sleep(2000);
  }
  throw new Error(`Prefix list ${prefixListId} did not settle`);
}

async function create(ec2, props, sleep) {
  const cidrs = await vpcCidrs(ec2, props.VpcId);
  const result = await ec2.send(new CreateManagedPrefixListCommand({
    PrefixListName: props.PrefixListName,
    AddressFamily: 'IPv4',
    MaxEntries: Math.max(MIN_MAX_ENTRIES, cidrs.length),
    Entries: cidrs.map(Cidr => ({ Cidr, Description: DESCRIPTION })),
    TagSpecifications: [{ ResourceType: 'prefix-list', Tags: [{ Key: props.TagKey, Value: props.TagValue }] }],
  }));
  const id = result.PrefixList.PrefixListId;
  await waitForState(ec2, id, sleep);
  return id;
}

/** Make the list's entries match the VPC's CIDR blocks. */
async function sync(ec2, prefixListId, vpcId, sleep) {
  const cidrs = await vpcCidrs(ec2, vpcId);
  let list = await waitForState(ec2, prefixListId, sleep);
  const current = (await ec2.send(new GetManagedPrefixListEntriesCommand({ PrefixListId: prefixListId }))).Entries || [];
  const have = current.map(e => e.Cidr);
  const add = cidrs.filter(c => !have.includes(c));
  const remove = have.filter(c => !cidrs.includes(c));
  if (!add.length && !remove.length) return;

  // MaxEntries can't change in the same call as the entries.
  if (cidrs.length > list.MaxEntries) {
    await ec2.send(new ModifyManagedPrefixListCommand({ PrefixListId: prefixListId, MaxEntries: cidrs.length }));
    list = await waitForState(ec2, prefixListId, sleep);
  }
  await ec2.send(new ModifyManagedPrefixListCommand({
    PrefixListId: prefixListId,
    CurrentVersion: list.Version,
    ...(add.length ? { AddEntries: add.map(Cidr => ({ Cidr, Description: DESCRIPTION })) } : {}),
    ...(remove.length ? { RemoveEntries: remove.map(Cidr => ({ Cidr })) } : {}),
  }));
  await waitForState(ec2, prefixListId, sleep);
}

async function handle(event, ec2, sleep = ms => new Promise(r => setTimeout(r, ms))) {
  const props = event.ResourceProperties;
  if (event.RequestType === 'Create') {
    const id = await create(ec2, props, sleep);
    return { PhysicalResourceId: id, Data: { PrefixListId: id } };
  }
  const id = event.PhysicalResourceId;
  if (event.RequestType === 'Update') {
    // Another VPC or name: a new list. CloudFormation then deletes the old one.
    const old = event.OldResourceProperties || {};
    if (old.VpcId !== props.VpcId || old.PrefixListName !== props.PrefixListName) {
      const newId = await create(ec2, props, sleep);
      return { PhysicalResourceId: newId, Data: { PrefixListId: newId } };
    }
    await sync(ec2, id, props.VpcId, sleep);
    return { PhysicalResourceId: id, Data: { PrefixListId: id } };
  }
  // Delete. Rules that reference the list are deleted first (they depend on it).
  if (id && id.startsWith('pl-')) {
    try {
      await ec2.send(new DeleteManagedPrefixListCommand({ PrefixListId: id }));
    } catch (error) {
      if (!/NotFound/i.test(error.name || '') && !/NotFound/i.test(error.Code || '')) throw error;
    }
  }
  return { PhysicalResourceId: id };
}

exports.handler = async (event) => {
  console.log('Request:', event.RequestType, JSON.stringify(event.ResourceProperties));
  return handle(event, new EC2Client({}));
};

// Exported for tests.
exports.handle = handle;
exports.vpcCidrs = vpcCidrs;
