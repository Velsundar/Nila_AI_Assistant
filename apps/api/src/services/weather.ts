/**
 * Weather via Open-Meteo (free, no API key): geocoding API for city -> lat/lon, forecast API for
 * current + daily weather. Results are cached in memory (forecast 30 min, geocoding 24 h).
 */
import type { Weather } from "@nova/shared";
import { config } from "../config";

export type GeoPlace = { name: string; lat: number; lon: number; country?: string; admin1?: string };

export type DayForecast = { condition: string; highC: number; lowC: number; rainChance: number };
export type Forecast = {
  city: string;
  current: { tempC: number; condition: string };
  today: DayForecast;
  tomorrow?: DayForecast;
};

export class WeatherError extends Error {}

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const FORECAST_TTL_MS = 30 * 60_000;
const GEO_TTL_MS = 24 * 3600_000;

let fetchOverride: typeof fetch | undefined;
/** Tests inject a fake fetch; under tests with no override, weather is "unavailable" (no network). */
export function setWeatherFetch(f: typeof fetch | undefined) {
  fetchOverride = f;
  geoCache.clear();
  forecastCache.clear();
}
function doFetch(url: string) {
  if (fetchOverride) return fetchOverride(url);
  if (config.isTest) return Promise.reject(new WeatherError("network disabled in tests"));
  return fetch(url, { signal: AbortSignal.timeout(6000) });
}

/** Renamed cities that Open-Meteo only knows by their current name. */
const CITY_ALIASES: Record<string, string> = {
  bangalore: "Bengaluru",
  bombay: "Mumbai",
  madras: "Chennai",
  calcutta: "Kolkata",
  gurgaon: "Gurugram",
  poona: "Pune",
  trivandrum: "Thiruvananthapuram",
  mysore: "Mysuru",
  baroda: "Vadodara",
  cochin: "Kochi",
  calicut: "Kozhikode",
  benares: "Varanasi",
  pondicherry: "Puducherry",
  mangalore: "Mangaluru",
};

const geoCache = new Map<string, { at: number; place: GeoPlace | null }>();
const forecastCache = new Map<string, { at: number; forecast: Forecast }>();

async function getJson(url: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  let res: Response;
  try {
    res = await doFetch(url);
  } catch (e) {
    throw new WeatherError(`Weather service unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) throw new WeatherError(`Weather service error ${res.status}`);
  return res.json();
}

/** City name -> best place, or null if unknown. Throws WeatherError if the service is down. */
export async function geocodeCity(name: string): Promise<GeoPlace | null> {
  const key = name.trim().toLowerCase();
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < GEO_TTL_MS) return hit.place;
  // Open-Meteo matches on the bare place name ("Pune, India" -> "Pune") and knows no old names.
  const bare = name.split(",")[0].trim();
  const q = CITY_ALIASES[bare.toLowerCase()] ?? bare;
  const data = await getJson(`${GEO_URL}?name=${encodeURIComponent(q)}&count=10&language=en&format=json`);
  type Hit = { name: string; latitude: number; longitude: number; country?: string; admin1?: string; population?: number; feature_code?: string };
  const hits = ((data?.results ?? []) as Hit[]).filter((r) => typeof r.latitude === "number");
  // Prefer real cities: capitals / admin seats, then by population, keeping the API's order as the tie-breaker.
  const rank = (r: Hit) => (/^PPL(C|A)/.test(r.feature_code ?? "") ? 2 : /^PPL/.test(r.feature_code ?? "") ? 1 : 0) * 1e12 + (r.population ?? 0);
  const best = hits.reduce<Hit | undefined>((b, r) => (!b || rank(r) > rank(b) ? r : b), undefined);
  const place: GeoPlace | null = best
    ? { name: best.name, lat: best.latitude, lon: best.longitude, country: best.country, admin1: best.admin1 }
    : null;
  geoCache.set(key, { at: Date.now(), place });
  return place;
}

/** WMO weather interpretation codes -> short spoken condition. */
export function describeWeatherCode(code: number): string {
  if (code === 0) return "Clear sky";
  if (code === 1) return "Mainly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Foggy";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code === 61 || code === 80) return "Light rain";
  if (code === 63 || code === 81) return "Rain";
  if (code === 65 || code === 82) return "Heavy rain";
  if (code === 66 || code === 67) return "Freezing rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code === 85 || code === 86) return "Snow showers";
  if (code === 95) return "Thunderstorm";
  if (code === 96 || code === 99) return "Thunderstorm with hail";
  return "Unsettled";
}

export async function getForecast(place: { name: string; lat: number; lon: number }): Promise<Forecast> {
  const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
  const hit = forecastCache.get(key);
  if (hit && Date.now() - hit.at < FORECAST_TTL_MS) return { ...hit.forecast, city: place.name };
  const url =
    `${FORECAST_URL}?latitude=${place.lat}&longitude=${place.lon}` +
    "&current=temperature_2m,weather_code" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&timezone=auto&forecast_days=2";
  const d = await getJson(url);
  const daily = d?.daily;
  if (!d?.current || !daily?.temperature_2m_max?.length) throw new WeatherError("Weather service returned no data");
  const day = (i: number): DayForecast | undefined =>
    daily.temperature_2m_max[i] === undefined
      ? undefined
      : {
          condition: describeWeatherCode(daily.weather_code?.[i] ?? -1),
          highC: Math.round(daily.temperature_2m_max[i]),
          lowC: Math.round(daily.temperature_2m_min[i]),
          rainChance: Math.round(daily.precipitation_probability_max?.[i] ?? 0),
        };
  const forecast: Forecast = {
    city: place.name,
    current: { tempC: Math.round(d.current.temperature_2m), condition: describeWeatherCode(d.current.weather_code) },
    today: day(0)!,
    ...(day(1) ? { tomorrow: day(1) } : {}),
  };
  forecastCache.set(key, { at: Date.now(), forecast });
  return forecast;
}

export function toWeather(f: Forecast): Weather {
  return {
    city: f.city,
    tempC: f.current.tempC,
    condition: f.current.condition,
    highC: f.today.highC,
    lowC: f.today.lowC,
    rainChance: f.today.rainChance,
  };
}

/** Weather for the user's saved city; undefined (never throws) if unset or the service fails. */
export async function weatherForUser(user: {
  city?: string | null;
  cityLat?: number | null;
  cityLon?: number | null;
}): Promise<Weather | undefined> {
  if (!user.city || typeof user.cityLat !== "number" || typeof user.cityLon !== "number") return undefined;
  try {
    return toWeather(await getForecast({ name: user.city, lat: user.cityLat, lon: user.cityLon }));
  } catch (e) {
    if (!config.isTest) console.warn("[weather]", (e as Error).message);
    return undefined;
  }
}
