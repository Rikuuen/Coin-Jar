import { handleAuthRequest, NEON_AUTH_SESSION_COOKIE_NAME } from '@neon/auth/server';

export function neonSessionAuthenticator(baseUrl: string, origin: string) {
  return async (request: Request): Promise<string | undefined> => {
    const cookies = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${NEON_AUTH_SESSION_COOKIE_NAME}=`));
    if (cookies.length !== 1 || cookies[0].length > 4096) return undefined;
    const upstreamRequest = new Request(`${origin}/api/auth/get-session?disableCookieCache=true`, { headers: { cookie: cookies[0], origin } });
    const response = await handleAuthRequest(baseUrl, upstreamRequest, 'get-session');
    if (response.status >= 500) throw new Error('Authentication service unavailable');
    if (!response.ok) return undefined;
    const value = await response.json();
    const user = value?.user, session = value?.session;
    const expiry = Date.parse(session?.expiresAt ?? '');
    return typeof user?.id === 'string' && user.id.length > 0 && user.id.length <= 255 && user.banned !== true && session?.userId === user.id && Number.isFinite(expiry) && expiry > Date.now() ? user.id : undefined;
  };
}
