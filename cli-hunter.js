import fs from 'fs';
import path from 'path';
import { URL } from 'url';

// Utility logging
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// Clean filenames for OS safety
function sanitizeFilename(name) {
  return name.replace(/[\\\/:*?"<>|]/g, "").substring(0, 80).trim();
}

async function runCLI() {
  const repoUrl = process.env.REPO_URL || 'https://biblioteca.inia.cl';
  const keywords = process.env.KEYWORDS;
  const limit = parseInt(process.env.LIMIT) || 5;
  const sheetsWebhookUrl = process.env.SHEETS_WEBHOOK_URL;
  const driveFolderId = process.env.DRIVE_FOLDER_ID;

  if (!keywords) {
    log('❌ ERROR: Debe especificar la variable de entorno KEYWORDS (ej. "cultivo papa").');
    process.exit(1);
  }

  log(`🚀 Iniciando Cazador de PDF en modo CLI...`);
  log(`📍 Repositorio: ${repoUrl}`);
  log(`🔑 Palabras clave: ${keywords}`);
  log(`🔢 Límite: ${limit}`);
  if (sheetsWebhookUrl) log(`📊 Registro Sheets Webhook: Activo`);
  if (driveFolderId) log(`☁️ Carpeta Google Drive ID: ${driveFolderId}`);

  // Local temp folder on VM
  const tempPath = path.resolve('./temp_downloads');
  if (!fs.existsSync(tempPath)) {
    fs.mkdirSync(tempPath, { recursive: true });
  }

  // 1. Fetch already downloaded handles from Google Sheet (deduplication)
  let downloadedHandles = new Set();
  if (sheetsWebhookUrl) {
    log(`📡 Consultando registros previos en Google Sheets para evitar duplicados...`);
    try {
      const resSheet = await fetch(sheetsWebhookUrl.trim());
      if (resSheet.ok) {
        const sheetData = await resSheet.json();
        if (sheetData.success && Array.isArray(sheetData.handles)) {
          sheetData.handles.forEach(h => {
            if (h) downloadedHandles.add(h.toLowerCase().trim());
          });
          log(`📋 Se encontraron ${downloadedHandles.size} registros previos en Google Sheets.`);
        }
      }
    } catch (errSheet) {
      log(`⚠️ No se pudo consultar registros previos de Google Sheets: ${errSheet.message}`);
    }
  }

  // Resolve API Base
  let apiBase = repoUrl.trim();
  if (!apiBase.endsWith('/')) apiBase += '/';
  if (!apiBase.includes('/server/api') && !apiBase.includes('/api')) {
    apiBase += 'server/api/';
  }

  // Search
  const urlBusqueda = `${apiBase}discover/search/objects?query=${encodeURIComponent(keywords)}&size=40`;
  log(`📡 Buscando en: ${urlBusqueda}`);

  const response = await fetch(urlBusqueda, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });

  if (!response.ok) {
    log(`❌ Error de conexión con el repositorio: Código ${response.status}`);
    process.exit(1);
  }

  const dataBusqueda = await response.json();
  if (!dataBusqueda._embedded || !dataBusqueda._embedded.searchResult || !dataBusqueda._embedded.searchResult._embedded) {
    log('❌ Sin resultados. No se encontraron objetos en el repositorio.');
    return;
  }

  const objects = dataBusqueda._embedded.searchResult._embedded.objects;
  log(`✨ Se encontraron ${objects.length} posibles documentos. Procesando...`);

  let pdfsDescargados = 0;

  for (let i = 0; i < objects.length; i++) {
    if (pdfsDescargados >= limit) break;

    const itemData = objects[i]._embedded.indexableObject;
    const nombre = itemData.name;
    const itemUrl = objects[i]._links.indexableObject.href;

    // Verify handle
    let handleUrl = '';
    if (itemData.handle) {
      const parsedUrl = new URL(repoUrl);
      handleUrl = `${parsedUrl.protocol}//${parsedUrl.host}/handle/${itemData.handle}`;
    }

    if (handleUrl && downloadedHandles.has(handleUrl.toLowerCase().trim())) {
      log(`⏭️ Saltando "${nombre}" (Ya registrado en Google Sheets)`);
      continue;
    }

    log(`📄 Analizando: "${nombre}"`);

    // Fetch bundles
    try {
      let archivos = [];
      const urlBundles = `${itemUrl}/bundles`;
      const resBundles = await fetch(urlBundles, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });

      if (resBundles.ok) {
        const dataBundles = await resBundles.json();
        if (dataBundles._embedded && dataBundles._embedded.bundles) {
          const originalBundle = dataBundles._embedded.bundles.find(b => b.name === 'ORIGINAL');
          if (originalBundle && originalBundle._links && originalBundle._links.bitstreams) {
            const resBitstreams = await fetch(originalBundle._links.bitstreams.href, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });
            if (resBitstreams.ok) {
              const dataBitstreams = await resBitstreams.json();
              if (dataBitstreams._embedded && dataBitstreams._embedded.bitstreams) {
                archivos = dataBitstreams._embedded.bitstreams;
              }
            }
          }
        }
      }

      // Fallback
      if (archivos.length === 0) {
        const urlBitstreams = `${itemUrl}/bitstreams`;
        const resBitstreams = await fetch(urlBitstreams, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (resBitstreams.ok) {
          const dataBitstreams = await resBitstreams.json();
          if (dataBitstreams._embedded && dataBitstreams._embedded.bitstreams) {
            archivos = dataBitstreams._embedded.bitstreams;
          }
        }
      }

      if (archivos.length > 0) {
        const pdf = archivos.find(b => 
          (b.bundleName === "ORIGINAL") || 
          (b.format && b.format.includes("PDF")) || 
          (b.name && b.name.toLowerCase().endsWith(".pdf"))
        );

        if (pdf && pdf._links && pdf._links.content) {
          let rawUrl = pdf._links.content.href;
          let downloadUrl = rawUrl;
          if (!rawUrl.startsWith('http')) {
            const parsedUrl = new URL(repoUrl);
            downloadUrl = `${parsedUrl.protocol}//${parsedUrl.host}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
          }

          log(`⬇️ Descargando PDF: ${downloadUrl}`);
          const resDownload = await fetch(downloadUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
          });

          if (resDownload.ok) {
            const contentType = resDownload.headers.get('content-type') || '';
            if (contentType.toLowerCase().includes('text/html')) {
              log(`⚠️ El enlace retornó un documento HTML. Saltando.`);
              continue;
            }

            const buffer = await resDownload.arrayBuffer();
            const cleanName = sanitizeFilename(nombre);
            const finalFilename = `${cleanName}.pdf`;
            const finalPath = path.join(tempPath, finalFilename);

            fs.writeFileSync(finalPath, Buffer.from(buffer));
            pdfsDescargados++;

            let pdfUrl = '';
            if (pdf.uuid) {
              const parsedUrl = new URL(repoUrl);
              pdfUrl = `${parsedUrl.protocol}//${parsedUrl.host}/bitstreams/${pdf.uuid}/download`;
            } else {
              pdfUrl = downloadUrl;
            }

            log(`✅ Guardado localmente en VM.`);

            // Webhook upload
            if (sheetsWebhookUrl) {
              log(`📤 Subiendo registro y enviando a Google Drive...`);
              try {
                const base64Str = Buffer.from(buffer).toString('base64');
                const sheetResponse = await fetch(sheetsWebhookUrl.trim(), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    nombre: nombre,
                    handleUrl: handleUrl,
                    pdfUrl: pdfUrl,
                    estado: "PENDIENTE_ANALISIS",
                    localPath: finalPath,
                    fileBase64: base64Str,
                    driveFolderId: driveFolderId
                  })
                });

                if (sheetResponse.ok) {
                  const resultJson = await sheetResponse.json();
                  if (resultJson.success) {
                    log(`📝 Registrado exitosamente. Drive URL: ${resultJson.driveFileUrl || 'No generada'}`);
                  } else {
                    log(`⚠️ Error en Apps Script: ${resultJson.error}`);
                  }
                } else {
                  log(`⚠️ Webhook devolvió estado: ${sheetResponse.status}`);
                }
              } catch (sheetErr) {
                log(`⚠️ Falló envío a webhook: ${sheetErr.message}`);
              }
            }
          } else {
            log(`⚠️ Error al descargar el archivo de: "${nombre}"`);
          }
        } else {
          log(`ℹ️ Sin archivo PDF original adjunto para: "${nombre}"`);
        }
      } else {
        log(`ℹ️ Sin archivos adjuntos para: "${nombre}"`);
      }
    } catch (errInner) {
      log(`❌ Error procesando item: ${errInner.message}`);
    }
  }

  log(`🏁 Proceso completado. Se procesaron ${pdfsDescargados} descargas.`);
}

runCLI().catch(err => {
  log(`🚨 Error crítico: ${err.message}`);
  process.exit(1);
});
