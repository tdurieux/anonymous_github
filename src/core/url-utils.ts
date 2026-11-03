export function joinUrl(base: string, pathname: string): string {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const normalizedPath = pathname.replace(/^\/+/, "");
  return new URL(normalizedPath, normalizedBase).toString();
}
