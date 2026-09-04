// Pre Token Generation Lambda Trigger
// Reads group membership from the SAML-mapped custom:groups attribute and
// injects it into the cognito:groups claim in the ID token, so the frontend
// and API authorizer can check group membership uniformly by display name
// (e.g. "MRM-Admins") for both native and federated users.
//
// SECURITY BOUNDARY: The custom:groups attribute is merged ONLY for federated
// (SAML) users, because for those users custom:groups is populated by SAML
// attribute mapping on the identity provider side and cannot be self-written
// via UpdateUserAttributes. For native Cognito users, custom:groups has no
// legitimate populator other than admin operations, so trusting it would
// re-open a self-elevation path for any pre-fix stale attribute value.
// Native users derive admin status exclusively from native Cognito group
// membership (existingGroups here, sourced from AdminAddUserToGroup).

exports.handler = async (event) => {
  console.log('Pre Token Generation event:', JSON.stringify(event, null, 2));

  const userAttributes = event.request.userAttributes || {};
  const existingGroups = event.request.groupConfiguration?.groupsToOverride || [];

  // Cognito populates userAttributes.identities as a JSON string for federated
  // users (Okta, Identity Center, Entra ID, etc.) and leaves it absent for
  // native Cognito users. Presence of a non-empty identities value is the
  // trust boundary that gates SAML attribute merging.
  const identities = userAttributes.identities || '';
  const isFederated = typeof identities === 'string' && identities.length > 0;

  let parsedGroups = [];
  if (isFederated) {
    // Federated user: custom:groups was set by the IdP via SAML attribute
    // mapping and is trustworthy. Parse and merge into cognito:groups.
    const customGroups = userAttributes['custom:groups'] || '';
    if (customGroups) {
      try {
        // JSON array format: '["Admin","Editor"]'
        parsedGroups = JSON.parse(customGroups);
        if (!Array.isArray(parsedGroups)) {
          parsedGroups = [parsedGroups];
        }
      } catch (e) {
        // Comma-separated (with optional brackets): "Admin,Editor" or "[Admin,Editor]"
        const cleaned = customGroups.replace(/^\[|\]$/g, '').trim();
        parsedGroups = cleaned.split(',').map(g => g.trim()).filter(g => g);
      }
    }
  } else {
    // Native Cognito user: custom:groups is not trusted for privilege
    // decisions. Any stale value on the user record is intentionally ignored.
    // Native users derive group membership exclusively from Cognito's own
    // group system (existingGroups).
  }

  const allGroups = [...new Set([...existingGroups, ...parsedGroups])];

  console.log('User type:', isFederated ? 'federated' : 'native');
  console.log('Existing groups (native Cognito membership):', existingGroups);
  console.log('SAML groups (custom:groups, federated only):', parsedGroups);
  console.log('Final groups:', allGroups);

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
