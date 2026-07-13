# OBJETIVO

Migrar el backend de Render a Google Cloud Run.

# CONTEXTO

Sigues en la misma conversación, así que ya conoces el proyecto.

Hoy el backend corre en **Render** (`render.yaml`, `backend/Dockerfile`), pero Firestore
y Cloud Storage **ya están en GCP**: la mitad del sistema vive allí y la otra mitad fuera.
`Docs/idea.txt` siempre dijo Cloud Run; Render fue el atajo.

**El motivo real de moverlo ahora, y va primero porque es el que manda:** el export
trimestral que acabas de construir **no se dispara solo**. Los Cron Jobs de Render no
entran en el plan free, así que el `render.yaml` tiene el bloque escrito pero muerto.
**Cloud Scheduler sí es gratis** (3 jobs/mes en free tier) y resuelve exactamente eso.
Si la migración no deja el export disparándose solo el día siguiente al cierre del
trimestre, no ha servido para nada.

Hay un segundo motivo, más pequeño pero real: en Cloud Run las credenciales de GCP son
las de la propia identidad del servicio (ADC), así que **`GOOGLE_CREDENTIALS_JSON`
desaparece** — hoy es un JSON de cuenta de servicio viajando por variables de entorno.

# QUÉ HACER

1. **Despliegue**: lo mínimo que funcione. Cloud Run desde el `Dockerfile` que ya hay
   (ojo: weasyprint necesita las libs de sistema, ya están resueltas ahí). Sin mínimo de
   instancias: el arranque en frío es aceptable a 3-4 facturas al mes.
2. **Secretos**: las variables que hoy están en Render. Usa Secret Manager para los
   secretos de verdad (tokens de Meta, OAuth, `TAREAS_TOKEN`) y variables normales para
   lo que no lo es. Quita `GOOGLE_CREDENTIALS_JSON` y tira de ADC.
3. **Cloud Scheduler**: el job del export trimestral, que llame a
   `POST /tareas/export-trimestral` el día siguiente al cierre (1 de enero, abril, julio
   y octubre) con su `X-Tarea-Token`. **Esto es el entregable que justifica la migración.**
4. **Infra como código**: actualiza `infra/setup_gcp.sh` (ya existe) para que deje todo
   creado. Que sea repetible, no una lista de clics.
5. **Los pasos manuales que NO puedes hacer tú**, en un documento claro y corto:
   - la **URL del webhook de Meta** hay que cambiarla en el panel de Meta,
   - el **redirect URI de OAuth** hay que darlo de alta en la consola de Google,
   - qué secretos hay que crear y con qué valor.
   Si esto no queda escrito, la migración no la puede terminar nadie.
6. **Render**: déjalo funcionando. Nada de big-bang: primero Cloud Run verificado, y solo
   entonces se apaga Render. Di explícitamente en qué orden hacer el corte.

# REGLAS DURAS

- **NO** rompas el webhook de WhatsApp ni la numeración correlativa de facturas.
- **NO** toques la lógica de negocio (facturas, IVA, export). Esto es despliegue.
- **NO** metas Terraform ni nada grande: volumen bajo, **coste mínimo y simplicidad**.
  Un script y un `gcloud run deploy` bastan.
- **NO** dejes secretos en el repo ni en el git log.

# CRITERIO DE TERMINADO

- Los tests que ya había siguen en verde (no los rompas).
- El export trimestral queda **disparándose solo** en Cloud Scheduler.
- Los pasos manuales, escritos y sin ambigüedad.
- **git commit** explicando el *porqué*, no el *qué*.

# SI TE QUEDAS SIN CUPO

Deja el trabajo consistente y commiteado, y escribe en el commit qué falta.
