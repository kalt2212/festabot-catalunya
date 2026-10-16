import { formatDateRange, nextSevenDaysWindow, reminderTimeFor, todayWindow, upcomingWindow, weekendWindow } from "./domain/date";
import { categoryLabel, escapeHtml, haversineKm, municipalitySlug } from "./domain/events";
import { isFestaMajor, programPages } from "./domain/program";
import { t } from "./i18n";
import { cleanupCorrections, createCorrection, type CorrectionType } from "./repositories/corrections";
import { claimDueReminders, cleanupReminders, createReminder, markReminderFailed, markReminderRetry, markReminderSent } from "./repositories/reminders";
import { cleanupProcessedUpdates } from "./repositories/updates";
import { deleteUserData, ensureUser, getLanguage, getUserPreferences, setHomeMunicipality, setLanguage } from "./repositories/users";
import { agendaSourceUrl, getEventByReference, getEvents, isEventReference, type AgendaQuery } from "./services/agenda";
import { getMunicipalityCoordinates } from "./services/municipalities";
import { getOfficialProgramDocument } from "./services/program-document";
import { answerCallbackQuery, answerInlineQuery, editMessageText, sendMessage, sendPoll, TelegramApiError } from "./services/telegram";
import type { Env, EventItem, Language, TelegramCallbackQuery, TelegramInlineQuery, TelegramMessage, TelegramUpdate } from "./types";

function eventLine(event: EventItem, language: Language, index: number, origin?: { latitude: number; longitude: number }): string {
  const labels = t(language);
  const date = formatDateRange(event.startsAt, event.endsAt, language);
  const distance = origin && event.latitude !== undefined && event.longitude !== undefined
    ? ` · ${haversineKm(origin.latitude, origin.longitude, event.latitude, event.longitude).toFixed(1)} km`
    : "";
  const free = event.free ? (language === "ca" ? " · Gratis" : " · Gratis") : "";
  const recurring = event.schedule && event.startsAt.slice(0, 10) !== event.endsAt.slice(0, 10)
    ? ` · ⚠️ ${labels.longSchedule}`
    : "";
  return `<b>${index + 1}. ${escapeHtml(event.title)}</b>\n${escapeHtml(event.municipality || event.comarca)} · ${escapeHtml(date)}${distance}${free}${recurring}`;
}

function resultKeyboard(events: EventItem[], language: Language, suggestedQuery: string, showMore: boolean) {
  const labels = t(language);
  return {
    inline_keyboard: [
      ...events.slice(0, 8).map((event, index) => {
        const showProgram = isFestaMajor(event);
        return [{
          text: `${index + 1} · ${showProgram ? labels.program : labels.details}`,
          callback_data: showProgram ? `p:${event.code}:0` : `detail:${event.sourceRowId ?? event.code}`
        }];
      }),
      ...(showMore ? [[{
        text: language === "ca" ? "🔎 Més plans" : "🔎 Más planes",
        switch_inline_query_current_chat: suggestedQuery
      }]] : []),
      [{ text: language === "ca" ? "Compartir en un grup" : "Compartir en un grupo", switch_inline_query: suggestedQuery }]
    ]
  };
}

function discoveryKeyboard(language: Language) {
  return {
    inline_keyboard: [
      [
        { text: language === "ca" ? "📍 A prop meu" : "📍 Cerca de mí", callback_data: "quick:nearby" },
        { text: language === "ca" ? "🎉 Avui" : "🎉 Hoy", callback_data: "quick:today" }
      ],
      [
        { text: language === "ca" ? "🎵 Concerts" : "🎵 Conciertos", callback_data: "quick:concerts" },
        { text: language === "ca" ? "🎊 Festes majors" : "🎊 Fiestas mayores", callback_data: "quick:festes" }
      ],
      [{ text: language === "ca" ? "📋 Veure un programa" : "📋 Ver un programa", callback_data: "quick:program" }]
    ]
  };
}

