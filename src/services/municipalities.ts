import { municipalitySlug } from "../domain/events";

// Official municipal coordinates, independent of current event availability.
// https://www.idescat.cat/dev/api/emex/ (f328 longitude, f329 latitude).
// The same cached request serves every town; no user preference is transmitted.
const COORDINATES_ENDPOINT = "https://api.idescat.cat/emex/v1/dades.json?i=f328%2Cf329&tipus=mun";

interface MunicipalityPayload {
  fitxes?: {
    cols?: { col?: Array<{ scheme?: string; content?: string }> };
    indicadors?: { i?: Array<{ id?: string; v?: string }> };
  };
}

function normalizedMunicipality(name: string): string {
  // Idescat places articles after the name, e.g. "Hospitalet de Llobregat, l'".
  return municipalitySlug(name.replace(/^(.+),\s*(el|els|la|les|l'|es|eth|era|los|ses)$/i, "$2 $1"));
}

export async function getMunicipalityCoordinates(name: string): Promise<{ latitude: number; longitude: number } | undefined> {
  const slug = normalizedMunicipality(name);
  if (!slug) return undefined;
  const response = await fetch(COORDINATES_ENDPOINT, {
    headers: { Accept: "application/json" },
    cf: { cacheEverything: true, cacheTtl: 86_400 },
    signal: AbortSignal.timeout(6_000)
  });
  if (!response.ok) throw new Error(`Municipality API returned ${response.status}`);
  const payload = await response.json() as MunicipalityPayload | null;
  const columns = payload?.fitxes?.cols?.col;
  const indicators = payload?.fitxes?.indicadors?.i;
  if (!Array.isArray(columns) || !Array.isArray(indicators)) return undefined;
  const matches = columns.flatMap((column, index) =>
    column?.scheme === "mun" && typeof column.content === "string" && normalizedMunicipality(column.content) === slug ? [index] : []);
  if (matches.length !== 1) return undefined;
  const index = matches[0]!;
  const coordinate = (id: string, minimum: number, maximum: number): number | undefined => {
    const values = indicators.find((indicator) => indicator?.id === id)?.v;
    if (typeof values !== "string") return undefined;
    const parts = values.split(",");
    if (parts.length !== columns.length || !parts[index]?.trim()) return undefined;
    const value = Number(parts[index]);
    return Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
  };
  const latitude = coordinate("f329", -90, 90);
  const longitude = coordinate("f328", -180, 180);
  return latitude === undefined || longitude === undefined ? undefined : { latitude, longitude };
}
