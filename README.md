# FestaBot Catalunya

![Icono de FestaBot Catalunya](assets/festabot-avatar.png)

Bot de Telegram para descubrir fiestas, conciertos y actividades culturales de Catalunya. El producto funciona íntegramente dentro de Telegram y consulta la API pública de la Agenda Cultural de la Generalitat.

En producción: [@FestaCatalunyaBot](https://t.me/FestaCatalunyaBot) · [estado del servicio](https://festabot-catalunya.adrimg3196.workers.dev/health)

## Funciones del MVP

- `/avui [municipi]`: actividades de hoy.
- `/capdesetmana [municipi]`: planes del próximo fin de semana.
- `/aprop`: búsqueda por ubicación temporal o por el municipio guardado, respetando el radio configurado. Si no se puede localizar el municipio, solicita una ubicación.
- `/municipi <nom>`: búsqueda para los próximos siete días.
- `/concerts [municipi]`: música y conciertos.
- `/festes [municipi]`: lista de fiestas o programa directo cuando se indica un municipio.
- `/programa <municipi>`: programación publicada de la Fiesta Mayor dentro de Telegram, con páginas y actualización manual.
- También se puede escribir solo el municipio —por ejemplo, `Blanes`— para abrir directamente su Fiesta Mayor si está publicada.
- `/artista <nom>`: búsqueda por artista o título.
- `/pla <municipi>`: encuesta con tres planes para un grupo.
- Modo inline para compartir actividades en cualquier chat.
- Recordatorios, correcciones comunitarias y borrado de datos.
- Catalán y castellano.

## Arquitectura de coste cero

- Cloudflare Worker: webhook y lógica del bot.
- Cloudflare D1: idioma, recordatorios, correcciones y programas oficiales ya procesados.
- Rate Limiting de Cloudflare: protección por usuario frente a abuso.
- Telegram Bot API: única interfaz de usuario.
- Socrata `rhpv-yr4f`: índice oficial consultado en tiempo real.
- GitHub Actions + `unpdf`: cada 30 minutos extraen gratuitamente el texto de los PDF oficiales fuera de las peticiones y lo sincronizan con D1.
- Caché máxima de cinco minutos para listados; `/programa` y `🔄 Actualitza` vuelven a consultar la revisión de la fuente oficial.

No se utiliza ningún modelo de IA ni API de pago en producción.

El despliegue actual usa únicamente cuotas gratuitas. El coste cero depende de los límites y condiciones vigentes de Cloudflare, Telegram y Socrata; si un proveedor los cambia o se supera una cuota, habrá que limitar tráfico o migrar antes de aceptar un servicio de pago.

## Estado de producción

- Worker y cron publicados en Cloudflare.
- D1 alojada con jurisdicción de la Unión Europea y las cuatro migraciones aplicadas.
- Tokens del bot, webhook y sincronización almacenados como secretos cifrados de Cloudflare y GitHub, nunca en Git.
- Webhook activo en `/telegram/webhook`, sin errores ni actualizaciones pendientes al desplegar.
- Perfil, avatar, comandos en catalán y castellano y modo inline habilitados en Telegram.
- Prueba real superada: escribir solo `Blanes` muestra `Programa oficial · 1/2`, `Següent` abre la segunda página y `🔄 Actualitza` renueva la comprobación sin salir de Telegram.

## Cobertura actual

El catálogo inicial procede de la Agenda Cultural de Catalunya y se limita a ubicaciones de las cuatro provincias catalanas. Cuando la ficha enlaza un PDF oficial con texto, la sincronización automática lo extrae y el Worker lo pagina para mostrar el programa dentro del chat; el enlace queda solo como referencia opcional. Si todavía no hay un documento extraíble, el bot identifica claramente el contenido como «resumen oficial publicado», muestra la fecha de modificación y permite volver a consultarlo sin salir de Telegram.

La Agenda central es una fuente oficial, pero algunas fichas son resúmenes y no garantizan que el ayuntamiento haya publicado allí todos los actos o cambios de última hora. La siguiente capa de cobertura serán adaptadores municipales para API, ICS, HTML y PDF oficiales, manteniendo la Agenda como índice y respaldo.

## Desarrollo

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm test
npm run dev
```

## Despliegue

1. Autenticar Wrangler con `npx wrangler login`.
2. Crear D1 en la UE con `npx wrangler d1 create festabot-catalunya --jurisdiction eu`.
3. Sustituir `database_id` en `wrangler.toml`.
4. Aplicar migraciones con `npm run db:migrate:remote`.
5. Hacer un primer despliegue con `npm run deploy`.
6. Guardar los tres secretos obligatorios con `npx wrangler secret put`:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET`
   - `PROGRAM_SYNC_SECRET`
7. Opcionalmente, añadir `ADMIN_TELEGRAM_ID` para recibir avisos privados sobre correcciones.
8. Volver a desplegar con `npm run deploy`.
9. Guardar el mismo `PROGRAM_SYNC_SECRET` como secreto del repositorio de GitHub para el workflow `sync-programs.yml`.
10. Configurar comandos y modo inline en BotFather y registrar el webhook exacto `https://festabot-catalunya.adrimg3196.workers.dev/telegram/webhook` mediante Telegram Bot API.
11. Verificar `/health`, `getWebhookInfo`, el workflow de sincronización y que `npm run db:migrate:remote` no tenga migraciones pendientes.

Nunca se debe guardar el token de Telegram en el repositorio.

## Privacidad

La ubicación compartida se usa solo en memoria para calcular distancias, se redondea antes de consultar la fuente oficial y no se persiste. El usuario puede borrar idioma, seguimientos, recordatorios y correcciones con `/esborra_dades`. Las actualizaciones procesadas caducan a los 7 días; recordatorios enviados o fallidos, a los 30 días; y correcciones, a los 90 días.

## Fuente de datos

- [Agenda Cultural de Catalunya](https://agenda.cultura.gencat.cat/)
- [Dataset abierto](https://analisi.transparenciacatalunya.cat/d/rhpv-yr4f)
- [Idescat: coordenadas municipales](https://www.idescat.cat/dev/api/emex/), indicadores f328/f329. La referencia municipal permite buscar también en municipios vecinos, sin depender de que haya eventos en el municipio guardado. La petición es común a todos los usuarios, se almacena en caché durante 24 horas y no incluye preferencias ni ubicaciones personales. [Condiciones de uso](https://www.idescat.cat/dev/api/).
