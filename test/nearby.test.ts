import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, TelegramUpdate } from "../src/types";

const mocks = vi.hoisted(() => ({
  getUserPreferences: vi.fn(),
  sendMessage: vi.fn(),
  answerCallbackQuery: vi.fn()
}));

vi.mock("../src/repositories/users", () => ({
  ensureUser: vi.fn(),
  getLanguage: vi.fn(async () => "ca"),
  getUserPreferences: mocks.getUserPreferences
}));
vi.mock("../src/services/telegram", () => ({
  sendMessage: mocks.sendMessage,
  answerCallbackQuery: mocks.answerCallbackQuery
}));

import { handleUpdate } from "../src/handlers";

function command(text = "/aprop"): TelegramUpdate {
  return { update_id: 1, message: { message_id: 1, from: { id: 7 }, chat: { id: 10, type: "private" }, text } };
}

const coordinates = {
  fitxes: {
    cols: { col: [{ scheme: "mun", id: "170237", content: "Blanes" }] },
    indicadors: { i: [{ id: "f328", v: "2.790000" }, { id: "f329", v: "41.670000" }] }
  }
};
const events = [
  { codi: "20260721001", denominaci: "Concert veí", municipi: "agenda:ubicacions/girona/selva/lloret-de-mar", localitat: "Lloret de Mar", latitud: "41.70", longitud: "2.84" },
  { codi: "20260721002", denominaci: "Concert llunyà", municipi: "agenda:ubicacions/girona/girones/girona", localitat: "Girona", latitud: "41.98", longitud: "2.82" }
].map((event) => ({ ...event, data_inici: "2026-07-24T00:00:00.000", data_fi: "2026-07-24T23:00:00.000", tags_mbits: "agenda:ambits/musica" }));
let requests: URL[];
let municipalityResponse: () => Response;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-22T12:00:00Z"));
  mocks.getUserPreferences.mockResolvedValue({ homeMunicipality: "blanes", radiusKm: 15 });
  municipalityResponse = () => Response.json(coordinates);
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.hostname === "api.idescat.cat") return municipalityResponse();
    if (url.hostname === "analisi.transparenciacatalunya.cat") return Response.json(events);
    throw new Error(`Unexpected network request: ${url.hostname}`);
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sentText(): string {
  return mocks.sendMessage.mock.calls.map((call) => call[2]).join("\n");
}

describe("nearby searches", () => {
  it.each(["/aprop", "/cerca", "quick:nearby"])("uses the saved radius across municipality boundaries for %s", async (action) => {
    const update: TelegramUpdate = action === "quick:nearby"
      ? { update_id: 2, callback_query: { id: "nearby", from: { id: 7 }, data: action, message: { message_id: 2, chat: { id: 10, type: "private" } } } }
      : command(action);
    await handleUpdate({} as Env, update);
    const agenda = requests.find((url) => url.hostname === "analisi.transparenciacatalunya.cat");
    const where = agenda?.searchParams.get("$where") ?? "";
    expect(where).toContain("latitud between");
    expect(where).not.toContain("municipi like '%/blanes'");
    expect(sentText()).toContain("Concert veí");
    expect(sentText()).not.toContain("Concert llunyà");
    expect(sentText()).toContain(" km");
    expect(sentText()).toContain("https://www.idescat.cat/");
  });

  it.each([5, 50])("honors a configured radius of %s km", async (radiusKm) => {
    mocks.getUserPreferences.mockResolvedValue({ homeMunicipality: "Blanes", radiusKm });
    await handleUpdate({} as Env, command());
    if (radiusKm === 5) {
      expect(sentText()).not.toContain("Concert veí");
      expect(sentText()).not.toContain("Concert llunyà");
    } else {
      expect(sentText()).toContain("Concert veí");
      expect(sentText()).toContain("Concert llunyà");
    }
  });

  it("escapes the saved municipality in the HTML confirmation", async () => {
    mocks.getUserPreferences.mockResolvedValue({ homeMunicipality: "<Blanes>", radiusKm: 15 });
    await handleUpdate({} as Env, command());
    expect(sentText()).toContain("&lt;Blanes&gt;");
    expect(sentText()).not.toContain("<Blanes>");
  });

  it("uses a shared location directly with the saved radius", async () => {
    const update = command();
    update.message!.location = { latitude: 41.98, longitude: 2.82 };
    await handleUpdate({} as Env, update);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.hostname).toBe("analisi.transparenciacatalunya.cat");
    expect(sentText()).toContain("Concert llunyà");
    expect(sentText()).not.toContain("Concert veí");
  });

  it("asks for a location without querying any source when no home is saved", async () => {
    mocks.getUserPreferences.mockResolvedValue({ radiusKm: 25 });
    await handleUpdate({} as Env, command());
    expect(requests).toHaveLength(0);
    expect(sentText()).toContain("Envia'm la ubicació");
  });

  it.each(["missing", "unavailable", "invalid coordinates"])("asks for a location if the saved municipality is %s", async (problem) => {
    if (problem === "missing") mocks.getUserPreferences.mockResolvedValue({ homeMunicipality: "unknown", radiusKm: 15 });
    if (problem === "unavailable") vi.spyOn(console, "error").mockImplementation(() => {});
    if (problem === "unavailable") municipalityResponse = () => new Response("unavailable", { status: 503 });
    if (problem === "invalid coordinates") municipalityResponse = () => Response.json({ fitxes: { ...coordinates.fitxes, indicadors: { i: [] } } });
    await handleUpdate({} as Env, command());
    expect(requests.every((url) => url.hostname === "api.idescat.cat")).toBe(true);
    expect(sentText()).toContain("Envia'm la ubicació");
    expect(sentText()).not.toContain("Plans a prop de");
  });
});
