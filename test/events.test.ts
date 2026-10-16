import { describe, expect, it } from "vitest";
import { haversineKm, humanizeSlug, municipalitySlug, normalizeEvent, rankEvents } from "../src/domain/events";

describe("event normalization", () => {
  it("normalizes a Socrata event", () => {
    const event = normalizeEvent({
      codi: "20260721001",
      source_row_id: "row-abcd~1234",
      denominaci: "Concert de Festa Major",
      data_inici: "2026-07-24T00:00:00.000",
      data_fi: "2026-07-24T00:00:00.000",
      municipi: "agenda:ubicacions/barcelona/valles-occidental/terrassa",
      comarca: "agenda:ubicacions/barcelona/valles-occidental",
      gratuita: "Sí",
      tags_mbits: "agenda:ambits/musica",
      descripcio_html: "<p><a href=\"https://ajuntament.cat/programa-2026.pdf\">Programa</a> <a href=\"https://ajuntament.cat/cartell-2025.pdf\">Antic</a> &amp; activitats</p><ul><li>Pregó</li><li>Concert</li></ul><script>ignora'm</script>",
      urlactivitat: "https://example.cat/event"
    });
    expect(event).toMatchObject({
      code: "20260721001",
      sourceRowId: "row-abcd~1234",
      municipality: "Terrassa",
      comarca: "Valles Occidental",
      free: true,
      description: "Programa Antic & activitats\n\n• Pregó\n• Concert",
      programDocumentUrls: ["https://ajuntament.cat/programa-2026.pdf"],
      sourceUrl: "https://example.cat/event"
    });
  });

  it("rejects malformed records", () => {
    expect(normalizeEvent({ denominaci: "Sense codi" })).toBeNull();
  });

  it("bounds untrusted text and rejects impossible coordinates", () => {
    const event = normalizeEvent({
      codi: "20260721002",
      denominaci: "X".repeat(500),
      data_inici: "2026-07-24T00:00:00.000",
      data_fi: "2026-07-24T00:00:00.000",
      municipi: "agenda:ubicacions/barcelona/barcelones/barcelona",
      latitud: "120",
      longitud: "240"
    });
    expect(event?.title).toHaveLength(300);
    expect(event?.latitude).toBeUndefined();
    expect(event?.longitude).toBeUndefined();
  });
});

describe("event ranking", () => {
  it("prefers a short festive event and rejects corrupt future years", () => {
    const base = {
      municipality: "Reus",
      municipalitySlug: "reus",
      comarca: "Baix Camp",
      categories: [] as string[]
    };
    // Match Socrata's local date-time format throughout. Date-only strings parse
    // as UTC and otherwise fall outside this local window in negative offsets.
    const ranked = rankEvents([
      { ...base, code: "1", title: "Exposició permanent", startsAt: "2025-01-01T00:00:00.000", endsAt: "2026-12-31T00:00:00.000" },
      { ...base, code: "2", title: "Concert de Festa Major", startsAt: "2026-07-24T00:00:00.000", endsAt: "2026-07-24T00:00:00.000", categories: ["concerts"] },
      { ...base, code: "3", title: "Data corrupta", startsAt: "2024-01-01T00:00:00.000", endsAt: "2924-01-01T00:00:00.000" }
    ], {
      start: "2026-07-24T00:00:00.000",
      end: "2026-07-26T23:59:59.999"
    });
    expect(ranked.map((event) => event.code)).toEqual(["2", "1"]);
  });
});

describe("location helpers", () => {
  it("calculates a plausible Barcelona to Terrassa distance", () => {
    expect(haversineKm(41.387, 2.17, 41.563, 2.008)).toBeGreaterThan(20);
    expect(haversineKm(41.387, 2.17, 41.563, 2.008)).toBeLessThan(30);
  });

  it("turns municipality text into a safe slug", () => {
    expect(municipalitySlug("Sant Cugat del Vallès")).toBe("sant-cugat-del-valles");
    expect(humanizeSlug("sant-cugat-del-valles")).toBe("Sant Cugat del Valles");
  });
});
