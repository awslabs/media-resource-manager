// Pre Token Generation Lambda Trigger
// Reads group membership from SAML-mapped custom:groups attribute
// and injects them into the cognito:groups claim in the ID token.
// This allows the frontend to check group membership for admin access
// using display names (e.g., "Admin") rather than GUIDs.

exports.handler = async (event) => {
  console.log('Pre Token Generation event:', JSON.stringify(event, null, 2));

  const userAttributes = event.request.userAttributes || {};
  const existingGroups = event.request.groupConfiguration?.groupsToOverride || [];

  // Read groups from the custom:groups attribute (populated by SAML IdP mapping)
  const customGroups = userAttributes['custom:groups'] || '';

  // Parse groups - handle multiple formats:
  // - Comma-separated: "Admin,Editor"
  // - JSON array: '["Admin","Editor"]'
  // - Bracketed: "[Admin,Editor]"
  let parsedGroups = [];
  if (customGroups) {
    try {
      // Try JSON array first
      parsedGroups = JSON.parse(customGroups);
      if (!Array.isArray(parsedGroups)) {
        parsedGroups = [parsedGroups];
      }
    } catch (e) {
      // Fall back to comma-separated (with optional brackets)
      const cleaned = customGroups.replace(/^\[|\]$/g, '').trim();
      parsedGroups = cleaned.split(',').map(g => g.trim()).filter(g => g);
    }
  }

  // Merge with any existing Cognito groups (from native group membership)
  const allGroups = [...new Set([...existingGroups, ...parsedGroups])];

  console.log('Existing groups:', existingGroups);
  console.log('SAML groups (custom:groups):', parsedGroups);
  console.log('Final groups:', allGroups);

  // Override the groups in the token
  event.response = {
    claimsOverrideDetails: {
      groupOverrideDetails: {
        groupsToOverride: allGroups,
      },
    },
  };

  console.log('Response:', JSON.stringify(event.response, null, 2));

  return event;
};
