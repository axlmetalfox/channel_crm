# Analista de anuncios — Fase 1 (solo lectura)

Estado: **diseño, nada construido**. Fecha: 2026-10-22.

## 1. Objetivo y alcance

Cada semana (o con un botón) el sistema revisa las campañas de Meta de la cuenta y entrega una lista corta de recomendaciones **con evidencia**, ordenadas por impacto en dinero. Las personas deciden y marcan si la recomendación les sirvió.

Dentro de la Fase 1:
- Detectar dónde se pierde o se gana dinero (reglas en código).
- Priorizar, conectar hallazgos y redactar (modelo de lenguaje, agente separado del de conversaciones).
- Guardar cada recomendación, su estado y la opinión de quien la revisa.
- Registrar el costo en créditos de cada análisis.

Fuera de la Fase 1: ejecutar cambios en Meta (pausar, presupuesto), traer ventas ganadas de Zoho, Google/TikTok, desglose por edad/género/ubicación, MCP.

## 2. Arquitectura

```
ad_catalog + ad_insights_daily (ya existen)   conversations + lead_intakes (ya existen)
                    \                                 /
                     v                               v
              [1] Snapshot (código): une anuncio -> campaña, chats, leads, gasto, tendencia
                                   |
                                   v
              [2] Detectores (código): hallazgos con umbrales fijos y huella estable
                                   |
                                   v
              [3] Analista (modelo): prioriza, conecta, redacta -> JSON estricto
                                   |
                                   v
              [4] Validador (código): cifras y entidades deben existir en los datos
                                   |        (falla -> 1 reintento -> texto de plantilla sin modelo)
                                   v
              [5] Persistencia + UI + registro de créditos
```

Principio: **el modelo nunca calcula ni inventa cifras**. Recibe números ya calculados y solo puede citarlos.

## 3. Snapshot (paso 1)

Ventana de análisis: últimos 14 días (`actual`) frente a los 14 anteriores (`previo`). Configurable.

Por anuncio con gasto o chats en la ventana (máx. 40, por gasto):
`ad_id, nombre, titular, campaña (id, nombre), conjunto, estado, días activo, gasto, impresiones, clics, conversaciones_tuyo, leads_tuyo, conversaciones_meta, costo_por_conversación, costo_por_lead, tasa_chat_a_lead` — cada una para `actual` y `previo`.

Por campaña: los mismos totales agregados y número de anuncios.

Cuenta: gasto total, costo por conversación y por lead (mediana y promedio ponderado), tasa chat→lead, conversaciones directas (sin anuncio).

Fuente: las funciones que ya alimentan la tarjeta de atribución (`attribution_summary`, `ad_performance_summary`) llamadas para las dos ventanas. Se reutiliza `withAdPerformance`. Tamaño esperado para Intertec: 6–10 mil tokens.

Nota: el snapshot no incluye frecuencia ni alcance (no se guardan hoy). Si más adelante hacen falta, se agrega `reach` a `ad_insights_daily` (migración pequeña).

## 4. Detectores (paso 2)

Cada detector devuelve `Finding { tipo, entidad, severidad, dinero_en_juego, evidencia[], huella }`. Los umbrales son valores iniciales a calibrar con datos reales de Intertec en el backtest (sección 9).

| # | Detector | Condición inicial | Dinero en juego |
|---|----------|-------------------|-----------------|
| D1 | Gasto sin resultados | anuncio activo ≥ 4 días, 0 conversaciones, gasto ≥ 2 × costo por conversación de la cuenta | gasto del anuncio |
| D2 | Costo alto | costo por lead > 1,5 × mediana de la cuenta, con ≥ 5 leads | (costo − mediana) × leads |
| D3 | Eficiente con poco presupuesto | costo por lead ≤ 0,7 × mediana, ≥ 5 leads, < 15 % del gasto | presupuesto que podría absorber |
| D4 | Chats que no convierten | ≥ 20 conversaciones y tasa chat→lead < 50 % de la de la cuenta | gasto × (1 − tasa/tasa_cuenta) |
| D5 | Deterioro de tendencia | costo por conversación sube ≥ 30 % vs periodo previo con gasto similar (±25 %) y ≥ 10 conversaciones en ambos | diferencia de costo × conversaciones |
| D6 | Mismo titular en varios conjuntos | ≥ 2 conjuntos con el mismo titular y medios; comparten audiencia | gasto del grupo |
| D7 | Brecha de medición | conversaciones que informa Meta vs TUYO difieren > 30 % en el total de la campaña | n/a (alerta de confianza) |
| D8 | Gasto concentrado | un anuncio > 40 % del gasto de la cuenta | n/a (riesgo) |
| D9 | Datos insuficientes | entidad con gasto relevante pero muestra por debajo del mínimo | n/a: se informa "esperar" |

