# Modelo de créditos de interacción (transversal a todos los verticales)

Documento de diseño. Creado el 2026-10-07. Aplica a cualquier vertical (turismo, comercial, otros): lo que cambia por vertical es la tarifa de créditos de cada acción, no el mecanismo. Es una propuesta, no una decisión cerrada; las cifras de costo son supuestos que hay que medir.

## 1. Idea central
Vender **interacciones**, no tokens. El cliente compra o recibe cada mes una bolsa de créditos; cada acción del agente consume una cantidad fija y publicada de créditos, sin importar cuántos tokens gastó realmente. Los tokens son costo de ventas nuestro. Este es el mismo patrón que usan:
- **TuHotelia:** 10.000 créditos al mes incluidos en el plan con IA; 1 crédito por respuesta de texto, 3 por reporte, 5 por revisión de habitación; paquetes de 5.000 por 75.000 COP y de 10.000 por 135.000 COP con vigencia de 90 días; aviso al 80 % y 100 %; al agotarse se pausan solo los asistentes.
- **net2phone:** 20.000 créditos de interacción por 99,99 USD al mes (10.000 mensajes o 2.000 minutos de voz básicos), con planes de 60.000 y 150.000.

No es reventa de acceso a modelos: el cliente no recibe una llave ni elige modelo; compra un servicio medido en interacciones.

## 2. Por qué es necesario para cualquier vertical
1. **Protege el margen** frente a conversaciones largas, abuso y picos.
2. **Hace predecible la factura** del cliente.
3. **Es la base de la cuota por plan** y de la facturación por exceso.
4. **Permite cambiar de modelo o de router** sin cambiar el precio al cliente.
5. **Alimenta la analítica de costo por resultado** (costo por reserva, por lead, por cita).

## 3. Unidad y tarifario
- **1 crédito = 1 respuesta de texto del agente** (unidad base). Todo lo demás se expresa en múltiplos.
- Tarifario inicial (a validar con costos medidos):

| Acción | Créditos | Notas |
|---|---|---|
| Respuesta de texto del agente | 1 | Incluye consulta a base de conocimiento |
| Respuesta con herramienta (disponibilidad, cotización, cita) | 2 | Llama a un sistema externo |
| Mensaje de audio transcrito y respondido | 3 | Transcripción más respuesta |
| Análisis de imagen o documento | 5 | |
| Reporte o resumen generado | 3 | |
| Mensaje saliente automático por plantilla (recordatorio, seguimiento) | 0 | Sin IA; el costo de Meta lo paga el cliente |
| Seguimiento redactado por IA | 1 | |

Cada vertical agrega o ajusta filas. Las acciones sin IA (reglas, recordatorios) no consumen créditos, como hace TuHotelia.

## 4. Economía unitaria (supuestos que hay que verificar)
- **Costo medido en el router de Hostinger:** cada respuesta incluye `usage.credits_charged`. Precio de `gpt-5.6-luna`: 24 créditos por millón de tokens de entrada y 144 de salida.
- **Supuesto de conversión:** 500 créditos del router ≈ 5,99 USD, es decir, 1 crédito del router ≈ 0,012 USD (inferido del precio del primer paquete; confirmar con la factura).
- **Costo por respuesta, según el tamaño del contexto:**
  - Agente ligero: unos 3.000 tokens de entrada y 300 de salida. Costo = 3.000 × 24 / 1.000.000 + 300 × 144 / 1.000.000 = 0,115 créditos del router ≈ **0,0014 USD**.
  - Con el prompt completo de Hermes (unos 11.000 tokens de entrada solo de sistema): 0,27 créditos o más ≈ **0,0033 USD** antes del caché del proveedor.
- **Precio de venta de referencia:** TuHotelia cobra 14 a 15 COP por crédito extra; net2phone, unos 0,01 USD por mensaje. Con un tipo de cambio supuesto de 4.000 COP por dólar, 15 COP ≈ 0,0038 USD.
- **Lectura:**
  - Con un agente ligero (0,0014 USD), vender a 15 COP deja un margen bruto del orden de 60 %.
  - Con el contexto grande de Hermes (0,0033 USD), el margen casi desaparece.
  - **Conclusión de ingeniería:** el agente que atiende clientes debe mantener un contexto pequeño (resumir historial, recuperar solo los fragmentos relevantes con RAG, aprovechar el caché de prompts) y usar un modelo barato por defecto, subiendo de modelo solo cuando haga falta.
- A este costo hay que sumarle WhatsApp (Zernio, 3 USD al mes por número), infraestructura, soporte y la tarifa de Meta, que la paga el cliente.

