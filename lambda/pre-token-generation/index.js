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

//
// LOGGING: the event carries the user's email address, username and other
// attributes, and the response carries group names. Log only the trigger
// source, the user type, group counts and, on failure, the error class.

exports.handler = async (event) => {
  try {
    return buildResponse(event);
  } catch (error) {
    console.error('Pre Token Generation failed:', JSON.stringify({
      triggerSource: event?.triggerSource,
      errorClass: error?.name || typeof error,
    }));
    throw error;
  }
};

function buildResponse(event) {
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

  console.log('Pre Token Generation:', JSON.stringify({
    triggerSource: event.triggerSource,
    userType: isFederated ? 'federated' : 'native',
    nativeGroupCount: existingGroups.length,
    samlGroupCount: parsedGroups.length,
    groupCount: allGroups.length,
  }));

  event.response = {
    claimsOverrideDetails: {
      groupOverrideDetails: {
        groupsToOverride: allGroups,
      },
    },
  };

  return event;
}
