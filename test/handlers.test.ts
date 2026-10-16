import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, EventItem, TelegramUpdate } from "../src/types";

const mocks = vi.hoisted(() => ({
  answerCallbackQuery: vi.fn(),
  answerInlineQuery: vi.fn(),
  editMessageText: vi.fn(),
  getEventByReference: vi.fn(),
  getEvents: vi.fn(),
  getOfficialProgramDocument: vi.fn(),
  getLanguage: vi.fn(),
  setHomeMunicipality: vi.fn(),
  sendMessage: vi.fn(),
  sendPoll: vi.fn()
}));

vi.mock("../src/services/agenda", () => ({
  agendaSourceUrl: "https://agenda.cultura.gencat.cat/",
  getEventByReference: mocks.getEventByReference,
  getEvents: mocks.getEvents,
  isEventReference: (value: string) => /^\d{5,20}$/.test(value)
}));

vi.mock("../src/services/telegram", () => ({
  answerCallbackQuery: mocks.answerCallbackQuery,
  answerInlineQuery: mocks.answerInlineQuery,
  editMessageText: mocks.editMessageText,
  sendMessage: mocks.sendMessage,
  sendPoll: mocks.sendPoll,
  TelegramApiError: class TelegramApiError extends Error {
    errorCode?: number;
  }
}));

vi.mock("../src/services/program-document", () => ({
  getOfficialProgramDocument: mocks.getOfficialProgramDocument
}));

vi.mock("../src/repositories/users", () => ({
  deleteUserData: vi.fn(),
  ensureUser: vi.fn(),
  getLanguage: mocks.getLanguage,
  getUserPreferences: vi.fn(),
  setHomeMunicipality: mocks.setHomeMunicipality,
  setLanguage: vi.fn()
}));

import { handleUpdate } from "../src/handlers";
import { t } from "../src/i18n";

const listEvent: EventItem = {
  code: "2026071300004",
  title: "Festa Major de Blanes",
  startsAt: "2026-07-22T00:00:00.000",
  endsAt: "2026-07-27T00:00:00.000",
  municipality: "Blanes",
  municipalitySlug: "blanes",
  comarca: "Selva",
  venue: "Diferents espais",
  categories: ["festes"]
};

function message(text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: 42 },
      chat: { id: 10, type: "private" },
      text
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLanguage.mockResolvedValue("ca");
  mocks.getEvents.mockResolvedValue([listEvent]);
  mocks.getEventByReference.mockResolvedValue({
    ...listEvent,
    description: "Dimecres: pregó. Dijous: concerts i correfoc.",
    sourceUpdatedAt: "2026-07-22T07:37:14.017Z"
  });
  mocks.getOfficialProgramDocument.mockResolvedValue({
    sourceUrl: "https://blanes.cat/programa.pdf",
    text: "Dimecres: pregó. Dijous: concerts i correfoc. Divendres: castellera."
  });
  mocks.sendMessage.mockResolvedValue({ message_id: 2 });
});

describe("direct Festa Major program flow", () => {
  it("answers /programa inside Telegram without requiring a source link", async () => {
    await handleUpdate({} as Env, message("/programa Blanes"));

    expect(mocks.getEvents).toHaveBeenCalledWith(expect.objectContaining({
      municipality: "Blanes",
      festaMajorOnly: true,
      fresh: true
    }));
    expect(mocks.getEventByReference).toHaveBeenCalledWith("2026071300004", { fresh: true });
    expect(mocks.getOfficialProgramDocument).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "2026071300004" }),
      { fresh: true }
    );
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      10,
      expect.stringContaining("Programa oficial"),
      expect.objectContaining({ inline_keyboard: expect.any(Array) })
    );
    expect(String(mocks.sendMessage.mock.calls[0]?.[2])).toContain("Dimecres: pregó");
  });

  it("opens the program when the user writes only the municipality", async () => {
    await handleUpdate({} as Env, message("Blanes"));

    expect(mocks.getEvents).toHaveBeenCalledWith(expect.objectContaining({
      municipality: "Blanes",
      festaMajorOnly: true
    }));
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      10,
      expect.stringContaining("Programa oficial"),
      expect.anything()
    );
  });

  it("refreshes and edits the existing program message", async () => {
    await handleUpdate({} as Env, {
      update_id: 2,
      callback_query: {
        id: "callback-1",
        from: { id: 42 },
        data: "p:2026071300004:0:r",
        message: { message_id: 9, chat: { id: 10, type: "private" } }
      }
    });

    expect(mocks.getEventByReference).toHaveBeenCalledWith("2026071300004", { fresh: true });
    expect(mocks.getOfficialProgramDocument).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "2026071300004" }),
      { fresh: true }
    );
    expect(mocks.editMessageText).toHaveBeenCalledWith(
      expect.anything(),
      10,
      9,
      expect.stringContaining("Programa oficial"),
      expect.anything()
    );
  });

  it("asks only for the municipality when /programa has no argument", async () => {
    await handleUpdate({} as Env, message("/programa"));

    expect(mocks.getEvents).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      10,
      expect.stringContaining("/programa Blanes")
    );
  });
});

describe("home municipality confirmation", () => {
  it.each([
    ["/municipi ", "ca"],
    ["/municipio ", "es"],
    ["", "ca"],
    ["", "es"]
  ] as const)("escapes only the displayed name for %s in %s", async (prefix, language) => {
    const rawMunicipality = 'Blanes <>&"';
    mocks.getLanguage.mockResolvedValue(language);

    await handleUpdate({} as Env, message(`${prefix}${rawMunicipality}`));

    expect(mocks.setHomeMunicipality).toHaveBeenCalledWith(expect.anything(), 42, rawMunicipality);
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      10,
      t(language).homeSet.replace("%MUNICIPI%", "Blanes &lt;&gt;&amp;&quot;")
    );
  });
});
