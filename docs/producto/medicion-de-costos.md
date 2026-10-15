# Medición del costo real por interacción

Creado el 2026-10-15. Complementa `modelo-de-creditos.md` y `respond-io-referencia.md`. Objetivo: fijar los precios en créditos para el cliente a partir de costos medidos, no estimados.

## 1. Decisiones tomadas
- El **crédito es el eje del precio** (no los contactos). Tarifa fija y publicada por acción.
- **Reinicio mensual** de la bolsa del plan, sin acumulación; paquetes extra con vigencia aparte.
- **El costo de la entrevista de onboarding va dentro del precio de instalación**; no se descuenta de la bolsa mensual del cliente.

## 2. Qué se mide y dónde
Cada llamada al modelo queda en `ai_usage_log` con tokens y, desde la migración 043, `router_credits`: lo que el router de Hostinger cobró (`usage.credits_charged`). Es **costo nuestro**; nunca se muestra al cliente ni se confunde con el crédito del cliente.

| Modo (`mode`) | Qué es |
|---|---|
| `auto_reply` | Respuesta del agente en una conversación real |
| `lead_extract` | Extracción del lead al cerrar la entrevista |
| `draft` | Borrador de respuesta para un agente humano |

`router_credits` es NULL en proveedores que no lo informan (p. ej. api.openai.com directo) y en las filas anteriores a la migración.

Conversión a dinero: **confirmada el 2026-10-15** con la compra real: 500 créditos del router = 5,99 USD, es decir **0,01198 USD por crédito del router** (≈ 0,012).

## 3. Consultas para analizar el costo
Ejecutar como `supabase_admin` (el panel del cliente no las expone).

Costo por cuenta y modo, últimos 30 días:
```sql
select account_id, mode, count(*) as llamadas,
       sum(total_tokens) as tokens,
       round(sum(router_credits)::numeric, 4) as creditos_router,
       round(avg(router_credits)::numeric, 5) as promedio_por_llamada
from ai_usage_log
where created_at > now() - interval '30 days' and router_credits is not null
group by 1, 2 order by 1, 2;
```

Costo por conversación (suma de respuestas + extracción):
```sql
select conversation_id,
       count(*) filter (where mode = 'auto_reply') as respuestas,
       round(sum(router_credits)::numeric, 4) as creditos_router_total,
       round((sum(router_credits) * 0.012)::numeric, 5) as usd_aprox
from ai_usage_log
where conversation_id is not null and router_credits is not null
group by 1 order by 3 desc;
```

Costo por lead entregado (conversaciones que terminaron en intake):
```sql
select i.id as intake, i.status,
       round(sum(u.router_credits)::numeric, 4) as creditos_router
from lead_intakes i
join ai_usage_log u on u.conversation_id = i.conversation_id
where u.router_credits is not null
group by 1, 2 order by i.created_at desc;
```
(Si una conversación tiene varios leads, esta suma los repite: para el piloto basta; luego se acota por ventana de fechas.)

## 4. Estandarizar la entrevista en "bloques"
Una entrevista es una secuencia de **bloques**: una pregunta del agente y la respuesta del cliente. El costo de un bloque no es constante porque el contexto crece con cada turno, así que se modela con dos parámetros medidos:

`costo(n bloques) ≈ a·n + b·n²`

donde `a` es el costo de un bloque con contexto mínimo y `b` el crecimiento por contexto acumulado.

Tipos de bloque para estandarizar el tamaño:

| Tipo | Ejemplo | Tokens de respuesta del cliente (referencia) |
|---|---|---|
| Dato corto | nombre, correo, ciudad | 5 a 20 |
| Descriptivo | "cuéntame qué empacas y cómo" | 30 a 120 |
| Documento / lista | pegar un catálogo, políticas | 300 a 2.000 |

**Protocolo de medición** (se puede repetir por vertical):
1. Escribir 3 guiones de entrevista de tamaño distinto: 20, 40 y 80 bloques, mezclando los tres tipos en proporciones fijas.
2. Correr cada guion 20 veces contra el modelo real, con el mismo prompt del agente, anotando `credits_charged` de cada llamada.
3. Ajustar `a` y `b` por mínimos cuadrados y publicar la tabla: "entrevista estándar de 40 bloques ≈ X créditos del router".
4. Aplicar un **margen de seguridad** (propongo 2x) para el precio de instalación, porque los clientes reales escriben más que los guiones.

La herramienta para correr los guiones está en `tools/cost-sim/` (simulador con el scaffold exacto de TUYO CRM; mide créditos por conversación).

## 5. Lo que ya sabemos (simulación, 2026-10-10)
- Entrevista de captura de lead de Intertec: unas 14 respuestas del agente.
- **0,14 a 0,21 créditos del router por conversación completa**, más ≈ 0,024 de la extracción.
- Equivale a unos **0,002 a 0,003 USD por lead** y a unos 0,00015 USD por respuesta (10 veces menos que la estimación inicial de `modelo-de-creditos.md`).
- Son datos de simulación con el modelo `gpt-5.6-luna`; faltan conversaciones reales.

## 6. Quién ejecuta la entrevista de onboarding
La entrevista de onboarding la conduce un **agente de Hermes** (en `vps-control`), que ya usa el mismo router (`https://router.hostinger.com/v1`) con el modelo `gpt-5.6-luna` y su propia clave (`HOSTINGER_AI_ROUTER_KEY`). Es independiente de los agentes de los clientes, que corren dentro de TUYO CRM y llaman al router con la clave que se configura en cada cuenta.

Consecuencias para la medición:
- **Costo de los agentes de clientes:** queda en `ai_usage_log` (por cuenta).
- **Costo de las entrevistas de Hermes:** no pasa por `ai_usage_log`. Para atribuirlo hay que registrar `credits_charged` de las llamadas de Hermes por sesión (Hermes guarda sesiones y puede escribir un archivo de uso con `--usage-file`) y, mejor aún, **usar una clave del router distinta** para las entrevistas, de modo que el gasto de onboarding se pueda separar del gasto de los clientes en el panel de Hostinger.

## 7. Siguientes pasos
1. Aplicar la migración 043 y desplegar (empieza a llenarse `router_credits`).
2. Dejar correr el piloto de Intertec unas semanas y leer las consultas de la sección 3.
3. Correr el protocolo de la sección 4 para la entrevista de onboarding.
4. Con esos datos, fijar el tarifario de créditos y el precio de instalación (ver decisiones abiertas en `modelo-de-creditos.md`).
