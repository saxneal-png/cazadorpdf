import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3015;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve frontend files directly from root

// Global state
let huntState = {
  state: 'IDLE', // IDLE, RUNNING, FINISHED, STOPPED, ERROR
  logs: [],
  progress: {
    current: 0,
    limit: 0,
    totalFound: 0
  },
  downloaded: [],
  currentTask: null
};

function addLog(message) {
  const timestamp = new Date().toLocaleTimeString();
  const logMsg = `[${timestamp}] ${message}`;
  huntState.logs.push(logMsg);
  console.log(logMsg);
}

// Clean filenames for OS safety
function sanitizeFilename(name) {
  return name.replace(/[\\\/:*?"<>|]/g, "").substring(0, 80).trim();
}

app.get('/api/status', (req, res) => {
  res.json({
    state: huntState.state,
    logs: huntState.logs,
    progress: huntState.progress,
    downloaded: huntState.downloaded
  });
});

app.post('/api/stop', (req, res) => {
  if (huntState.state === 'RUNNING') {
    huntState.state = 'STOPPED';
    addLog('⏹️ Detención manual solicitada por el usuario.');
    res.json({ success: true, message: 'Deteniendo cazador...' });
  } else {
    res.json({ success: false, message: 'La aplicación no está corriendo.' });
  }
});

// Helper function to resolve sheet tab and Drive Folder based on dynamic classification or override
function getIngestionConfig(filename, source, userOverride) {
  let type = 'cultivos';

  if (userOverride === 'cultivos') {
    type = 'cultivos';
  } else if (userOverride === 'agrochemicals') {
    type = 'agrochemicals';
  } else {
    // Automatic classification based on source or filename keywords
    const nameLower = filename.toLowerCase();
    const sourceLower = (source || '').toLowerCase();

    if (sourceLower === 'sag') {
      type = 'agrochemicals';
    } else if (sourceLower === 'inia') {
      type = 'cultivos';
    } else {
      const agrochemicalKeywords = ['etiqueta', 'hds', 'plaguicida', 'autorizado', 'bayer', 'syngenta', 'basf', 'monsanto', 'fmc', 'insecticida', 'fungicida', 'herbicida', 'quimico', 'agroquimico'];
      const isAgrochemical = agrochemicalKeywords.some(keyword => nameLower.includes(keyword));
      if (isAgrochemical) {
        type = 'agrochemicals';
      } else {
        type = 'cultivos';
      }
    }
  }

  if (type === 'agrochemicals') {
    return {
      typeLabel: '🧪 Agroquímico',
      sheetName: 'Agroquimicos',
      driveFolderId: '1hYRp8ecYXLBGXTp4ooK7iNUK2fnGAAhv'
    };
  } else {
    return {
      typeLabel: '🌾 Cultivo',
      sheetName: 'Cultivo',
      driveFolderId: '1cJu_a1m3BJvl16zgR8U1UJpGZg4D4d24'
    };
  }
}

app.post('/api/test-connection', async (req, res) => {
  const { sheetsWebhookUrl, query } = req.body;

  if (!sheetsWebhookUrl || !sheetsWebhookUrl.trim()) {
    return res.status(400).json({ success: false, error: 'La URL del Webhook de Sheets es requerida.' });
  }

  try {
    const response = await fetch(sheetsWebhookUrl.trim(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    if (!response.ok) {
      return res.json({
        success: false,
        error: `El servidor de Google Sheets retornó código: ${response.status}`,
        sheetsConnected: false
      });
    }

    const data = await response.json();
    if (data.success && Array.isArray(data.handles)) {
      let matches = [];
      const searchWord = (query || '').trim().toLowerCase();

      if (searchWord) {
        matches = data.handles.filter(h => h && h.toLowerCase().includes(searchWord));
      }

      return res.json({
        success: true,
        sheetsConnected: true,
        totalRecords: data.handles.length,
        matches: matches
      });
    } else {
      return res.json({
        success: false,
        error: 'El webhook respondió pero el formato no contiene un listado de handles válido.',
        sheetsConnected: true
      });
    }
  } catch (err) {
    return res.json({
      success: false,
      error: `Error de conexión: ${err.message}`,
      sheetsConnected: false
    });
  }
});

app.post('/api/hunt', async (req, res) => {
  const { 
    searchSource, 
    sortOrder, 
    repoUrl, 
    keywords, 
    folderPath, 
    limit, 
    sheetsWebhookUrl, 
    driveFolderId, 
    sheetName,
    ingestionMode,
    scanMode,
    startPage,
    endPage
  } = req.body;

  if (huntState.state === 'RUNNING') {
    return res.status(400).json({ error: 'Ya hay una búsqueda en ejecución.' });
  }

  // Reset state
  huntState.state = 'RUNNING';
  huntState.logs = [];
  huntState.progress = { current: 0, limit: parseInt(limit) || 1, totalFound: 0 };
  huntState.downloaded = [];

  addLog(`🚀 Iniciando cazador de PDF...`);
  addLog(` Fuente: ${searchSource === 'sag' ? 'SAG (Agroquímicos)' : 'INIA (DSpace)'}`);
  addLog(`📍 Sitio / Repositorio: ${repoUrl}`);
  addLog(` Modo Ingesta: ${ingestionMode || 'auto'}`);
  if (searchSource === 'sag') {
    addLog(` Modo Escaneo SAG: ${scanMode || 'keyword'} (Páginas: ${startPage || 0} a ${endPage || 5})`);
  }
  addLog(` Orden: ${sortOrder || 'default'}`);
  addLog(`🔑 Palabras clave: ${keywords || '(Ninguna)'}`);
  addLog(`📁 Carpeta destino: ${folderPath}`);
  addLog(`🔢 Límite deseado: ${limit}`);
  if (sheetsWebhookUrl) {
    addLog(`📊 Webhook activo: Sí`);
  }

  // Respond immediately, execution will run asynchronously
  res.json({ success: true, message: 'Caza iniciada.' });

  // Run the crawler asynchronously
  if (searchSource === 'sag') {
    runSagHunter(repoUrl, keywords, folderPath, huntState.progress.limit, sheetsWebhookUrl, driveFolderId, sortOrder, sheetName, ingestionMode, scanMode, startPage, endPage);
  } else {
    runHunter(repoUrl, keywords, folderPath, huntState.progress.limit, sheetsWebhookUrl, driveFolderId, sortOrder, sheetName, ingestionMode);
  }
});

async function runHunter(repoUrl, keywords, folderPath, limit, sheetsWebhookUrl, driveFolderId, sortOrder, sheetName, ingestionMode) {
  try {
    // 0. Validate folder path
    const resolvedPath = path.resolve(folderPath.trim());
    if (!fs.existsSync(resolvedPath)) {
      addLog(`📁 La carpeta no existe, creándola: ${resolvedPath}`);
      fs.mkdirSync(resolvedPath, { recursive: true });
    }

    // Resolve API Base
    let apiBase = repoUrl.trim();
    if (!apiBase.endsWith('/')) apiBase += '/';
    
    // Automatically guess API if user just entered domain
    if (!apiBase.includes('/server/api') && !apiBase.includes('/api')) {
      apiBase += 'server/api/';
    }
    
    addLog(`🔍 Utilizando endpoint API: ${apiBase}`);

    // Sort parameters mapping for DSpace
    let sortParam = '';
    if (sortOrder === 'new') {
      sortParam = '&sort=dc.date.issued,DESC';
    } else if (sortOrder === 'old') {
      sortParam = '&sort=dc.date.issued,ASC';
    } else if (sortOrder === 'rel') {
      sortParam = '&sort=score,DESC';
    }

    // 1. Search endpoint
    const urlBusqueda = `${apiBase}discover/search/objects?query=${encodeURIComponent(keywords)}&size=40${sortParam}`;
    addLog(`📡 Realizando búsqueda en: ${urlBusqueda}`);

    const response = await fetch(urlBusqueda, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    if (!response.ok) {
      throw new Error(`Error de conexión con el repositorio: Código ${response.status}`);
    }

    const dataBusqueda = await response.json();

    if (!dataBusqueda._embedded || !dataBusqueda._embedded.searchResult || !dataBusqueda._embedded.searchResult._embedded) {
      huntState.state = 'FINISHED';
      addLog('❌ Sin resultados. No se encontraron objetos en el repositorio.');
      return;
    }

    // 1.5 Fetch already downloaded handles from Google Sheet (deduplication)
    let downloadedHandles = new Set();
    if (sheetsWebhookUrl && sheetsWebhookUrl.trim()) {
      addLog(`📡 Consultando documentos ya registrados en Google Sheets...`);
      try {
        const resSheet = await fetch(sheetsWebhookUrl.trim());
        if (resSheet.ok) {
          const sheetData = await resSheet.json();
          if (sheetData.success && Array.isArray(sheetData.handles)) {
            sheetData.handles.forEach(h => {
              if (h) downloadedHandles.add(h.toLowerCase().trim());
            });
            addLog(`📋 Se encontraron ${downloadedHandles.size} registros previos en Google Sheets.`);
          }
        }
      } catch (errSheet) {
        addLog(`⚠️ No se pudo obtener registros de duplicados de Google Sheets: ${errSheet.message}`);
      }
    }

    const objects = dataBusqueda._embedded.searchResult._embedded.objects;
    huntState.progress.totalFound = objects.length;
    addLog(`✨ Se encontraron ${objects.length} posibles documentos. Procesando...`);

    let pdfsDescargados = 0;

    for (let i = 0; i < objects.length; i++) {
      // Check for stop signal
      if (huntState.state === 'STOPPED') {
        return;
      }

      if (pdfsDescargados >= limit) {
        break;
      }

      const itemData = objects[i]._embedded.indexableObject;
      const nombre = itemData.name;
      const itemUrl = objects[i]._links.indexableObject.href;

      // Verify if item handle has already been downloaded
      let handleUrl = '';
      if (itemData.handle) {
        const parsedUrl = new URL(repoUrl);
        handleUrl = `${parsedUrl.protocol}//${parsedUrl.host}/handle/${itemData.handle}`;
      }

      if (handleUrl && downloadedHandles.has(handleUrl.toLowerCase().trim())) {
        addLog(`⏭️ Saltando "${nombre}" (Ya está registrado en Google Sheets)`);
        continue;
      }

      addLog(`📄 Analizando: "${nombre}"`);

      // 2. Fetch Bitstreams (files) for this item
      try {
        let archivos = [];
        // First try via bundles (DSpace 7 REST API standard)
        const urlBundles = `${itemUrl}/bundles`;
        const resBundles = await fetch(urlBundles, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        if (resBundles.ok) {
          const dataBundles = await resBundles.json();
          if (dataBundles._embedded && dataBundles._embedded.bundles) {
            // Find the ORIGINAL bundle
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

        // Fallback to direct /bitstreams if no files were found via bundles (DSpace 5/6 compatibility)
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
          // Look for a PDF file
          const pdf = archivos.find(b => 
            (b.bundleName === "ORIGINAL") || 
            (b.format && b.format.includes("PDF")) || 
            (b.name && b.name.toLowerCase().endsWith(".pdf"))
          );

          if (pdf && pdf._links && pdf._links.content) {
            let rawUrl = pdf._links.content.href;
            // Extract host from repoUrl if rawUrl is relative
            let downloadUrl = rawUrl;
            if (!rawUrl.startsWith('http')) {
              const parsedUrl = new URL(repoUrl);
              downloadUrl = `${parsedUrl.protocol}//${parsedUrl.host}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
            }

            addLog(`⬇️ Descargando PDF desde: ${downloadUrl}`);
            
            const resDownload = await fetch(downloadUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
            });

            if (resDownload.ok) {
              const contentType = resDownload.headers.get('content-type') || '';
              if (contentType.toLowerCase().includes('text/html')) {
                addLog(`⚠️ El enlace retornó un documento HTML en lugar de PDF. Saltando.`);
                continue;
              }

              const buffer = await resDownload.arrayBuffer();
              const cleanName = sanitizeFilename(nombre);
              const finalFilename = `${cleanName}.pdf`;
              const finalPath = path.join(resolvedPath, finalFilename);

              fs.writeFileSync(finalPath, Buffer.from(buffer));
              pdfsDescargados++;
              
              huntState.progress.current = pdfsDescargados;
              
              // Get handle link if available
              let handleUrl = '';
              let pdfUrl = '';
              const parsedUrl = new URL(repoUrl);
              
              if (itemData.handle) {
                handleUrl = `${parsedUrl.protocol}//${parsedUrl.host}/handle/${itemData.handle}`;
              }
              
              if (pdf.uuid) {
                pdfUrl = `${parsedUrl.protocol}//${parsedUrl.host}/bitstreams/${pdf.uuid}/download`;
              } else {
                pdfUrl = downloadUrl; // fallback
              }

              const itemInfo = {
                name: nombre,
                handleUrl: handleUrl,
                pdfUrl: pdfUrl,
                localPath: finalPath,
                date: new Date().toLocaleTimeString()
              };

              huntState.downloaded.push(itemInfo);
              addLog(`✅ Guardado con éxito: ${finalFilename}`);

              // Log to Google Sheet if webhook URL is provided
              if (sheetsWebhookUrl && sheetsWebhookUrl.trim()) {
                const ingestionConfig = getIngestionConfig(nombre, 'inia', ingestionMode);
                const targetSheet = ingestionConfig.sheetName;
                const targetDriveFolder = ingestionConfig.driveFolderId;
                
                addLog(`🏷️ Clasificación: ${ingestionConfig.typeLabel} -> Pestaña: ${targetSheet} | Carpeta Drive: ${targetDriveFolder}`);
                addLog(`📤 Enviando registro a Google Sheets y subiendo a Google Drive...`);
                try {
                  const base64Str = Buffer.from(buffer).toString('base64');
                  
                  const sheetResponse = await fetch(sheetsWebhookUrl.trim(), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      nombre: itemInfo.name,
                      handleUrl: itemInfo.handleUrl,
                      pdfUrl: itemInfo.pdfUrl,
                      estado: "PENDIENTE_ANALISIS",
                      localPath: itemInfo.localPath,
                      fileBase64: base64Str,
                      driveFolderId: targetDriveFolder,
                      nombreHoja: targetSheet,
                      hojaDestino: targetSheet
                    })
                  });

                  if (sheetResponse.ok) {
                    const resultJson = await sheetResponse.json();
                    if (resultJson.success) {
                      if (resultJson.driveFileUrl) {
                        addLog(`📝 Registrado en la hoja de cálculo. Guardado en Drive: ${resultJson.driveFileUrl}`);
                      } else {
                        addLog(`📝 Registrado exitosamente en la hoja de cálculo (local path guardado).`);
                      }
                    } else {
                      addLog(`⚠️ El script de Sheets reportó un error: ${resultJson.error || 'Error desconocido'}`);
                    }
                  } else {
                    addLog(`⚠️ El webhook de Google Sheets retornó código de estado: ${sheetResponse.status}`);
                  }
                } catch (sheetErr) {
                  addLog(`⚠️ Falló el envío al webhook de Google Sheets: ${sheetErr.message}`);
                }
              }
            } else {
              addLog(`⚠️ Error al descargar el archivo PDF de: "${nombre}"`);
            }
          } else {
            addLog(`ℹ️ No se encontró ningún archivo PDF original adjunto para: "${nombre}"`);
          }
        } else {
          addLog(`ℹ️ No se pudieron obtener los archivos adjuntos (bitstreams) para: "${nombre}"`);
        }
      } catch (errInner) {
        addLog(`❌ Error procesando el item "${nombre}": ${errInner.message}`);
      }
    }

    huntState.state = 'FINISHED';
    addLog(`🎉 Búsqueda finalizada. Descargados: ${pdfsDescargados} de ${limit}.`);
  } catch (error) {
    huntState.state = 'ERROR';
    addLog(`🚨 Error crítico: ${error.message}`);
  }
}

async function runSagHunter(repoUrl, keywords, folderPath, limit, sheetsWebhookUrl, driveFolderId, sortOrder, sheetName, ingestionMode, scanMode, startPage, endPage) {
  try {
    const resolvedPath = path.resolve(folderPath.trim());
    if (!fs.existsSync(resolvedPath)) {
      addLog(`📁 La carpeta no existe, creándola: ${resolvedPath}`);
      fs.mkdirSync(resolvedPath, { recursive: true });
    }

    addLog(`🚀 Iniciando rastreo de plaguicidas SAG...`);
    const searchWord = keywords && keywords.trim() ? keywords.trim() : "";
    addLog(`🔑 Búsqueda: ${searchWord || '(Sin palabras clave, listando todos los plaguicidas del índice)'}`);

    let siteBase = repoUrl ? repoUrl.trim() : "https://www.sag.gob.cl";
    let urlPublicaciones = siteBase;
    try {
      const parsedUrl = new URL(siteBase);
      siteBase = parsedUrl.origin;
      if (parsedUrl.pathname === '/' || parsedUrl.pathname === '') {
        urlPublicaciones = `${siteBase}/ambitos-de-accion/autorizacion-y-evaluacion-de-plaguicidas/publicaciones`;
      }
    } catch (e) {
      if (siteBase.endsWith('/')) siteBase = siteBase.slice(0, -1);
      if (!siteBase.includes('/ambitos-de-accion/')) {
        urlPublicaciones = `${siteBase}/ambitos-de-accion/autorizacion-y-evaluacion-de-plaguicidas/publicaciones`;
      }
    }
    if (searchWord && scanMode === 'keyword') {
      urlPublicaciones += `${urlPublicaciones.includes('?') ? '&' : '?'}title=${encodeURIComponent(searchWord)}`;
    }
    
    addLog(`📡 Escaneando índice de publicaciones en: ${urlPublicaciones}`);

    // Fetch already downloaded handles/URLs from Google Sheet (deduplication)
    let downloadedHandles = new Set();
    if (sheetsWebhookUrl && sheetsWebhookUrl.trim()) {
      addLog(`📡 Consultando documentos ya registrados en Google Sheets...`);
      try {
        const resSheet = await fetch(sheetsWebhookUrl.trim());
        if (resSheet.ok) {
          const sheetData = await resSheet.json();
          if (sheetData.success && Array.isArray(sheetData.handles)) {
            sheetData.handles.forEach(h => {
              if (h) downloadedHandles.add(h.toLowerCase().trim());
            });
            addLog(`📋 Se encontraron ${downloadedHandles.size} registros previos en Google Sheets.`);
          }
        }
      } catch (errSheet) {
        addLog(`⚠️ No se pudo obtener registros de duplicados de Google Sheets: ${errSheet.message}`);
      }
    }

    let page = 0;
    let maxPagesToScan = 15; // Default scan size
    
    const isRandom = scanMode === 'random' || searchWord.toLowerCase() === 'aleatorio' || searchWord.toLowerCase() === 'random';
    const isAll = scanMode === 'sequential' || !searchWord || searchWord.toLowerCase() === 'todos' || searchWord.toLowerCase() === 'all';

    if (isRandom) {
      const start = parseInt(startPage) || 0;
      const end = parseInt(endPage) || 80;
      page = Math.floor(Math.random() * (end - start + 1)) + start;
      maxPagesToScan = 5;
      addLog(`🎲 Modo aleatorio activado. Iniciando escaneo en página aleatoria: ${page} (Rango de búsqueda: ${start} - ${end})`);
    } else if (scanMode === 'sequential') {
      page = parseInt(startPage) || 0;
      const end = parseInt(endPage) || 5;
      maxPagesToScan = Math.max(1, end - page + 1);
      addLog(`🔢 Escaneo secuencial activado. Rango de páginas: de ${page} a ${end} (Máximo ${maxPagesToScan} páginas)`);
    }

    let matchedItems = [];
    let pagesScanned = 0;
    while (pagesScanned < maxPagesToScan) {
      let pageUrl = urlPublicaciones;
      pageUrl += `${pageUrl.includes('?') ? '&' : '?'}page=${page}`;

      addLog(`📡 Escaneando página ${page} del índice: ${pageUrl}`);
      
      const response = await fetch(pageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
      });

      if (!response.ok) {
        break;
      }

      const html = await response.text();
      const regex = /href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi;
      let matches = [...html.matchAll(regex)];

      if (matches.length === 0) {
        break; // Stop if page is empty or past last page
      }

      // Filter out standard static website PDFs
      const filteredMatches = matches.filter(m => {
        const url = m[1].toLowerCase();
        return !url.includes('etica_sag') && !url.includes('prevencion_de_delitos') && !url.includes('pcsyeu') && !url.includes('delitos_sag');
      });

      const termToMatch = (isRandom || isAll) ? '' : searchWord.toLowerCase().replace(/[^a-z0-9]/g, "");

      for (let i = 0; i < filteredMatches.length; i++) {
        let downloadUrl = filteredMatches[i][1].trim();
        let textoEnlace = filteredMatches[i][2].replace(/<[^>]*>/g, "").trim().toLowerCase();

        if (downloadUrl.startsWith("/")) {
          downloadUrl = siteBase + downloadUrl;
        }
        downloadUrl = downloadUrl.split('?')[0];

        const nombreArchivoOriginal = decodeURIComponent(downloadUrl.split('/').pop().toLowerCase());
        const textoLimpioEnlace = textoEnlace.replace(/[^a-z0-9]/g, "");
        const nombreLimpioArchivo = nombreArchivoOriginal.replace(/[^a-z0-9]/g, "");

        let isMatch = false;
        if (!termToMatch) {
          isMatch = true;
        } else {
          if (textoLimpioEnlace.includes(termToMatch) || nombreLimpioArchivo.includes(termToMatch)) {
            isMatch = true;
          }
        }

        if (isMatch) {
          let nombreVisual = filteredMatches[i][2].replace(/<[^>]*>/g, "").trim();
          if (!nombreVisual) nombreVisual = nombreArchivoOriginal.replace(".pdf", "");

          matchedItems.push({
            url: downloadUrl,
            name: nombreVisual,
            rawName: nombreArchivoOriginal
          });
        }
      }

      // Filter out duplicates by URL
      let uniqueMatchedItems = [];
      let seenUrls = new Set();
      for (let item of matchedItems) {
        if (!seenUrls.has(item.url)) {
          seenUrls.add(item.url);
          uniqueMatchedItems.push(item);
        }
      }

      if (uniqueMatchedItems.length >= limit) {
        matchedItems = uniqueMatchedItems;
        break;
      }

      page++;
      pagesScanned++;
    }

    // Clean duplicate matches by URL
    let uniqueMatchedItems = [];
    let seenUrls = new Set();
    for (let item of matchedItems) {
      if (!seenUrls.has(item.url)) {
        seenUrls.add(item.url);
        uniqueMatchedItems.push(item);
      }
    }

    if (uniqueMatchedItems.length === 0) {
      addLog('❌ Sin resultados. Ninguna publicación o archivo del índice coincidió con tu búsqueda.');
    }

    // Sort by date if requested
    const extractDateFromUrl = (url) => {
      const matchYearMonth = url.match(/\/(\d{4})[-_\/](\d{2})\//);
      if (matchYearMonth) {
        return new Date(parseInt(matchYearMonth[1]), parseInt(matchYearMonth[2]) - 1, 1);
      }
      const matchYear = url.match(/\/(\d{4})\//);
      if (matchYear) {
        return new Date(parseInt(matchYear[1]), 0, 1);
      }
      return null;
    };

    if (sortOrder === 'new') {
      addLog(`⏳ Ordenando: Más nuevos primero`);
      uniqueMatchedItems.sort((a, b) => (extractDateFromUrl(b.url) || new Date(0)) - (extractDateFromUrl(a.url) || new Date(0)));
    } else if (sortOrder === 'old') {
      addLog(`⏳ Ordenando: Más antiguos primero`);
      uniqueMatchedItems.sort((a, b) => (extractDateFromUrl(a.url) || new Date(8640000000000000)) - (extractDateFromUrl(b.url) || new Date(8640000000000000)));
    }

    addLog(`✨ Se encontraron ${uniqueMatchedItems.length} coincidencias. Procesando...`);
    huntState.progress.totalFound = uniqueMatchedItems.length;

    let pdfsDescargados = 0;

    for (let i = 0; i < uniqueMatchedItems.length; i++) {
      if (huntState.state === 'STOPPED') {
        return;
      }

      if (pdfsDescargados >= limit) {
        break;
      }

      const item = uniqueMatchedItems[i];
      const cleanName = sanitizeFilename(item.name);
      const finalFilename = `${cleanName}.pdf`;
      const finalPath = path.join(resolvedPath, finalFilename);

      if (downloadedHandles.has(item.url.toLowerCase().trim())) {
        addLog(`⏭️ Saltando "${finalFilename}" (Ya registrado en Google Sheets)`);
        continue;
      }

      if (fs.existsSync(finalPath)) {
        addLog(`⏭️ Saltando "${finalFilename}" (Ya existe localmente en la carpeta de descargas)`);
        continue;
      }

      addLog(`⬇ Descargando PDF SAG desde: ${item.url}`);

      try {
        const resDownload = await fetch(item.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        if (resDownload.ok) {
          const contentType = resDownload.headers.get('content-type') || '';
          if (contentType.toLowerCase().includes('text/html')) {
            addLog(`⚠️ El enlace retornó un documento HTML en lugar de PDF. Saltando.`);
            continue;
          }

          const buffer = await resDownload.arrayBuffer();
          fs.writeFileSync(finalPath, Buffer.from(buffer));
          pdfsDescargados++;

          huntState.progress.current = pdfsDescargados;

          const itemInfo = {
            name: item.name,
            handleUrl: item.url,
            pdfUrl: item.url,
            localPath: finalPath,
            date: new Date().toLocaleTimeString()
          };

          huntState.downloaded.push(itemInfo);
          addLog(`✅ Guardado con éxito: ${finalFilename}`);

          // Log to Google Sheet if webhook URL is provided
          if (sheetsWebhookUrl && sheetsWebhookUrl.trim()) {
            const ingestionConfig = getIngestionConfig(item.name, 'sag', ingestionMode);
            const targetSheet = ingestionConfig.sheetName;
            const targetDriveFolder = ingestionConfig.driveFolderId;

            addLog(`🏷️ Clasificación: ${ingestionConfig.typeLabel} -> Pestaña: ${targetSheet} | Carpeta Drive: ${targetDriveFolder}`);
            addLog(`📤 Enviando registro a Google Sheets y subiendo a Google Drive...`);
            try {
              const base64Str = Buffer.from(buffer).toString('base64');
              
              const sheetResponse = await fetch(sheetsWebhookUrl.trim(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  nombre: itemInfo.name,
                  handleUrl: itemInfo.handleUrl,
                  pdfUrl: itemInfo.pdfUrl,
                  estado: "PENDIENTE_ANALISIS",
                  localPath: itemInfo.localPath,
                  fileBase64: base64Str,
                  driveFolderId: targetDriveFolder,
                  nombreHoja: targetSheet,
                  hojaDestino: targetSheet
                })
              });

              if (sheetResponse.ok) {
                const resultJson = await sheetResponse.json();
                if (resultJson.success) {
                  if (resultJson.driveFileUrl) {
                    addLog(`📝 Registrado en la hoja de cálculo [${targetSheet}]. Guardado en Drive: ${resultJson.driveFileUrl}`);
                  } else {
                    addLog(`📝 Registrado exitosamente en la hoja de cálculo [${targetSheet}] (local path guardado).`);
                  }
                } else {
                  addLog(`⚠️ El script de Sheets reportó un error: ${resultJson.error || 'Error desconocido'}`);
                }
              } else {
                addLog(`⚠️ El webhook de Google Sheets retornó código de estado: ${sheetResponse.status}`);
              }
            } catch (sheetErr) {
              addLog(`⚠️ Falló el envío al webhook de Google Sheets: ${sheetErr.message}`);
            }
          }
        } else {
          addLog(`⚠️ Error al descargar el archivo PDF: "${item.name}"`);
        }
      } catch (errInner) {
        addLog(`❌ Error procesando el archivo "${item.name}": ${errInner.message}`);
      }
    }

    // Fallback: Si no se descargó nada y hay palabra clave, descarga listas maestras consolidadas
    if (pdfsDescargados === 0 && searchWord) {
      addLog("🔍 Buscando en repositorio alternativo de listas consolidadas...");
      const intentosAlternativos = [
        { url: `${siteBase}/sites/default/files/lista_plaguicidas_autorizados.pdf`, nombre: "Lista Plaguicidas Autorizados" },
        { url: `${siteBase}/sites/default/files/lista_plaguicidas_apt.pdf`, nombre: "Lista Plaguicidas Insumos" }
      ];

      for (let alt of intentosAlternativos) {
        if (pdfsDescargados >= limit) break;

        const cleanName = sanitizeFilename(alt.nombre);
        const finalFilename = `${cleanName}.pdf`;
        const finalPath = path.join(resolvedPath, finalFilename);

        if (downloadedHandles.has(alt.url.toLowerCase().trim())) {
          continue;
        }
        if (fs.existsSync(finalPath)) {
          continue;
        }

        addLog(`⬇ Descargando listado maestro alternativo SAG desde: ${alt.url}`);
        try {
          const resDownload = await fetch(alt.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
          });

          if (resDownload.ok) {
            const buffer = await resDownload.arrayBuffer();
            fs.writeFileSync(finalPath, Buffer.from(buffer));
            pdfsDescargados++;

            huntState.progress.current = pdfsDescargados;

            const itemInfo = {
              name: alt.nombre,
              handleUrl: alt.url,
              pdfUrl: alt.url,
              localPath: finalPath,
              date: new Date().toLocaleTimeString()
            };

            huntState.downloaded.push(itemInfo);
            addLog(`✅ Guardado listado consolidado SAG: ${alt.nombre}`);

            if (sheetsWebhookUrl && sheetsWebhookUrl.trim()) {
              try {
                const ingestionConfig = getIngestionConfig(alt.nombre, 'sag', ingestionMode);
                const targetSheet = ingestionConfig.sheetName;
                const targetDriveFolder = ingestionConfig.driveFolderId;
                const base64Str = Buffer.from(buffer).toString('base64');
                await fetch(sheetsWebhookUrl.trim(), {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    nombre: itemInfo.name,
                    handleUrl: itemInfo.handleUrl,
                    pdfUrl: itemInfo.pdfUrl,
                    estado: "PENDIENTE_ANALISIS",
                    localPath: itemInfo.localPath,
                    fileBase64: base64Str,
                    driveFolderId: targetDriveFolder,
                    nombreHoja: targetSheet,
                    hojaDestino: targetSheet
                  })
                });
              } catch (e) {}
            }
          }
        } catch (errAlt) {
          // Silent skip
        }
      }
    }

    huntState.state = 'FINISHED';
    addLog(`🎉 Búsqueda SAG finalizada. Descargados: ${pdfsDescargados} de ${limit}.`);
  } catch (error) {
    huntState.state = 'ERROR';
    addLog(`🚨 Error crítico en SAG: ${error.message}`);
  }
}

