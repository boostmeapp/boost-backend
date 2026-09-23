/**
 * The name shown for a user: username first, then the legacy first/last name
 * pair, then a fallback. New accounts only set a username, so anything that
 * reads firstName directly shows "Anonymous" for them.
 */
export const displayName = (
  user?: {
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  } | null,
  fallback = 'Someone',
): string => {
  const username = user?.username?.trim();
  if (username) return username;

  const full = `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
  return full || fallback;
};
