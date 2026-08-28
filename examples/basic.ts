/**
 * The whole library in one file: attach a token, refresh once when the server
 * rejects it, retry.
 *
 * Absolute URLs are used throughout because a relative URL has no base outside
 * a browser document — that is the native `Request` constructor's rule, not
 * this library's.
 */
import { createAuthFetch } from 'fetch-auth-refresh';

const API = 'https://api.example.com';

// The library holds no token state, so the consumer keeps it. A module-scoped
// variable is enough here; a real app would use whatever it already uses.
let accessToken: string | null = null;

const authFetch = createAuthFetch({
  getToken: () => accessToken,

  refreshToken: async () => {
    const response = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });

    // Failure is signalled by throwing. A resolved value is always a usable
    // token — there is no `null` sentinel to check for.
    if (!response.ok) {
      throw new Error(`Refresh failed: ${response.status}`);
    }

    const data = (await response.json()) as { accessToken: string };
    accessToken = data.accessToken;

    return accessToken;
  },

  onAuthFailure: () => {
    // Fires once per failed refresh, however many requests were waiting on it.
    accessToken = null;
    console.error('Session could not be recovered.');
  },
});

// One expired token, three concurrent 401s, exactly one refresh call — and all
// three retried with the token it returned.
const [profile, settings, notifications] = await Promise.all([
  authFetch(`${API}/profile`),
  authFetch(`${API}/settings`),
  authFetch(`${API}/notifications`),
]);

console.log(profile.status, settings.status, notifications.status);