Reglas de seguridad comunes: no emitir hallazgos sobre anuncios con menos de 4 días activos ni pausados antes de la ventana; D2/D3/D4/D5 exigen el mínimo de muestra de su fila; si el mínimo no se cumple se emite D9.

`huella` = `tipo + entidad + ventana` (semana). Permite saber si un hallazgo es nuevo o se repite, y evita duplicar recomendaciones semana a semana.

## 5. Analista (paso 3)

Un solo llamado al modelo, salida **JSON estricto** (se usa `generateOpenAiJson`).

Entrada:
- Contexto de negocio (texto corto, editable por cuenta): qué vende, ciclo de venta, temporada, objetivo ("más leads de empacadoras, costo por lead < X").
- Resumen de cuenta y campañas, lista de hallazgos (con ids), recomendaciones previas con su estado y opinión (para no repetir lo descartado y reconocer lo aplicado).

Instrucciones: prioriza por dinero en juego y confianza; combina hallazgos relacionados en una sola recomendación; usa solo cifras del bloque `datos`; si la evidencia es débil di `esperar_datos`; máximo 7 recomendaciones; nunca ordenes una acción, propón.

Salida (por recomendación):
```json
{
  "prioridad": 1,
  "titulo": "string corto",
  "tipo_accion": "revisar_o_pausar | redistribuir_presupuesto | duplicar_creativo | probar_variante | consolidar | revisar_medicion | esperar_datos",
  "entidad": { "tipo": "anuncio|campaña|cuenta", "id": "string" },
  "hallazgos": ["huella1", "huella2"],
  "evidencia": [{ "metrica": "costo_por_lead", "valor": 41200, "referencia": 28900 }],
  "razonamiento": "2–4 frases en español",
  "efecto_esperado": "string o null",
  "confianza": "alta|media|baja",
  "advertencias": ["string"]
}
```
Más un `resumen` de 3–4 frases para la parte de arriba del panel.

Modelo: configurable (`ADS_ANALYST_MODEL`), del router actual. Es un agente aparte: otro prompt, otro modelo, sin acceso a conversaciones ni herramientas; solo recibe el snapshot.

## 6. Validador (paso 4)

Todo en código, antes de guardar:
1. El JSON cumple el esquema.
2. Cada `entidad.id` y cada `hallazgo` existe en el snapshot.
3. Cada número que aparece en `razonamiento`, `titulo` y `efecto_esperado` coincide (con tolerancia de redondeo) con un valor de `evidencia` o del snapshot. Si cita una cifra que no existe, la recomendación se rechaza.
4. `confianza: alta` solo se acepta si la muestra supera el doble del mínimo del detector.
5. `tipo_accion` coherente con el hallazgo (p. ej. no "duplicar" un anuncio con D1).

Si falla: un reintento indicando el error. Si vuelve a fallar, se publican los hallazgos con **texto de plantilla sin modelo** y la marca "redacción automática". El análisis nunca queda vacío por culpa del modelo.

## 7. Datos nuevos (migración 076, a autorizar cuando llegue el momento)

- `ad_analysis_runs`: `id, account_id, created_at, created_by (null si programado), window_from/to, model, status (ok|fallback|error), snapshot jsonb, summary text, prompt_tokens, completion_tokens, router_credits, error`.
- `ad_recommendations`: `id, run_id, account_id, huella_principal, prioridad, titulo, tipo_accion, entidad jsonb, evidencia jsonb, razonamiento, efecto_esperado, confianza, advertencias jsonb, status (nueva|vista|aplicada|descartada), feedback (util|no_util|equivocada), feedback_note, decided_by, decided_at`.
- `ai_usage_log.mode` admite `'ads_analysis'` (se amplía el CHECK como hicimos en 056).
- RLS: lectura para dueño y administradores; escritura solo servidor, salvo que quien tiene rol admin actualiza estado y opinión de sus recomendaciones mediante la API. Observadores: decisión pendiente (sección 12).

## 8. API, programación y pantalla

API (todas `requireRole('admin')`):
- `POST /api/ad-analyst/run` — lanza un análisis ahora. Límite: 3 por hora por cuenta.
- `GET /api/ad-analyst/latest` — último análisis con recomendaciones y las de semanas previas aún abiertas.
- `PATCH /api/ad-analyst/recommendations/[id]` — cambia estado y/o registra opinión.

