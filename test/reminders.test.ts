import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimDueReminders: vi.fn(),
  markReminderSent: vi.fn(),
  markReminderRetry: vi.fn(),
  markReminderFailed: vi.fn(),
  cleanupReminders: vi.fn(),
  cleanupCorrections: vi.fn(),
  cleanupProcessedUpdates: vi.fn(),
  sendMessage: vi.fn(),
  answerCallbackQuery: vi.fn(),
  answerInlineQuery: vi.fn(),
  editMessageText: vi.fn(),
  sendPoll: vi.fn()
}));

vi.mock("../src/repositories/reminders", () => ({
  claimDueReminders: mocks.claimDueReminders,
  markReminderSent: mocks.markReminderSent,
  markReminderRetry: mocks.markReminderRetry,
  markReminderFailed: mocks.markReminderFailed,
  cleanupReminders: mocks.cleanupReminders
}));
vi.mock("../src/repositories/corrections", () => ({ cleanupCorrections: mocks.cleanupCorrections }));
vi.mock("../src/repositories/updates", () => ({ cleanupProcessedUpdates: mocks.cleanupProcessedUpdates }));
vi.mock("../src/services/telegram", () => ({
  answerCallbackQuery: mocks.answerCallbackQuery,
  answerInlineQuery: mocks.answerInlineQuery,
  editMessageText: mocks.editMessageText,
  sendMessage: mocks.sendMessage,
  sendPoll: mocks.sendPoll,
  TelegramApiError: class TelegramApiError extends Error {
    constructor(message: string, public httpStatus = 0, public errorCode?: number, public retryAfterSeconds?: number) {
      super(message);
    }
  }
}));

import { sendDueReminders } from "../src/handlers";
import { TelegramApiError } from "../src/services/telegram";

const baseReminder = {
  id: "r1",
  chat_id: "10",
  event_title: "Festa Major de Blanes",
  event_url: null,
  attempts: 1,
  claim_token: "tok"
};

beforeEach(() => {
  // 02:03 UTC sits inside the daily cleanup window so cleanup always runs here.
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-22T02:03:00Z"));
  vi.clearAllMocks();
  mocks.cleanupReminders.mockResolvedValue(undefined);
  mocks.cleanupCorrections.mockResolvedValue(undefined);
  mocks.cleanupProcessedUpdates.mockResolvedValue(undefined);
  mocks.markReminderSent.mockResolvedValue(undefined);
  mocks.markReminderRetry.mockResolvedValue(undefined);
  mocks.markReminderFailed.mockResolvedValue(undefined);
  mocks.sendMessage.mockResolvedValue({ message_id: 1 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sendDueReminders", () => {
  it("keeps the daily cleanup running even when claiming due reminders fails", async () => {
    mocks.claimDueReminders.mockRejectedValue(new Error("D1 unavailable"));

    await expect(sendDueReminders({} as never)).resolves.toBeUndefined();

    expect(mocks.cleanupReminders).toHaveBeenCalledOnce();
    expect(mocks.cleanupCorrections).toHaveBeenCalledOnce();
    expect(mocks.cleanupProcessedUpdates).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("marks a successfully delivered reminder as sent", async () => {
    mocks.claimDueReminders.mockResolvedValue([baseReminder]);

    await sendDueReminders({} as never);

    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.anything(), "10", expect.stringContaining("Festa Major de Blanes"));
    expect(mocks.markReminderSent).toHaveBeenCalledWith(expect.anything(), "r1", "tok");
  });

  it("marks a terminal Telegram failure as failed, not retried", async () => {
    mocks.claimDueReminders.mockResolvedValue([baseReminder]);
    mocks.sendMessage.mockRejectedValue(new TelegramApiError("bad request", 400, 400));

    await sendDueReminders({} as never);

    expect(mocks.markReminderFailed).toHaveBeenCalledWith(expect.anything(), "r1", "tok", expect.any(String));
    expect(mocks.markReminderRetry).not.toHaveBeenCalled();
  });
});