function locationKeyboard(language: Language) {
  return {
    keyboard: [[{ text: language === "ca" ? "📍 Compartir ubicació" : "📍 Compartir ubicación", request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true
  };
}

async function sendResults(
  env: Env,
  chatId: number,
  language: Language,
  query: AgendaQuery,
  origin?: { latitude: number; longitude: number }
): Promise<EventItem[]> {
  const labels = t(language);
  let events: EventItem[];
  try {
    events = (await getEvents(query)).slice(0, 8);
  } catch (error) {
    console.error("Agenda query failed", { error: String(error) });
    await sendMessage(env, chatId, labels.error);
    return [];
  }
  if (events.length === 0) {
    await sendMessage(env, chatId, `${labels.noResults}\n\n<a href="${agendaSourceUrl}">${labels.source}</a>`);
    return [];
  }
  const body = events.map((event, index) => eventLine(event, language, index, origin)).join("\n\n");
  await sendMessage(
    env,
    chatId,
    `🎊 <b>${labels.resultsTitle}</b>\n\n${body}\n\n<a href="${agendaSourceUrl}">${labels.source}</a>`,
    resultKeyboard(
      events,
      language,
      query.municipality ?? query.query ?? "",
      origin === undefined && Boolean(query.municipality || query.query)
    )
  );
  return events;
}

async function sendNearby(
  env: Env,
  chatId: number,
  language: Language,
  origin: { latitude: number; longitude: number } | undefined,
  userId?: number
): Promise<void> {
  if (origin) {
    const radiusKm = userId ? (await getUserPreferences(env, userId)).radiusKm : 30;
    await sendResults(env, chatId, language, {
      ...nextSevenDaysWindow(),
      latitude: origin.latitude,
      longitude: origin.longitude,
      radiusKm,
      limit: 1000
    }, origin);
    return;
  }
  const labels = t(language);
  if (!userId) {
    await sendMessage(env, chatId, labels.askLocation, locationKeyboard(language));
    return;
  }
  const prefs = await getUserPreferences(env, userId);
  if (prefs.homeMunicipality) {
    let homeOrigin: { latitude: number; longitude: number } | undefined;
    try {
      homeOrigin = await getMunicipalityCoordinates(prefs.homeMunicipality);
    } catch (error) {
      console.error("Municipality lookup failed", { error: String(error) });
    }
    if (homeOrigin) {
      await sendMessage(env, chatId, labels.apropUsingHome.replace("%MUNICIPI%", escapeHtml(prefs.homeMunicipality)));
      await sendResults(env, chatId, language, {
        ...nextSevenDaysWindow(),
        ...homeOrigin,
        radiusKm: prefs.radiusKm,
        limit: 1000
      }, homeOrigin);
      return;
    }
  }
  await sendMessage(env, chatId, labels.askLocation, locationKeyboard(language));
}

// Validates `text` maps to a real municipality before persisting. Prevents P1:
// getEvents({query}) matches titles/venues too, while municipalitySlug normalizes
// any word — so "concert" would otherwise be saved as home. One network call.
async function resolveMunicipality(env: Env, text: string): Promise<boolean> {
  const slug = municipalitySlug(text);
  if (!slug) return false;
  const events = await getEvents({ ...nextSevenDaysWindow(), municipality: text, limit: 8 });
  return events.some((event) => event.municipality && municipalitySlug(event.municipality) === slug);
}

function detailText(event: EventItem, language: Language): string {
  const labels = t(language);
  const lines = [
    `${categoryLabel(event, language) === "Música" ? "🎵" : "🎉"} <b>${escapeHtml(event.title)}</b>`,
    `📅 ${escapeHtml(formatDateRange(event.startsAt, event.endsAt, language))}`,
    `📍 ${escapeHtml([event.venue, event.municipality].filter(Boolean).join(" · "))}`
  ];
  if (event.address) lines.push(`🗺 ${escapeHtml(event.address)}`);
  if (event.schedule) lines.push(`🕒 ${escapeHtml(event.schedule.slice(0, 600))}`);
  if (event.free) lines.push(language === "ca" ? "🎟 Activitat gratuïta" : "🎟 Actividad gratuita");
  if (event.ticketInfo) lines.push(`ℹ️ ${escapeHtml(event.ticketInfo.slice(0, 400))}`);
  lines.push(`\n<i>${labels.source}</i>`);
  return lines.join("\n");
}

function detailKeyboard(event: EventItem, language: Language) {
  const labels = t(language);
  const reference = event.sourceRowId ?? event.code;
  const firstRow = [
    { text: labels.remind, callback_data: `rem:${reference}` },
    { text: labels.report, callback_data: `report:${reference}` }
  ];
  return {
    inline_keyboard: [
      firstRow,
      ...(event.sourceUrl ? [[{ text: language === "ca" ? "Més informació" : "Más información", url: event.sourceUrl }]] : [])
    ]
  };
}

function programKeyboard(
  event: EventItem,
  language: Language,
  pageIndex: number,
  pageCount: number,
  programSourceUrl?: string
) {
  const labels = t(language);
  const reference = event.code;
  const navigation = [
    ...(pageIndex > 0 ? [{ text: labels.previous, callback_data: `p:${reference}:${pageIndex - 1}` }] : []),
    ...(pageIndex + 1 < pageCount ? [{ text: labels.next, callback_data: `p:${reference}:${pageIndex + 1}` }] : [])
  ];
  return {
    inline_keyboard: [
      ...(navigation.length ? [navigation] : []),
      [{ text: labels.refresh, callback_data: `p:${reference}:${pageIndex}:r` }],
      [
        { text: labels.remind, callback_data: `rem:${reference}` },
        { text: labels.report, callback_data: `report:${reference}` }
      ],
      ...(programSourceUrl || event.sourceUrl ? [[{
        text: programSourceUrl
          ? (language === "ca" ? "PDF oficial (opcional)" : "PDF oficial (opcional)")
          : (language === "ca" ? "Font original (opcional)" : "Fuente original (opcional)"),
        url: programSourceUrl ?? event.sourceUrl ?? agendaSourceUrl
      }]] : [])
    ]
  };
}

function sortFestaPrograms(events: EventItem[], now = new Date()): EventItem[] {
  const currentDay = todayWindow(now);
  return [...events].sort((left, right) => {
    const leftActive = left.startsAt <= currentDay.end && left.endsAt >= currentDay.start;
    const rightActive = right.startsAt <= currentDay.end && right.endsAt >= currentDay.start;
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    return left.startsAt.localeCompare(right.startsAt) || right.sourceUpdatedAt?.localeCompare(left.sourceUpdatedAt ?? "") || 0;
  });
}

type ProgramDelivery = "sent" | "missing" | "error";

async function sendFestaProgram(
  env: Env,
  chatId: number,
  language: Language,
  municipality: string,
  options: { fresh?: boolean; silentMissing?: boolean } = {}
): Promise<ProgramDelivery> {
  const labels = t(language);
  try {
    const candidates = sortFestaPrograms((await getEvents({
      ...upcomingWindow(180),
      municipality,
      festaMajorOnly: true,
      fresh: options.fresh,
      limit: 200
    })).filter(isFestaMajor));
    const selected = candidates[0];
    if (!selected) {
      if (!options.silentMissing) await sendMessage(env, chatId, labels.noProgram);
      return "missing";
    }
    const event = await getEventByReference(selected.code, { fresh: options.fresh });
    if (!event || !isFestaMajor(event)) {
      if (!options.silentMissing) await sendMessage(env, chatId, labels.noProgram);
      return "missing";
    }
    const document = await getOfficialProgramDocument(env, event, { fresh: options.fresh });
    const pages = programPages(event, language, new Date(), document ?? undefined);
    await sendMessage(
      env,
      chatId,
      pages[0] ?? labels.noProgram,
      programKeyboard(event, language, 0, pages.length, document?.sourceUrl)
    );
    return "sent";
  } catch (error) {
    console.error("Festa program query failed", { error: String(error) });
    await sendMessage(env, chatId, labels.error);
    return "error";
  }
}

function explicitProgramMunicipality(text: string): string | undefined {
  const match = text.match(/^(?:programa(?:ci[oó]|ci[oó]n)?|festa\s+major|fiesta\s+mayor)(?:\s+de)?\s+(.{1,80})$/i);
  return match?.[1]?.trim() || undefined;
}

async function handleCommand(env: Env, message: TelegramMessage, language: Language, command: string, argument: string): Promise<void> {
  const labels = t(language);
  const userId = message.from?.id;
  if (!userId) return;

  switch (command) {
    case "start":
      await ensureUser(env, userId, language);
      await sendMessage(env, message.chat.id, `${labels.welcome}\n\n${labels.chooseLanguage}`, {
        inline_keyboard: [[
          { text: "Català", callback_data: "lang:ca" },
          { text: "Castellano", callback_data: "lang:es" }
        ]]
      });
      return;
    case "avui":
    case "hoy":
      await sendResults(env, message.chat.id, language, { ...todayWindow(), municipality: argument || undefined, limit: 1000 });
      return;
    case "capdesetmana":
    case "finde":
      await sendResults(env, message.chat.id, language, { ...weekendWindow(), municipality: argument || undefined, limit: 700 });
      return;
    case "concerts":
    case "conciertos":
      await sendResults(env, message.chat.id, language, { ...nextSevenDaysWindow(), municipality: argument || undefined, musicOnly: true, limit: 800 });
      return;
    case "festes":
    case "fiestas": {
      if (argument) {
        const delivery = await sendFestaProgram(env, message.chat.id, language, argument, { fresh: true, silentMissing: true });
        if (delivery !== "missing") return;
      }
      await sendResults(env, message.chat.id, language, { ...nextSevenDaysWindow(), municipality: argument || undefined, festiveOnly: true, limit: 800 });
      return;
    }
    case "programa":
    case "programacio":
    case "programació":
    case "programacion":
    case "programación":
      if (!argument) {
        await sendMessage(env, message.chat.id, labels.missingProgram);
        return;
      }
      await sendFestaProgram(env, message.chat.id, language, argument, { fresh: true });
      return;
    case "artista":
    case "artist":
      if (!argument) {
        await sendMessage(env, message.chat.id, labels.missingSearch);
        return;
      }
      await sendResults(env, message.chat.id, language, { ...nextSevenDaysWindow(), query: argument, musicOnly: true, limit: 800 });
      return;
    case "municipi":
    case "municipio":
      if (!argument) {
        await sendMessage(env, message.chat.id, labels.missingMunicipality);
        return;
      }
      const municipiEvents = await sendResults(env, message.chat.id, language, { ...nextSevenDaysWindow(), municipality: argument, limit: 1000 });
      if (municipiEvents.length > 0 && await resolveMunicipality(env, argument)) {
        await setHomeMunicipality(env, userId, argument);
        await sendMessage(env, message.chat.id, labels.homeSet.replace("%MUNICIPI%", escapeHtml(argument)));
      } else {
        await sendMessage(env, message.chat.id, labels.noResults);
      }
      return;
    case "aprop":
    case "cerca":
      await sendNearby(env, message.chat.id, language, undefined, userId);
      return;
    case "pla":
    case "plan": {
      if (!argument) {
        await sendMessage(env, message.chat.id, labels.missingMunicipality);
        return;
      }
      let events: EventItem[];
      try {
        events = (await getEvents({ ...nextSevenDaysWindow(), municipality: argument, musicOnly: true, limit: 500 })).slice(0, 3);
      } catch (error) {
        console.error("Plan poll query failed", { error: String(error) });
        await sendMessage(env, message.chat.id, labels.error);
        return;
      }
      if (events.length < 2) {
        await sendMessage(env, message.chat.id, labels.noResults);
        return;
      }
      await sendPoll(env, message.chat.id, labels.pollQuestion, events.map((event) => `${event.title} · ${event.municipality}`));
      return;
    }
    case "privacitat":
    case "privacidad":
      await sendMessage(env, message.chat.id, labels.privacy);
      return;
    case "esborra_dades":
    case "borra_datos":
      await deleteUserData(env, userId);
      await sendMessage(env, message.chat.id, labels.deleted);
      return;
    case "help":
    case "ajuda":
    case "ayuda":
      await sendMessage(env, message.chat.id, `${labels.welcome}\n\n/avui · /capdesetmana · /aprop · /municipi · /concerts · /festes · /programa · /artista · /pla · /privacitat`, discoveryKeyboard(language));
      return;
    default:
      await sendMessage(env, message.chat.id, `${labels.welcome}\n\n/avui · /capdesetmana · /aprop · /municipi · /concerts · /festes · /programa · /artista · /pla`, discoveryKeyboard(language));
  }
}

async function handleMessage(env: Env, message: TelegramMessage): Promise<void> {
  const userId = message.from?.id;
  if (!userId) return;
  const language = await getLanguage(env, userId);
  const labels = t(language);

  if (message.location) {
    const origin = message.location;
    if (!Number.isFinite(origin.latitude) || origin.latitude < -90 || origin.latitude > 90
      || !Number.isFinite(origin.longitude) || origin.longitude < -180 || origin.longitude > 180) {
      await sendMessage(env, message.chat.id, labels.invalidLocation);
      return;
    }
    await sendNearby(env, message.chat.id, language, origin, userId);
    return;
  }

  const text = message.text?.trim();
  if (!text) return;
  if (text.startsWith("/")) {
    const [rawCommand = "", ...parts] = text.split(/\s+/);
    const command = rawCommand.slice(1).split("@")[0]?.toLowerCase() ?? "";
    await handleCommand(env, message, language, command, parts.join(" ").trim());
    return;
  }

  const requestedProgram = explicitProgramMunicipality(text);
  if (requestedProgram) {
    await sendFestaProgram(env, message.chat.id, language, requestedProgram, { fresh: true });
    return;
  }
  if (/^(?:programa(?:ci[oó]|ci[oó]n)?|festa\s+major|fiesta\s+mayor)$/i.test(text)) {
    await sendMessage(env, message.chat.id, labels.missingProgram);
    return;
  }

  if (text.length <= 80) {
    const programDelivery = await sendFestaProgram(env, message.chat.id, language, text, { silentMissing: true });
    if (programDelivery !== "missing") {
      if (await resolveMunicipality(env, text)) {
        await setHomeMunicipality(env, userId, text);
        await sendMessage(env, message.chat.id, labels.homeSet.replace("%MUNICIPI%", escapeHtml(text)));
      }
      return;
    }
    const events = await sendResults(env, message.chat.id, language, { ...nextSevenDaysWindow(), query: text, limit: 1000 });
    if (events.length > 0 && await resolveMunicipality(env, text)) {
      await setHomeMunicipality(env, userId, text);
    }
    return;
  }
  await sendMessage(env, message.chat.id, labels.missingMunicipality);
}

async function handleCallback(env: Env, callback: TelegramCallbackQuery): Promise<void> {
  const data = callback.data ?? "";
  const chatId = callback.message?.chat.id;
  const userId = callback.from.id;
  const language = await getLanguage(env, userId);
  const labels = t(language);

  if (data === "lang:ca" || data === "lang:es") {
    const selected = data.endsWith("es") ? "es" : "ca";
    await setLanguage(env, userId, selected);
    await answerCallbackQuery(env, callback.id, selected === "ca" ? "Idioma: català" : "Idioma: castellano");
    if (chatId) await sendMessage(env, chatId, t(selected).welcome, discoveryKeyboard(selected));
    return;
  }

  if (data.startsWith("quick:")) {
    await answerCallbackQuery(env, callback.id);
    if (!chatId) return;
    const quickAction = data.slice("quick:".length);
    if (quickAction === "nearby") {
      await sendNearby(env, chatId, language, undefined, userId);
    } else if (quickAction === "today") {
      await sendResults(env, chatId, language, { ...todayWindow(), limit: 1000 });
    } else if (quickAction === "concerts") {
      await sendResults(env, chatId, language, { ...nextSevenDaysWindow(), musicOnly: true, limit: 1000 });
    } else if (quickAction === "festes") {
      await sendResults(env, chatId, language, { ...nextSevenDaysWindow(), festiveOnly: true, limit: 1000 });
    } else if (quickAction === "program") {
      await sendMessage(env, chatId, labels.missingProgram);
    }
    return;
  }

  const [action, reference, extra, flag] = data.split(":");
  if (!reference || !isEventReference(reference)) {
    await answerCallbackQuery(env, callback.id);
    return;
  }
  let event: EventItem | null;
  try {
    event = await getEventByReference(reference, { fresh: action === "p" && flag === "r" });
  } catch (error) {
    console.error("Agenda detail query failed", { error: String(error) });
    await answerCallbackQuery(env, callback.id, labels.error);
    return;
  }
  if (!event) {
    await answerCallbackQuery(env, callback.id, labels.noResults);
    return;
  }

  if (action === "p") {
    const requestedPage = Number.parseInt(extra ?? "0", 10);
    if (!isFestaMajor(event)) {
      await answerCallbackQuery(env, callback.id, labels.noProgram);
      return;
    }
    const document = await getOfficialProgramDocument(env, event, { fresh: flag === "r" });
    const pages = programPages(event, language, new Date(), document ?? undefined);
    const pageIndex = Number.isSafeInteger(requestedPage)
      ? Math.min(Math.max(requestedPage, 0), Math.max(0, pages.length - 1))
      : 0;
    await answerCallbackQuery(env, callback.id, flag === "r" ? labels.programRefreshed : undefined);
    if (chatId && callback.message?.message_id) {
      try {
        await editMessageText(
          env,
          chatId,
          callback.message.message_id,
          pages[pageIndex] ?? labels.noProgram,
          programKeyboard(event, language, pageIndex, pages.length, document?.sourceUrl)
        );
      } catch (error) {
        const unchanged = error instanceof TelegramApiError
          && error.errorCode === 400
          && /message is not modified/i.test(error.message);
        if (!unchanged) throw error;
      }
    } else if (chatId) {
      await sendMessage(
        env,
        chatId,
        pages[pageIndex] ?? labels.noProgram,
        programKeyboard(event, language, pageIndex, pages.length, document?.sourceUrl)
      );
    }
    return;
  }

  if (action === "detail") {
    await answerCallbackQuery(env, callback.id);
    if (chatId) await sendMessage(env, chatId, detailText(event, language), detailKeyboard(event, language));
    return;
  }
  if (action === "rem") {
    await ensureUser(env, userId, language);
    if (chatId) await createReminder(env, userId, chatId, event, reminderTimeFor(event.startsAt));
    await answerCallbackQuery(env, callback.id, labels.reminderSaved);
    return;
  }
  if (action === "report") {
    await answerCallbackQuery(env, callback.id);
    if (chatId) {
      await sendMessage(env, chatId, language === "ca" ? "Què cal corregir?" : "¿Qué hay que corregir?", {
        inline_keyboard: [[
          { text: language === "ca" ? "Cancel·lat" : "Cancelado", callback_data: `fix:${reference}:cancelled` },
          { text: language === "ca" ? "Hora" : "Hora", callback_data: `fix:${reference}:time` },
          { text: language === "ca" ? "Lloc" : "Lugar", callback_data: `fix:${reference}:place` }
        ]]
      });
    }
    return;
  }
  if (action === "fix" && ["cancelled", "time", "place", "other"].includes(extra ?? "")) {
    await ensureUser(env, userId, language);
    await createCorrection(env, userId, event.sourceRowId ?? event.code, extra as CorrectionType);
    await answerCallbackQuery(env, callback.id, labels.reportSaved);
    if (env.ADMIN_TELEGRAM_ID) {
      await sendMessage(env, env.ADMIN_TELEGRAM_ID, `⚠️ Correcció pendent · ${escapeHtml(event.title)} · ${extra}`);
    }
    return;
  }
  await answerCallbackQuery(env, callback.id);
}

async function handleInlineQuery(env: Env, inlineQuery: TelegramInlineQuery): Promise<void> {
  const language = await getLanguage(env, inlineQuery.from.id);
  const queryText = inlineQuery.query.trim().slice(0, 80);
  const window = nextSevenDaysWindow();
  const parsedOffset = Number.parseInt(inlineQuery.offset, 10);
  const offset = Number.isSafeInteger(parsedOffset) && parsedOffset >= 0 ? Math.min(parsedOffset, 960) : 0;
  let allEvents: EventItem[];
  try {
    allEvents = await getEvents({
      ...window,
      query: queryText || undefined,
      latitude: inlineQuery.location?.latitude,
      longitude: inlineQuery.location?.longitude,
      radiusKm: inlineQuery.location ? 40 : undefined,
      musicOnly: queryText ? undefined : true,
      limit: 1000
    });
  } catch (error) {
    console.error("Inline agenda query failed", { error: String(error) });
    await answerInlineQuery(env, inlineQuery.id, []);
    return;
  }
  const events = allEvents.slice(offset, offset + 12);

  const results = events.map((event) => ({
    type: "article",
    id: `${event.code}:${event.municipalitySlug}`.slice(0, 64),
    title: event.title.slice(0, 128),
    description: `${event.municipality} · ${formatDateRange(event.startsAt, event.endsAt, language)}`.slice(0, 256),
    input_message_content: {
      message_text: detailText(event, language),
      parse_mode: "HTML",
      disable_web_page_preview: true
    },
    reply_markup: detailKeyboard(event, language)
  }));
  const nextOffset = allEvents.length > offset + events.length ? String(offset + events.length) : "";
  await answerInlineQuery(env, inlineQuery.id, results, nextOffset);
}

export async function handleUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(env, update.callback_query);
  } else if (update.inline_query) {
    await handleInlineQuery(env, update.inline_query);
  } else if (update.message) {
    await handleMessage(env, update.message);
  }
}

export async function sendDueReminders(env: Env): Promise<void> {
  const now = new Date();
  const reminders = await claimDueReminders(env, now.toISOString());
  for (const reminder of reminders) {
    const url = reminder.event_url ? `\n<a href="${escapeHtml(reminder.event_url)}">Obrir la font oficial</a>` : "";
    try {
      await sendMessage(env, reminder.chat_id, `🔔 <b>Recordatori de festa</b>\n\n${escapeHtml(reminder.event_title)}${url}`);
      await markReminderSent(env, reminder.id, reminder.claim_token);
    } catch (error) {
      const description = error instanceof Error ? error.message : String(error);
      const telegramCode = error instanceof TelegramApiError ? (error.errorCode ?? error.httpStatus) : undefined;
      const terminal = telegramCode === 400 || telegramCode === 403 || reminder.attempts >= 5;
      if (terminal) {
        await markReminderFailed(env, reminder.id, reminder.claim_token, description);
      } else {
        const requestedDelay = error instanceof TelegramApiError ? error.retryAfterSeconds : undefined;
        const backoffSeconds = requestedDelay ?? Math.min(21_600, 300 * 2 ** Math.max(0, reminder.attempts - 1));
        await markReminderRetry(env, reminder.id, reminder.claim_token, new Date(now.getTime() + backoffSeconds * 1000).toISOString(), description);
      }
      console.error("Reminder delivery failed", { terminal, attempt: reminder.attempts, error: description });
    }
  }

  if (now.getUTCHours() === 2 && now.getUTCMinutes() < 5) {
    await Promise.all([cleanupReminders(env), cleanupCorrections(env), cleanupProcessedUpdates(env)]);
  }
}
