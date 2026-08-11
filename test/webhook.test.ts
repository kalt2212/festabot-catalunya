import { afterEach, describe, expect, it, vi } from "vitest";

// The /telegram/webhook route is the bot's primary, security-sensitive
// entrypoint: it authenticates every inbound Telegram update, enforces size and
// shape limits, and drives idempotent processing. These tests exercise the real
// Hono app (auth + validation + routing) with the DB/Telegram side effects
// stubbed, so a regression in the gate is caught without a live Worker.
vi.mock("../src/handlers", () => ({
  handleUpdate: vi.fn(async () => undefined),
  sendDueReminders: vi.fn(async () => undefined)
}));

vi.mock("../src/repositories/updates", () => ({
  claimUpdate: vi.fn(),
  markUpdateDone: vi.fn(async () => undefined),
  releaseUpdate: vi.fn(async () => undefined)
}));

import app from "../src/index";
import { claimUpdate, markUpdateDone, releaseUpdate } from "../src/repositories/updates";
import { handleUpdate } from "../src/handlers";

const handleUpdateMock = vi.mocked(handleUpdate);
const claimUpdateMock = vi.mocked(claimUpdate);
const markUpdateDoneMock = vi.mocked(markUpdateDone);
const releaseUpdateMock = vi.mocked(releaseUpdate);

function mockEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: { prepare: () => ({ bind: () => ({ run: () => Promise.resolve({}) }) }) },
    USER_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    ...overrides
  };
}

function validUpdate() {
  return {
    update_id: 123,
    message: {
      message_id: 1,
      chat: { id: 10 },
      from: { id: 42 },
      text: "Blanes"
    }
  };
}

function post(env: ReturnType<typeof mockEnv>, body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(new Request("https://festabot/telegram/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  }), env);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("Telegram webhook entrypoint", () => {
  it("rejects updates without the configured secret token", async () => {
    const response = await post(mockEnv(), validUpdate(), { "X-Telegram-Bot-Api-Secret-Token": "wrong" });
    expect(response.status).toBe(403);
    expect(handleUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects non-JSON bodies with 415 before parsing", async () => {
    const response = await post(
      mockEnv(),
      validUpdate(),
      { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret", "Content-Type": "text/plain" }
    );
    expect(response.status).toBe(415);
    expect(handleUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects oversized payloads via Content-Length with 413", async () => {
    const response = await post(
      mockEnv(),
      validUpdate(),
      { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret", "Content-Length": "300000" }
    );
    expect(response.status).toBe(413);
    expect(handleUpdateMock).not.toHaveBeenCalled();
  });

  it("rejects malformed updates with 400 and never dispatches them", async () => {
    const response = await post(mockEnv(), { update_id: -1 }, { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" });
    expect(response.status).toBe(400);
    expect(handleUpdateMock).not.toHaveBeenCalled();
  });

  it("processes a valid update and marks it done", async () => {
    claimUpdateMock.mockResolvedValue("lease-token");

    const response = await post(mockEnv(), validUpdate(), { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" });

    expect(response.status).toBe(200);
    expect(handleUpdateMock).toHaveBeenCalledOnce();
    expect(markUpdateDoneMock).toHaveBeenCalledWith(expect.anything(), 123, "lease-token");
    expect(releaseUpdateMock).not.toHaveBeenCalled();
  });

  it("treats an unclaimable update as a duplicate without dispatching", async () => {
    claimUpdateMock.mockResolvedValue(null);

    const response = await post(mockEnv(), validUpdate(), { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, duplicate: true });
    expect(handleUpdateMock).not.toHaveBeenCalled();
  });

  it("short-circuits rate-limited actors without claiming", async () => {
    const env = mockEnv({ USER_RATE_LIMITER: { limit: () => Promise.resolve({ success: false }) } });

    const response = await post(env, validUpdate(), { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, limited: true });
    expect(claimUpdateMock).not.toHaveBeenCalled();
    expect(handleUpdateMock).not.toHaveBeenCalled();
  });

  it("releases the lease and returns 500 when dispatch throws", async () => {
    claimUpdateMock.mockResolvedValue("lease-token");
    handleUpdateMock.mockRejectedValue(new Error("boom"));

    const response = await post(mockEnv(), validUpdate(), { "X-Telegram-Bot-Api-Secret-Token": "webhook-secret" });

    expect(response.status).toBe(500);
    expect(releaseUpdateMock).toHaveBeenCalledWith(expect.anything(), 123, "lease-token");
  });
});
