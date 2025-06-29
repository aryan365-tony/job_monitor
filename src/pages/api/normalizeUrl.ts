// utils/normalizeUrl.ts
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim().toLowerCase());
    u.hash = '';
    // Remove common tracking parameters
    u.searchParams.forEach((_, key) => {
      if (key.startsWith('utm_')) u.searchParams.delete(key);
    });
    // Remove trailing slash
    u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return url.trim().toLowerCase();
  }
}
