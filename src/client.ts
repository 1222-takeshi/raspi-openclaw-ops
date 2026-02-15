export function buildMetricsUrl(pathname: string, search: string) {
  const sp = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const token = sp.get('token');
  const url = new URL(pathname, 'http://localhost');
  if (token) url.searchParams.set('token', token);
  return url.pathname + url.search;
}
