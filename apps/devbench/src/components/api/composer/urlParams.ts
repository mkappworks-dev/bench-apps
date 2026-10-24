export interface UrlParam {
  key: string;
  value: string;
}

function decodeQueryPart(value: string): string {
  const spaces = value.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaces);
  } catch {
    // Partial escapes are normal while a URL is being typed.
    return spaces;
  }
}

export function splitUrlAndParams(url: string): { base: string; params: UrlParam[]; fragment: string } {
  const hash = url.indexOf("#");
  const fragment = hash < 0 ? "" : url.slice(hash);
  const address = hash < 0 ? url : url.slice(0, hash);
  const question = address.indexOf("?");
  if (question < 0) return { base: address, params: [], fragment };
  const params = address.slice(question + 1).split("&").filter(Boolean).map((pair) => {
    const equals = pair.indexOf("=");
    return {
      key: decodeQueryPart(equals < 0 ? pair : pair.slice(0, equals)),
      value: decodeQueryPart(equals < 0 ? "" : pair.slice(equals + 1)),
    };
  });
  return { base: address.slice(0, question), params, fragment };
}

export function joinUrlAndParams(base: string, params: UrlParam[], fragment = ""): string {
  const qs = params
    .filter((p) => p.key)
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join("&");
  return `${base}${qs ? `?${qs}` : ""}${fragment}`;
}