Programación: dentro del barrido que ya corre, un paso `runAdAnalystIfDue` que lanza el análisis si pasaron 7 días y la sincronización de anuncios es reciente (< 12 h). Si la sincronización falló, espera.

Pantalla: un panel **«Recomendaciones»** debajo de la tarjeta de atribución en el panel principal (dueño y administradores):
- Encabezado: resumen del análisis, fecha, modelo, botón «Analizar ahora».
- Tarjetas por prioridad: título, etiqueta de confianza, «dinero en juego», chips de evidencia (valor frente a referencia), razonamiento.
- Botones: «Útil», «No útil», «Ya la apliqué», «Descartar». Una recomendación aplicada se vuelve a evaluar la semana siguiente con la misma entidad para ver el efecto.
- Historial plegable de semanas anteriores.
- Si la conexión de Meta no está activa o no hay datos: mensaje con enlace a Plataformas de anuncios.

## 9. Evaluación y elección de modelo (antes de activar)

Se construye un script de evaluación que reutiliza snapshot, detectores y analista:

1. **Backtest:** reconstruir el snapshot con corte en 3 fechas pasadas (hay 90 días de gasto diario y conversaciones). Lo que se marca como «gasto sin resultados» (D1) debe seguir sin resultados en los 7 días siguientes; lo marcado como eficiente (D3) debe mantener su costo. Se mide precisión de cada detector y se ajustan umbrales.
2. **Comparación de modelos:** 2–3 modelos del router con el mismo snapshot. Métricas objetivas: fidelidad de cifras (debe ser 100 % tras el validador), entidades válidas, porcentaje de respuestas que requieren reintento, tokens y créditos. Métrica subjetiva: tú calificas cada recomendación (útil / no útil / equivocada) sin saber qué modelo la escribió.
3. **Criterio de activación:** detectores con precisión aceptable (meta inicial ≥ 70 % en D1–D3), 0 cifras inventadas, y ≥ 70 % de las recomendaciones calificadas «útil».

## 10. Créditos y límites

- Cada análisis registra una fila en `ai_usage_log` (`mode='ads_analysis'`, tokens, `router_credits`). Costo esperado: una llamada de 8–12 mil tokens de entrada y ~2 mil de salida por semana; se mide en el backtest.
- La pestaña de Uso del agente muestra el consumo de este modo por separado.
- Tope configurable por cuenta (análisis por mes, por defecto 8). El cobro al cliente se conecta cuando exista el sistema de créditos del SaaS; hasta entonces solo se registra.

## 11. Pruebas

- Detectores: pruebas de tabla con casos límite (sin datos, un solo anuncio, muestra justo en el umbral, anuncio nuevo, anuncio pausado).
- Snapshot: igualdad con los totales de la tarjeta de atribución para el mismo rango.
- Validador: cifras inventadas, entidades inexistentes, JSON roto, `confianza` inflada.
- Analista: modelo simulado que devuelve respuestas buenas y malas; el flujo de reintento y de plantilla.
- Permisos: agentes no ven nada; observador según decisión.

## 12. Decisiones pendientes (con mi propuesta)

| Tema | Propuesta |
|------|-----------|
| ¿Quién ve las recomendaciones? | Dueño y administradores; observadores ven solo lectura si lo decides |
| Frecuencia | Semanal automática (lunes 6:00 hora de Bogotá) + botón manual |
| Ventana | 14 días vs 14 previos |
| Objetivo de la cuenta | Texto breve editable en la pantalla; para Intertec lo redactamos juntos |
| Modelos a probar | Dos del router con buen razonamiento y uno intermedio; los elegimos al empezar |
| Tope mensual | 8 análisis por cuenta por mes |

## 13. Orden de construcción

1. Snapshot y detectores (código puro, con pruebas). Entregable: salida en consola para Intertec, sin modelo.
2. Analista, validador y script de evaluación. Corremos el backtest y elegimos modelo.
3. Migración 076, API y registro de créditos.
4. Panel «Recomendaciones».
5. Programación semanal.

Cada paso se prueba y se te muestra antes de seguir. Migración, commit, push y redeploy se piden por separado, como siempre.

## 14. Resultados del paso 1 (2026-10-22) y ajustes al diseño

Código en `src/lib/ads-analyst/` (snapshot, detectores, cargador, pruebas, vista previa). Aún no está conectado a la app.

