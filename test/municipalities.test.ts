import { afterEach, describe, expect, it, vi } from "vitest";
import { getMunicipalityCoordinates } from "../src/services/municipalities";

// Shape and field IDs from https://www.idescat.cat/dev/api/emex/.
// Coordinates are aligned to cols.col, not to the indicator's position.
function payload() {
  return { fitxes: {
    cols: { col: [
      { scheme: "mun", id: "170237", content: "Blanes" },
      { scheme: "mun", id: "081017", content: "Hospitalet de Llobregat, l'" },
      { scheme: "mun", id: "250024", content: "Àger" }
    ] },
    indicadors: { i: [
      { id: "f329", v: "41.674000,41.359700,42.002881" },
      { id: "f328", v: "2.790000,2.099700,0.762617" }
    ] }
  } };
}

function respond(body: unknown) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("municipality coordinates", () => {
  it("matches normalized names and indexes coordinates by municipality and indicator ID", async () => {
    respond(payload());
    expect(await getMunicipalityCoordinates(" BLaNes ")).toEqual({ latitude: 41.674, longitude: 2.79 });
    expect(await getMunicipalityCoordinates("ager")).toEqual({ latitude: 42.002881, longitude: 0.762617 });
    expect(await getMunicipalityCoordinates("L'Hospitalet de Llobregat")).toEqual({ latitude: 41.3597, longitude: 2.0997 });
  });

  it("uses a constant cached request without transmitting the selected municipality", async () => {
    const fetchMock = respond(payload());
    await getMunicipalityCoordinates("Blanes");
    await getMunicipalityCoordinates("Àger");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(fetchMock.mock.calls[1]?.[0]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.idescat.cat/emex/v1/dades.json?i=f328%2Cf329&tipus=mun",
      expect.objectContaining({ cf: { cacheEverything: true, cacheTtl: 86_400 }, signal: expect.any(AbortSignal) })
    );
  });

  it("returns no origin for invalid, unknown or partial names", async () => {
    const fetchMock = respond(payload());
    expect(await getMunicipalityCoordinates("!!!")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getMunicipalityCoordinates("Blan")).toBeUndefined();
    expect(await getMunicipalityCoordinates("Unknown")).toBeUndefined();
  });

  it.each([null, {}, { fitxes: {} }, { fitxes: { cols: { col: "not an array" } } }])("rejects malformed payload %j", async (body) => {
    respond(body);
    expect(await getMunicipalityCoordinates("Blanes")).toBeUndefined();
  });

  it.each(["", " ", "NaN", "Infinity", "91", "-91"])("does not convert invalid latitude %j to an origin", async (latitude) => {
    const body = payload();
    body.fitxes.indicadors.i[0]!.v = `${latitude},41.359700,42.002881`;
    respond(body);
    expect(await getMunicipalityCoordinates("Blanes")).toBeUndefined();
  });

  it("rejects out-of-range longitude or misaligned coordinate arrays", async () => {
    const body = payload();
    body.fitxes.indicadors.i[1]!.v = "181,2.099700,0.762617";
    respond(body);
    expect(await getMunicipalityCoordinates("Blanes")).toBeUndefined();
    body.fitxes.indicadors.i[1]!.v = "2.79";
    respond(body);
    expect(await getMunicipalityCoordinates("Blanes")).toBeUndefined();
  });

  it("rejects ambiguous names and non-municipal entities", async () => {
    const body = payload();
    body.fitxes.cols.col[1]!.content = "Blanes";
    respond(body);
    expect(await getMunicipalityCoordinates("Blanes")).toBeUndefined();
    body.fitxes.cols.col[1]!.content = "Other";
    body.fitxes.cols.col[0]!.scheme = "com";
    respond(body);
    expect(await getMunicipalityCoordinates("Blanes")).toBeUndefined();
  });

  it("reports upstream failure so the caller can ask for a shared location", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    await expect(getMunicipalityCoordinates("Blanes")).rejects.toThrow("503");
  });
});