## 5. Planes y paquetes (estructura, no precios finales)
- **Bolsa mensual incluida en cada plan** (no se acumula), con **paquetes adicionales** de vigencia limitada (90 días como referencia).
- **Aviso al 80 % y al 100 %** de la bolsa, por el panel y por WhatsApp o correo al administrador.
- **Al agotarse:** el agente deja de responder automáticamente y las conversaciones pasan a la bandeja humana con un mensaje de cortesía configurable; el CRM, la bandeja y las difusiones siguen funcionando. Nunca se corta el servicio completo.
- **Recarga:** compra manual en el panel (medios de pago locales). Recarga automática opcional, con tope mensual definido por el cliente. Los cobros automáticos sin autorización expresa no se hacen.
- **Pruebas:** bolsa pequeña gratuita para el período de prueba, con tope por entrevista o por sesión para evitar abuso.
- **Precios por vertical:** el valor del crédito puede variar por vertical si el valor del resultado cambia (una reserva hotelera frente a una cita de consultorio), pero la bolsa y las reglas son las mismas.

## 6. Diseño técnico
Tablas (todas con `account_id` y RLS; en turismo también `property_id`):
- `credit_wallets`: saldo de la bolsa del ciclo y de paquetes, con fechas de vigencia.
- `credit_ledger`: asientos inmutables (concesión de plan, compra de paquete, consumo, ajuste, vencimiento), con saldo posterior.
- `llm_usage`: costo real por llamada (`credits_charged` del router, tokens, modelo, latencia, identificador de conversación y de acción). Es la base del margen y de la facturación interna; no se muestra como créditos al cliente.
- `credit_rates`: tarifario por acción y vertical, con versión y fecha de vigencia.

Flujo de cada interacción:
1. **Reservar** créditos estimados antes de llamar al modelo (si el saldo no alcanza, derivar a humano).
2. Llamar al modelo y al sistema externo.
3. **Confirmar** el consumo según el tarifario (no según los tokens) y registrar en `llm_usage` el costo real.
4. Idempotencia por identificador de mensaje: un reintento no cobra dos veces; las llamadas fallidas no se cobran.
5. Alertas al cruzar el 80 % y el 100 %.

Controles:
- **Margen en vivo:** créditos cobrados al cliente frente a costo real por cuenta, acción y modelo; alerta si una cuenta cae bajo un margen mínimo.
- **Conciliación diaria** del gasto real del router contra la suma de `llm_usage`.
- **Alerta de saldo del router** (créditos prepagados de Hostinger) en Uptime Kuma, porque si se agota se detienen todos los clientes.
- Tope por conversación y por IP en canales públicos (entrevista de onboarding, widget web).

## 7. Decisiones abiertas
1. Valor de venta del crédito y tamaño de las bolsas por plan (medir primero el costo real con el agente ligero).
2. Si los créditos de plan se acumulan o no (TuHotelia no los acumula).
3. Qué hacer cuando se agotan: solo pausar el agente o permitir exceso con cobro automático autorizado.
4. Si se expone al cliente el consumo detallado por acción.
5. Cómo facturar en Colombia (IVA, factura electrónica) y qué pasarela usar para las recargas.
6. Si el crédito vale lo mismo en todos los verticales.
7. Confirmar en los términos del router de Hostinger que usarlo como motor de un producto medido por interacciones está permitido, y confirmar la conversión del crédito del router a dólares.

## 8. Decisiones del 2026-10-15
1. **El crédito es el eje del precio** y se mide por acción con tarifa fija (no por contactos).
2. **Reinicio mensual** de la bolsa del plan, sin acumulación; los paquetes extra tienen su propia vigencia.
3. **Los créditos de la entrevista de onboarding van dentro del precio de instalación**, no en la bolsa mensual.
4. **Conversión del router confirmada:** 500 créditos = 5,99 USD (0,01198 USD por crédito del router). Ver `medicion-de-costos.md`.
5. **Los precios finales se decidirán con datos medidos** (`router_credits` en `ai_usage_log`, activo desde el 2026-10-15) y con una revisión de los planes de la competencia.

## 9. En revisión (ideas, no decididas)
Se retoman después de medir y de revisar la competencia.
- **Los créditos no se cobran como línea aparte:** vienen incluidos en cada plan de servicio.
- **Planes de servicio por función:** calificación de leads, ventas, soporte y reserva en calendario. Se podrán mezclar con un **precio combo** por verificar.
- **Diferenciación frente a los CRM que cobran por usuario:** planes con **3 usuarios incluidos** y una bolsa de créditos por plan (ejemplo del cliente: 2.000, 4.000 y 5.000 créditos); usuarios adicionales se venden aparte.
- **Atribución del lead** (de qué campaña llegó, lo que respond.io llama "captura de leads"). Dos caminos a comparar:
  - A. Integraciones vía Zernio con Meta Ads y Google Ads.
  - B. Que el agente de TUYO CRM consulte directamente el MCP de cada plataforma, sin pagar a Zernio por eso.
  - Por investigar: los anuncios de Meta que abren WhatsApp (click-to-WhatsApp) pueden traer datos de origen dentro del propio mensaje entrante (Zernio expone `ctwaClid` en eventos de WhatsApp), lo que podría dar atribución sin costo extra.

