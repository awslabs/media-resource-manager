// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keeps the IAM role and instance profile names a regional hub already has.
 *
 * CloudFormation replaces a role or instance profile when its name changes.
 * Hubs created before IAM names got a region suffix use names like
 * `<ProductName>-Regional-Workstation-Role`. Renaming them on update would
 * delete the instance profile that running workstations use, and the primary
 * region's iam:PassRole statements name the old workstation role. So an update
 * keeps whatever name each role and profile in the deployed stack has.
 */

const NAME_PROPERTY_BY_TYPE = {
  'AWS::IAM::Role': 'RoleName',
  'AWS::IAM::InstanceProfile': 'InstanceProfileName',
};

/**
 * Sets each role and instance profile in `template` to the name the same
 * logical ID has in `deployedTemplate`. Changes `template` in place.
 *
 * @param {object} template - The newly generated template
 * @param {object} deployedTemplate - The template the hub's stack runs now
 * @returns {string[]} Logical IDs whose name was changed back
 */
function keepDeployedIamNames(template, deployedTemplate) {
  const deployedResources = (deployedTemplate && deployedTemplate.Resources) || {};
  const kept = [];
  for (const [logicalId, resource] of Object.entries(template.Resources || {})) {
    const nameProperty = NAME_PROPERTY_BY_TYPE[resource.Type];
    const deployed = deployedResources[logicalId];
    if (!nameProperty || !deployed || deployed.Type !== resource.Type) continue;

    const deployedName = (deployed.Properties || {})[nameProperty];
    const properties = resource.Properties || (resource.Properties = {});
    if (JSON.stringify(deployedName) === JSON.stringify(properties[nameProperty])) continue;

    // A deployed resource without a name has a name CloudFormation generated.
    if (deployedName === undefined) delete properties[nameProperty];
    else properties[nameProperty] = deployedName;
    kept.push(logicalId);
  }
  return kept;
}

module.exports = { keepDeployedIamNames };
