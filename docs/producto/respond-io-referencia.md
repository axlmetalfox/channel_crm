# respond.io como referencia para créditos y planes

Investigación del 2026-10-14. Fuentes: [AI Credits (centro de ayuda)](https://respond.io/help/organization-settings/ai-credits), [Pricing](https://respond.io/pricing), [cambio de precios de WhatsApp 2026](https://respond.io/blog/whatsapp-pricing-change-2026), reseñas de terceros ([eesel](https://www.eesel.ai/blog/respond-io-pricing), [Macha](https://www.getmacha.com/blog/respond-io-pricing-explained)). Las cifras de las dos primeras fuentes son oficiales; lo marcado "(tercero)" no lo pude confirmar en respond.io.

## 1. Cómo mide respond.io

**Dos medidores independientes:**
1. **Contactos activos mensuales (MAC):** cada contacto que envía o recibe un mensaje en el mes cuenta una vez, sin importar cuántos mensajes (las difusiones no cuentan). Es el eje de precio del plan.
2. **Créditos de IA:** unidad de consumo de las funciones de IA. Ocultan el costo real de tokens y modelos.

**Planes (USD, facturación anual por mes / mensual):**

| Plan | Mensual | Anual | Usuarios | Créditos de IA incluidos |
|---|---|---|---|---|
| Starter | 99 | 79 | 5 | 5.000 fijos |
| Growth | 199 | 159 | 10 | 10 × el tope de MAC (1.000 MAC → 10.000) |
| Advanced | 349 | 279 | 10 | 20 × MAC (1.000 → 20.000) |
| Enterprise | a medida | a medida | ilimitados | 40 × MAC (mínimo 40.000) |

Todos arrancan en 1.000 MAC. El exceso de contactos se cobra por bloques de 100 (Growth 12 USD, Advanced 15 USD por bloque (tercero)). Los topes de MAC autoservicio llegan hasta 10.000 y los créditos no suben más allá de eso.

**Consumo de créditos por acción (oficial):**

| Acción | Créditos |
|---|---|
| Prompt de IA, traducción, sugerencia del asistente | 1 |
| Resumen de chat / de cierre, sentimiento | 1 por conversación cerrada |
| Respuesta del Agente de IA | **2 a 5** por respuesta |
| Probar el Agente de IA | 2 a 3 por respuesta |
| Transcripción de audio | ~2 por minuto |
| Agente de voz | ~70 por minuto |

Respond.io avisa que las tasas pueden cambiar al actualizar modelos.

**Reglas de la bolsa:**
- Los créditos incluidos **se reinician cada ciclo**; no hay acumulación.
- **Exceso automático ("On-Demand"):** 15 USD por cada 1.000 créditos, en bloques de 1.000 redondeados hacia arriba, cobrados al cierre del ciclo en la misma factura. **No se puede desactivar** en los planes actuales. Tope duro: el uso total no pasa del **200 %** de la bolsa; ahí la IA se pausa hasta el siguiente ciclo (cobro máximo, con 10.000 incluidos: 150 USD).
- En Trial y planes antiguos no hay exceso: la IA se pausa al agotarse.
- **Visibilidad:** Configuración → Facturación y uso: barra de progreso, créditos adicionales, cargo acumulado y gráfico diario con una línea roja en el tope. Correos en varios umbrales y banners en la app (los porcentajes no están publicados).
- Política de uso justo: dicen que el 99 % de las empresas nunca llega al tope.
- **WhatsApp:** las tarifas de Meta se cobran **al costo, sin recargo**, con un saldo prepagado que el cliente recarga; desde el 2026-10-01 renuncian a la comisión de tarjeta en recargas.

## 2. Qué aprendemos para TUYO CRM

**a) El precio de mercado de una respuesta de IA es mucho mayor que nuestro costo.** Al precio de exceso, una respuesta del agente cuesta 0,03 a 0,075 USD (2 a 5 créditos × 0,015). Nuestro costo medido con `gpt-5.6-luna` es de unos 0,0014 a 0,0033 USD por respuesta. Hay mucho margen para cobrar menos que respond.io y aun así ganar bien. La referencia colombiana de TuHotelia (unos 0,004 USD por crédito) está muy por debajo del mercado internacional.

**b) Ligar los créditos al número de contactos no sirve para un agente de entrevista.** Respond.io da 10 créditos por MAC en Growth, o sea 2 a 5 respuestas por contacto al mes. El agente de Intertec usa unas 14 respuestas para capturar un lead, más una extracción. Con ese ratio, cada contacto se quedaría sin créditos a la mitad de la entrevista. Conclusión: **la bolsa debe medirse en créditos de interacción, no como múltiplo de contactos**, o el ratio debe ser mucho mayor para planes de captura.

**c) Tarifa fija y publicada por acción.** Respond.io cobra 2 a 5 créditos por respuesta, un rango que depende del uso y que el cliente no puede predecir. Mantengamos **1 crédito por respuesta de texto**, con múltiplos fijos para acciones con herramientas, audio o imágenes (ver `modelo-de-creditos.md`).

**d) Exceso: no auto-cobrar sin autorización.** Respond.io lo cobra siempre y sin opción de apagarlo. Para nuestro mercado (pymes colombianas, pagos locales) es mejor: al agotarse, pausar el agente y pasar a bandeja humana; ofrecer **recarga automática opcional con tope mensual** definido por el cliente. Se conserva de respond.io el **tope duro** como idea de seguridad.

**e) Reinicio mensual sin acumulación en la bolsa del plan; paquetes extra con vigencia.** Igual que respond.io en la bolsa, y como TuHotelia en los paquetes (90 días).

**f) Visibilidad como producto.** Barra de uso, gráfico diario con el tope y alertas por correo y banner son parte de la confianza del cliente. Para construirlo necesitamos primero persistir `credits_charged` del router en cada llamada (hoy solo guardamos tokens en `ai_usage_log`).

**g) WhatsApp aparte y al costo.** Respond.io no marca recargo sobre Meta y el cliente mantiene un saldo prepagado. Hay que decidir cómo lo resuelve nuestro canal con Zernio (qué parte paga el cliente directamente a Zernio o a Meta).

**h) Dos ejes de precio posibles.** Plan base por usuarios/canales/funciones + bolsa de créditos de IA, con los contactos como límite secundario (no como multiplicador de créditos).

## 3. Decisiones que se abren o se actualizan
1. ¿Plan por MAC (como respond.io), por créditos, o ambos? (Recomendación: créditos como medidor principal.)
2. Ratio de créditos por plan para agentes de entrevista (mínimo ~20 por lead capturado).
3. Precio de venta del crédito: entre el de TuHotelia y el de respond.io; medir el costo real primero.
4. Política de exceso: pausa + recarga manual por defecto, recarga automática opcional con tope.
5. Qué tope duro aplicar y qué alertas (por ejemplo 80 % y 100 %).
6. Quién paga las tarifas de Meta (directo del cliente vs. saldo prepagado en TUYO CRM).
7. Mantener pendiente: confirmar en los términos del router de Hostinger que se puede revender como producto medido por interacciones, y la conversión del crédito del router a USD.
