// IPStack lookup — deliberately called from the SERVER (this file, used by
// app/api/iptrack/route.ts), not directly from the browser. IPStack's free
// plan (a) is HTTP-only, which a browser fetch from an HTTPS page would
// block as mixed content, and (b) doesn't send CORS headers, so a direct
// client-side fetch fails either way. Routing through our own API route
// sidesteps both.

export interface IpLookupResult {
  ip: string;
  type?: string;
  continentName?: string;
  countryName?: string;
  countryCode?: string;
  countryFlagEmoji?: string;
  regionName?: string;
  city?: string;
  zip?: string;
  latitude?: number;
  longitude?: number;
  capital?: string;
  callingCode?: string;
  languages?: string[];
  isEu?: boolean;
}

interface IpStackApiResponse {
  ip?: string;
  type?: string;
  continent_name?: string;
  country_name?: string;
  country_code?: string;
  region_name?: string;
  city?: string;
  zip?: string;
  latitude?: number;
  longitude?: number;
  location?: {
    capital?: string;
    calling_code?: string;
    country_flag_emoji?: string;
    is_eu?: boolean;
    languages?: { name?: string }[];
  };
  success?: false;
  error?: { code?: number; type?: string; info?: string };
}

/**
 * Looks up an IP (or hostname) with IPStack and returns a normalized
 * result. Throws a plain Error with a human-readable message on failure —
 * bad key, invalid IP, rate limit, etc.
 */
export async function lookupIp(ip: string, apiKey: string): Promise<IpLookupResult> {
  const target = ip.trim();
  if (!target) throw new Error("No IP address given.");
  if (!apiKey.trim()) throw new Error("No IPStack API key configured.");

  // IPStack's free tier only serves plain HTTP — https:// 403s on that
  // plan. Node's fetch (unlike a browser) isn't blocked by mixed-content
  // rules, so this is safe to call from the server.
  const url = `http://api.ipstack.com/${encodeURIComponent(target)}?access_key=${encodeURIComponent(
    apiKey.trim(),
  )}&format=1`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error("Couldn't reach IPStack — check your internet connection.");
  }

  let data: IpStackApiResponse;
  try {
    data = await res.json();
  } catch {
    throw new Error("IPStack returned an unreadable response.");
  }

  if (data.success === false || !data.ip) {
    const info = data.error?.info;
    throw new Error(info || "IPStack couldn't look up that IP.");
  }

  return {
    ip: data.ip,
    type: data.type,
    continentName: data.continent_name,
    countryName: data.country_name,
    countryCode: data.country_code,
    countryFlagEmoji: data.location?.country_flag_emoji,
    regionName: data.region_name,
    city: data.city,
    zip: data.zip,
    latitude: data.latitude,
    longitude: data.longitude,
    capital: data.location?.capital,
    callingCode: data.location?.calling_code,
    languages: data.location?.languages?.map((l) => l.name).filter((n): n is string => !!n),
    isEu: data.location?.is_eu,
  };
}
