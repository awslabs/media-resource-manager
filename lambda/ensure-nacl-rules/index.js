// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Custom Resource Lambda: Ensure NACL rules for DCV UDP traffic
 * 
 * When deploying into an imported VPC, the existing NACLs may not allow
 * UDP traffic required by DCV Connection Gateway (QUIC on ports 8443/8444).
 * This Lambda checks and adds the necessary NACL rules if missing.
 */

const { EC2Client, DescribeNetworkAclsCommand, CreateNetworkAclEntryCommand } = require('@aws-sdk/client-ec2');

const ec2 = new EC2Client();

// Rule numbers we'll use (high numbers to avoid conflicts with existing rules)
const INBOUND_UDP_RULE_NUMBER = 150;
const OUTBOUND_UDP_RULE_NUMBER = 150;

/**
 * Check if a NACL already has a rule that covers UDP traffic for DCV QUIC.
 * For outbound, we need ephemeral ports (1024-65535) since NACLs are stateless
 * and the gateway responds to the client's ephemeral source port.
 * For inbound, we need ports 8443-8444 where the gateway listens.
 */
function hasUdpCoverage(entries, egress, fromPort, toPort) {
  return entries.some(entry => {
    if (entry.Egress !== egress) return false;
    if (entry.RuleAction !== 'allow') return false;
    // Protocol -1 means all traffic
    if (entry.Protocol === '-1') return true;
    // Protocol 17 is UDP
    if (entry.Protocol === '17' && entry.PortRange) {
      return entry.PortRange.From <= fromPort && entry.PortRange.To >= toPort;
    }
    return false;
  });
}

async function ensureNaclRules(subnetIds) {
  // Get NACLs for the given subnets
  const describeResult = await ec2.send(new DescribeNetworkAclsCommand({
    Filters: [{ Name: 'association.subnet-id', Values: subnetIds }]
  }));

  const results = [];

  for (const nacl of describeResult.NetworkAcls || []) {
    const naclId = nacl.NetworkAclId;
    const entries = nacl.Entries || [];
    const associatedSubnets = (nacl.Associations || []).map(a => a.SubnetId);

    console.log(`Checking NACL ${naclId} (subnets: ${associatedSubnets.join(', ')})`);

    // Check inbound UDP coverage for ports 8443-8444
    const hasInboundUdp = hasUdpCoverage(entries, false, 8443, 8444);
    // Check outbound UDP coverage - NACLs are stateless, so outbound needs
    // ephemeral ports (1024-65535) for QUIC responses to client source ports
    const hasOutboundUdp = hasUdpCoverage(entries, true, 1024, 65535);

    if (!hasInboundUdp) {
      console.log(`Adding inbound UDP 8443-8444 rule to NACL ${naclId}`);
      // Check if our rule number is already taken
      const ruleExists = entries.some(e => !e.Egress && e.RuleNumber === INBOUND_UDP_RULE_NUMBER);
      if (!ruleExists) {
        await ec2.send(new CreateNetworkAclEntryCommand({
          NetworkAclId: naclId,
          RuleNumber: INBOUND_UDP_RULE_NUMBER,
          Protocol: '17', // UDP
          RuleAction: 'allow',
          Egress: false,
          CidrBlock: '0.0.0.0/0',
          PortRange: { From: 8443, To: 8444 }
        }));
        results.push(`Added inbound UDP 8443-8444 to ${naclId}`);
      } else {
        console.log(`Rule number ${INBOUND_UDP_RULE_NUMBER} already exists on inbound, skipping`);
      }
    } else {
      console.log(`NACL ${naclId} already allows inbound UDP 8443-8444`);
    }

    if (!hasOutboundUdp) {
      console.log(`Adding outbound UDP 1024-65535 rule to NACL ${naclId}`);
      const ruleExists = entries.some(e => e.Egress && e.RuleNumber === OUTBOUND_UDP_RULE_NUMBER);
      if (!ruleExists) {
        await ec2.send(new CreateNetworkAclEntryCommand({
          NetworkAclId: naclId,
          RuleNumber: OUTBOUND_UDP_RULE_NUMBER,
          Protocol: '17', // UDP
          RuleAction: 'allow',
          Egress: true,
          CidrBlock: '0.0.0.0/0',
          PortRange: { From: 1024, To: 65535 }
        }));
        results.push(`Added outbound UDP 1024-65535 to ${naclId}`);
      } else {
        console.log(`Rule number ${OUTBOUND_UDP_RULE_NUMBER} already exists on outbound, skipping`);
      }
    } else {
      console.log(`NACL ${naclId} already allows outbound UDP 1024-65535`);
    }
  }

  return results;
}

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const requestType = event.RequestType;
  const subnetIds = event.ResourceProperties.SubnetIds || [];

  try {
    if (requestType === 'Create' || requestType === 'Update') {
      const results = await ensureNaclRules(subnetIds);
      console.log('Results:', results);
      return {
        PhysicalResourceId: `nacl-rules-${Date.now()}`,
        Data: { RulesAdded: results.join('; ') || 'No changes needed' }
      };
    }

    // On Delete, we don't remove the rules — they're harmless and the VPC
    // may still need them for other deployments
    return {
      PhysicalResourceId: event.PhysicalResourceId || `nacl-rules-noop`,
      Data: { Message: 'NACL rules retained on delete (harmless)' }
    };
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};