Ajustes que salieron de correrlo con los datos reales de Intertec:

1. **Cobertura de atribución.** TUYO guarda de qué anuncio viene cada chat solo desde el 2026-10-13. Antes de esa fecha un chat "sin anuncio" no significa que el anuncio no trajera chats. El snapshot recorta el gasto de ambas ventanas a partir de esa fecha (`attributionSince`) y expone `coverage`. La comparación contra el periodo previo (D5) solo corre cuando ese periodo está completo; con Intertec será posible a partir del 2026-11-10.
2. **Referencia de la cuenta.** Se usa el costo ponderado de la cuenta (gasto / leads de anuncios), no la mediana por anuncio: es más estable con muestras pequeñas.
3. **Huella.** `tipo + entidad`, sin fecha, para reconocer el mismo hallazgo semana a semana.
4. **Anuncios pausados.** D2, D4 y D5 también evalúan anuncios ya pausados, marcados como "lección, no acción" (por ejemplo, no relanzar un anuncio que costó cinco veces el promedio). D1, D3, D8 y D9 solo aplican a anuncios activos.
5. **D7 (brecha de medición) se reformuló.** Meta cuenta las conversaciones con ventana de atribución de 7 días (incluye quien vio el anuncio sin hacer clic), así que siempre cuenta más que TUYO. La alerta importa cuando la diferencia es enorme: en Intertec, la campaña de remarketing (Meta 169 vs TUYO 33) y una campaña "Clientes potenciales" (Meta 26 vs TUYO 0). El dinero en juego es gasto × diferencia. La severidad nunca pasa de "media" porque es una alerta de medición, no una prueba.
6. **Hallazgo real:** un anuncio ("Te asesoramos ya") costó $ 77.830 por lead frente a $ 15.415 de la cuenta y concentró el 41 % del gasto, ya pausado.

## 15. Resultados del paso 2 (2026-10-23): analista, validador y prueba de modelos

Código: `analyst.ts` (prompt, esquema, validador, plantilla, ejecución con un reintento), `numbers.ts` (comprobación de cifras), `eval.test.ts` (evaluación manual). Con pruebas; sin conectar a la app.

Cambios al diseño:
- **El modelo ya no devuelve entidad ni evidencia.** Solo elige hallazgos por su huella y escribe título, razonamiento, efecto esperado y advertencias. La entidad y la evidencia las copia el código del primer hallazgo. Quita dos vías de error.
- **Ningún análisis queda vacío:** si el modelo falla dos veces, se publican los hallazgos con texto de plantilla. Si no se detectó nada, ni se llama al modelo.
- **Hallazgos graves no se pierden:** si el modelo omite uno de severidad alta, se añade con texto de plantilla.
- **«esperar_datos»** se acepta siempre, salvo en hallazgos graves, y siempre con confianza baja.

Prueba de 6 modelos del router (datos reales de Intertec con 4 hallazgos, y una cuenta sintética con 12). Una sola pasada, sin reintento, con el validador final:

| Modelo | Reales | Sintético | Créditos del router por análisis | Observación |
|---|---|---|---|---|
| gpt-5.6-luna | rechazada* | válida | ≈ 0,4 | 13–15 s. *Una recomendación sin hallazgo citado; el reintento lo corrige |
| gemini-3.7-flash | válida | válida | ≈ 1,8 | 18 s. Algo más genérico; subió una confianza de más (el validador la bajó) |
| gpt-5.6-sol | válida | válida | 9–12 | 23–30 s |
| gpt-5.5 | válida | rechazada | 12–13 | calculó una cifra propia (20.000) y el validador la rechazó |
| claude-sonnet-5 | válida | falló el proveedor | ≈ 8 | 60 s; el router no aplica el esquema estricto a Claude |
| claude-opus-5 | JSON inválido | rechazada | 18–22 | ignoró el esquema y se quedó sin tokens |

Conclusión provisoria: **gpt-5.6-luna** como modelo por defecto (el mismo del agente de conversaciones, el más barato, con esquema estricto) y **gemini-3.7-flash** como alterno. Los modelos de Claude no sirven por el router para salida estructurada estricta y cuestan de 20 a 50 veces más. Falta la calificación a ciegas de las recomendaciones por parte de Alex antes de fijarlo.

El validador detectó en la práctica: acciones que no correspondían al hallazgo, una cifra calculada por el modelo, una recomendación sin hallazgo y confianzas infladas. Todo se cubre con reintento o plantilla.