// Scheduling global state
let activeSchedules = [];

app.get('/api/schedules', (req, res) => {
  // Map and return schedules without the internal timer objects
  res.json(activeSchedules.map(s => ({
    id: s.id,
    region: s.region,
    crops: s.crops,
    frequency: s.frequency,
    limit: s.limit,
    nextRun: s.nextRun,
    repoUrl: s.repoUrl,
    folderPath: s.folderPath
  })));
});

app.post('/api/cancel-schedule', (req, res) => {
  const { id } = req.body;
  const idx = activeSchedules.findIndex(s => s.id === id);
  if (idx !== -1) {
    const s = activeSchedules[idx];
    if (s.timerId) {
      clearInterval(s.timerId);
    }
    addLog(`📅 [PROGRAMADOR] Cancelado programa para región: ${s.region}`);
    activeSchedules.splice(idx, 1);
    res.json({ success: true, message: 'Programa cancelado.' });
  } else {
    res.status(404).json({ error: 'Programa no encontrado.' });
  }
});

app.post('/api/schedule', async (req, res) => {
  const { region, crops, frequency, limit, repoUrl, folderPath, sheetsWebhookUrl, driveFolderId } = req.body;

  if (!region || !crops || !Array.isArray(crops) || crops.length === 0) {
    return res.status(400).json({ error: 'Parámetros de programación inválidos.' });
  }

  const freqHours = parseFloat(frequency) || 0;
  const itemLimit = parseInt(limit) || 5;
  const id = Date.now().toString();

  const newSchedule = {
    id,
    region,
    crops,
    frequency: freqHours,
    limit: itemLimit,
    repoUrl: repoUrl || 'https://biblioteca.inia.cl',
    folderPath: folderPath || 'C:\\Users\\DionicioFelipeFlores\\Downloads\\CazadorDescargas',
    sheetsWebhookUrl,
    driveFolderId,
    nextRun: freqHours > 0 ? new Date(Date.now() + freqHours * 60 * 60 * 1000).toLocaleString() : 'Ejecutando una vez...'
  };

  addLog(`📅 [PROGRAMADOR] Nuevo programa creado para ${region}. Frecuencia: ${freqHours} hrs.`);

  if (freqHours > 0) {
    // Setup interval
    newSchedule.timerId = setInterval(() => {
      runScheduledSequence(newSchedule);
    }, freqHours * 60 * 60 * 1000);
    
    activeSchedules.push(newSchedule);
    res.json({ success: true, message: 'Programa activado.', schedule: newSchedule });
  } else {
    // Run once immediately (asynchronous)
    res.json({ success: true, message: 'Ejecutando secuencia regional ahora mismo.' });
    runScheduledSequence(newSchedule);
  }
});

