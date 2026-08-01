export interface UrlParam {
  key: string;
  value: string;
}

export function splitUrlAndParams(url: string): { base: string; params: UrlParam[] } {
  const [base, qs = ""] = url.split("?");
  const params = qs
    ? qs
        .split("&")
        .filter(Boolean)
        .map((pair) => {
          const [k, v = ""] = pair.split("=");
          return { key: decodeURIComponent(k), value: decodeURIComponent(v) };
        })
    : [];
  return { base, params };
}

export function joinUrlAndParams(base: string, params: UrlParam[]): string {
  const qs = params
    .filter((p) => p.key)
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join("&");
  return qs ? `${base}?${qs}` : base;
}
