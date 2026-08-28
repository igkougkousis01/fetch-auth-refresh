/**
 * An API that signals an expired token with `400` and a body code rather than a
 * plain `401`, and that expects the credential in a custom header.
 *
 * Both of those are authentication *policy*, so both are consumer callbacks.
 */
import { createAuthFetch } from 'fetch-auth-refresh';

const API = 'https://api.example.com';

let apiKey: string | null = null;

const authFetch = createAuthFetch({
  getToken: () => apiKey,

  refreshToken: async ({ rejectedToken }) => {
    // `rejectedToken` is the credential the server refused. If something else
    // in the app has already rotated it, there is nothing to do.
    if (apiKey !== null && apiKey !== rejectedToken) {
      return apiKey;
    }

    const response = await fetch(`${API}/auth/key`, { method: 'POST' });
    if (!response.ok) throw new Error(`Refresh failed: ${response.status}`);

    const data = (await response.json()) as { key: string };
    apiKey = data.key;

    return apiKey;
  },

  // The response handed in is a clone, so reading its body in full here can
  // never consume the response the caller receives.
  isAuthFailure: async (response) => {
    if (response.status === 401) return true;
    if (response.status !== 400) return false;

    const body = (await response.json()) as { code?: string };
    return body.code === 'token_expired';
  },

  // The `request` is always one the library constructed, so mutating its
  // headers in place is safe.
  attachToken: (request, token) => {
    request.headers.set('X-Api-Key', token);
    return request;
  },

  onAuthFailure: ({ request }) => {
    apiKey = null;
    console.error(`Session lost while requesting ${request.url}`);
  },
});

const response = await authFetch(`${API}/me`);
console.log(response.status);