async function runScheduledSequence(schedule) {
  if (huntState.state === 'RUNNING') {
    addLog(`📅 [PROGRAMADOR] Advertencia: Intentando correr programa regional, pero el cazador está ocupado. Reintentando en 5 minutos.`);
    setTimeout(() => runScheduledSequence(schedule), 5 * 60 * 1000);
    return;
  }

  addLog(`📅 [PROGRAMA ACTIVO] Iniciando secuencia programada para la región: ${schedule.region}`);
  
  // Set global huntState status to running
  huntState.state = 'RUNNING';
  huntState.logs = [];
  huntState.progress = { current: 0, limit: schedule.limit * schedule.crops.length, totalFound: 0 };
  huntState.downloaded = [];

  for (let i = 0; i < schedule.crops.length; i++) {
    if (huntState.state === 'STOPPED') {
      addLog(`⏹️ [PROGRAMA ACTIVO] Secuencia abortada manualmente.`);
      break;
    }
    const crop = schedule.crops[i];
    addLog(`🔍 [PROGRAMA ACTIVO] Rastreando cultivo (${i + 1}/${schedule.crops.length}): "${crop}"`);
    try {
      await runHunter(schedule.repoUrl, crop, schedule.folderPath, schedule.limit, schedule.sheetsWebhookUrl, schedule.driveFolderId);
    } catch (err) {
      addLog(`❌ [PROGRAMA ACTIVO] Error rastreando "${crop}": ${err.message}`);
    }
  }

  huntState.state = 'FINISHED';
  if (schedule.frequency > 0) {
    schedule.nextRun = new Date(Date.now() + schedule.frequency * 60 * 60 * 1000).toLocaleString();
    addLog(`📅 [PROGRAMA ACTIVO] Secuencia completada. Siguiente corrida: ${schedule.nextRun}`);
  } else {
    addLog(`🏁 [PROGRAMA ACTIVO] Secuencia única completada.`);
  }
}

app.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
