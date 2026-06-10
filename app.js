// Frontend logic for Cazador de PDF

const form = document.getElementById('hunt-form');
const btnHunt = document.getElementById('btn-hunt');
const btnStop = document.getElementById('btn-stop');
const indicatorDot = document.getElementById('indicator-dot');
const stateText = document.getElementById('state-text');
const statDownloaded = document.getElementById('stat-downloaded');
const statFound = document.getElementById('stat-found');
const progressBarFill = document.getElementById('progress-bar-fill');
const terminalLogs = document.getElementById('terminal-logs');
const resultsGrid = document.getElementById('results-grid');
const noResultsMsg = document.getElementById('no-results-msg');

let pollingInterval = null;
let lastLogCount = 0;
let lastDownloadedCount = 0;

// Set default downloads folder based on typical Windows structure if possible
document.getElementById('folderPath').value = "C:\\Users\\DionicioFelipeFlores\\Downloads\\CazadorDescargas";
document.getElementById('sheetsWebhookUrl').value = "https://script.google.com/macros/s/AKfycbxeXWq7oBNhXLW2NfypoJzpA8m9OB585401f-htF_uZHxEMTf4ZU_E43BTCNZbtJg_RHA/exec";
document.getElementById('driveFolderId').value = "1hYRp8ecYXLBGXTp4ooK7iNUK2fnGAAhv";

const searchSourceSelect = document.getElementById('searchSource');
const sortOrderSelect = document.getElementById('sortOrder');
const repoUrlInput = document.getElementById('repoUrl');
const repoUrlContainer = document.getElementById('repoUrl-container');
const sheetNameInput = document.getElementById('sheetName');

// Handle UI reactivity when changing search source
const sagScanConfigDiv = document.getElementById('sag-scan-config');
const scanModeSelect = document.getElementById('scanMode');
const pageRangeGroup = document.querySelector('.page-range-group');

searchSourceSelect.addEventListener('change', () => {
  if (searchSourceSelect.value === 'sag') {
    sheetNameInput.value = 'Agroquimicos';
    repoUrlInput.value = 'https://www.sag.gob.cl';
    sagScanConfigDiv.style.display = 'flex';
  } else {
    sheetNameInput.value = 'Cultivo';
    repoUrlInput.value = 'https://biblioteca.inia.cl';
    sagScanConfigDiv.style.display = 'none';
  }
});

scanModeSelect.addEventListener('change', () => {
  if (scanModeSelect.value === 'sequential' || scanModeSelect.value === 'random') {
    pageRangeGroup.style.display = 'block';
  } else {
    pageRangeGroup.style.display = 'none';
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const searchSource = searchSourceSelect.value;
  const sortOrder = sortOrderSelect.value;
  const repoUrl = repoUrlInput.value;
  const keywords = document.getElementById('keywords').value;
  const folderPath = document.getElementById('folderPath').value;
  const limit = document.getElementById('limit').value;
  const sheetsWebhookUrl = document.getElementById('sheetsWebhookUrl').value;
  const driveFolderId = document.getElementById('driveFolderId').value;
  const sheetName = sheetNameInput.value;

  const ingestionMode = document.getElementById('ingestionMode').value;
  const scanMode = scanModeSelect.value;
  const startPage = document.getElementById('startPage').value;
  const endPage = document.getElementById('endPage').value;

  // Disable Hunt, Enable Stop
  btnHunt.disabled = true;
  btnStop.disabled = false;
  
  // Clear lists
  resultsGrid.innerHTML = '';
  terminalLogs.innerHTML = '';
  lastLogCount = 0;
  lastDownloadedCount = 0;

  try {
    const response = await fetch('/api/hunt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
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
      })
    });

    const data = await response.json();
    if (!response.ok) {
      addLocalLog(`🚨 Error al iniciar caza: ${data.error || 'Error desconocido'}`, 'error');
      resetButtons();
      return;
    }

    addLocalLog('🚀 Conexión con backend establecida. Iniciando secuencia...', 'system');
    
    // Start polling
    startPolling();
  } catch (err) {
    addLocalLog(`🚨 Error de red: No se pudo conectar al servidor local.`, 'error');
    resetButtons();
  }
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  try {
    const response = await fetch('/api/stop', { method: 'POST' });
    const data = await response.json();
    addLocalLog(`⏹️ Solicitando detención: ${data.message}`, 'warn');
  } catch (err) {
    addLocalLog(`🚨 Error de conexión al detener.`, 'error');
  }
});

// --- DIAGNOSTIC AND DATABASE QUERY INTERFACE ---
const btnTestDb = document.getElementById('btn-test-db');
const btnSearchDb = document.getElementById('btn-search-db');
const dbStatusBadge = document.getElementById('db-status-badge');
const dbSearchInput = document.getElementById('db-search-input');
const dbResultsContainer = document.getElementById('db-results-container');

btnTestDb.addEventListener('click', async () => {
  const sheetsWebhookUrl = document.getElementById('sheetsWebhookUrl').value;
  if (!sheetsWebhookUrl) {
    alert('Por favor ingrese la URL del Webhook de Sheets.');
    return;
  }
  
  btnTestDb.disabled = true;
  dbStatusBadge.textContent = 'Verificando...';
  dbStatusBadge.className = 'db-status-badge idle';
  dbResultsContainer.innerHTML = '<p class="db-helper-text">Estableciendo conexión con Google Sheets...</p>';
  
  try {
    const response = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetsWebhookUrl })
    });
    const data = await response.json();
    if (data.success) {
      dbStatusBadge.textContent = 'CONECTADO ✅';
      dbStatusBadge.className = 'db-status-badge success';
      dbResultsContainer.innerHTML = `
        <div style="color: var(--accent-green); margin-bottom: 0.5rem; font-weight: 600;">
          ¡Conexión Exitosa con Google Sheets!
        </div>
        <p>Se encontraron <strong>${data.totalRecords}</strong> registros almacenados en total.</p>
        <p>La base de datos está activa y lista para la deduplicación.</p>
      `;
    } else {
      dbStatusBadge.textContent = 'ERROR ❌';
      dbStatusBadge.className = 'db-status-badge error';
      dbResultsContainer.innerHTML = `
        <div style="color: var(--accent-red); margin-bottom: 0.5rem; font-weight: 600;">
          Error al conectar:
        </div>
        <p>${data.error || 'Error desconocido'}</p>
      `;
    }
  } catch (err) {
    dbStatusBadge.textContent = 'ERROR ❌';
    dbStatusBadge.className = 'db-status-badge error';
    dbResultsContainer.innerHTML = `<p style="color: var(--accent-red)">Error de red local: ${err.message}</p>`;
  } finally {
    btnTestDb.disabled = false;
  }
});

btnSearchDb.addEventListener('click', async () => {
  const sheetsWebhookUrl = document.getElementById('sheetsWebhookUrl').value;
  const query = dbSearchInput.value.trim();
  
  if (!sheetsWebhookUrl) {
    alert('Por favor ingrese la URL del Webhook de Sheets.');
    return;
  }
  if (!query) {
    alert('Por favor ingrese un término de búsqueda para consultar.');
    return;
  }
  
  btnSearchDb.disabled = true;
  dbResultsContainer.innerHTML = '<p class="db-helper-text">Buscando coincidencias en Google Sheets...</p>';
  
  try {
    const response = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetsWebhookUrl, query })
    });
    const data = await response.json();
    if (data.success) {
      if (data.matches && data.matches.length > 0) {
        dbResultsContainer.innerHTML = `
          <div style="margin-bottom: 0.5rem; font-weight: 600; color: var(--accent-cyan);">
            Se encontraron ${data.matches.length} coincidencias en la base de datos:
          </div>
        `;
        data.matches.forEach(match => {
          const itemDiv = document.createElement('div');
          itemDiv.className = 'db-match-item';
          
          const isAgrochemical = match.toLowerCase().includes('sag.gob.cl') || match.toLowerCase().includes('etiqueta') || match.toLowerCase().includes('hds');
          const typeClass = isAgrochemical ? 'agrochemicals' : 'cultivos';
          const typeLabel = isAgrochemical ? '🧪 Agroquímico' : '🌾 Cultivo';
          
          itemDiv.innerHTML = `
            <a href="${match}" target="_blank" class="db-match-link" title="${match}">${match}</a>
            <span class="db-match-type ${typeClass}">${typeLabel}</span>
          `;
          dbResultsContainer.appendChild(itemDiv);
        });
      } else {
        dbResultsContainer.innerHTML = `
          <p style="color: var(--text-muted); text-align: center; margin: 1rem 0;">
            No se encontraron registros que coincidan con "${query}". El archivo está libre para descarga.
          </p>
        `;
      }
    } else {
      dbResultsContainer.innerHTML = `<p style="color: var(--accent-red)">Error al consultar base de datos: ${data.error}</p>`;
    }
  } catch (err) {
    dbResultsContainer.innerHTML = `<p style="color: var(--accent-red)">Error de red al consultar: ${err.message}</p>`;
  } finally {
    btnSearchDb.disabled = false;
  }
});


function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  
  pollingInterval = setInterval(updateStatus, 1000);
  updateStatus(); // Immediate first call
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

async function updateStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) return;

    const data = await response.json();

    // Update state badge
    stateText.textContent = data.state;
    indicatorDot.className = 'indicator-dot ' + data.state.toLowerCase();

    // Update stats
    const limit = data.progress.limit || 1;
    const current = data.progress.current || 0;
    statDownloaded.textContent = `${current} / ${limit}`;
    statFound.textContent = data.progress.totalFound || 0;

    // Update progress bar
    const progressPercent = Math.min((current / limit) * 100, 100);
    progressBarFill.style.width = `${progressPercent}%`;

    // Process new logs
    if (data.logs.length > lastLogCount) {
      for (let i = lastLogCount; i < data.logs.length; i++) {
        renderLogLine(data.logs[i]);
      }
      lastLogCount = data.logs.length;
      terminalLogs.scrollTop = terminalLogs.scrollHeight;
    }

    // Process new downloads
    if (data.downloaded.length > lastDownloadedCount) {
      if (lastDownloadedCount === 0) {
        // Clear empty state
        resultsGrid.innerHTML = '';
      }
      
      for (let i = lastDownloadedCount; i < data.downloaded.length; i++) {
        renderDownloadCard(data.downloaded[i]);
      }
      lastDownloadedCount = data.downloaded.length;
    }

    // Check if finished or stopped
    if (data.state !== 'RUNNING') {
      stopPolling();
      resetButtons();
      
      if (data.state === 'FINISHED') {
        addLocalLog('🏁 Secuencia terminada con éxito.', 'success');
      } else if (data.state === 'STOPPED') {
        addLocalLog('⏹️ Secuencia detenida por el usuario.', 'warn');
      } else if (data.state === 'ERROR') {
        addLocalLog('🚨 Búsqueda finalizada con errores.', 'error');
      }
    }
  } catch (err) {
    console.error('Error polling status:', err);
  }
}

function resetButtons() {
  btnHunt.disabled = false;
  btnStop.disabled = true;
}

function addLocalLog(message, type = '') {
  const timestamp = new Date().toLocaleTimeString();
  renderLogLine(`[${timestamp}] ${message}`, type);
  terminalLogs.scrollTop = terminalLogs.scrollHeight;
}

function renderLogLine(logStr, forceType = '') {
  const line = document.createElement('div');
  line.textContent = logStr;

  if (forceType) {
    line.className = `${forceType}-line`;
  } else {
    // Infer type from content
    if (logStr.includes('✅') || logStr.includes('éxito') || logStr.includes('finalizada') || logStr.includes('terminada')) {
      line.className = 'success-line';
    } else if (logStr.includes('🚨') || logStr.includes('Error') || logStr.includes('❌')) {
      line.className = 'error-line';
    } else if (logStr.includes('⚠️') || logStr.includes('detención') || logStr.includes('STOPPED') || logStr.includes('Deteniendo')) {
      line.className = 'warn-line';
    } else if (logStr.includes('🚀') || logStr.includes('📡') || logStr.includes('🔍')) {
      line.className = 'system-line';
    }
  }

  terminalLogs.appendChild(line);
}

function renderDownloadCard(file) {
  const card = document.createElement('div');
  card.className = 'result-card';

  // Extract folder name and short display path
  const handleHtml = file.handleUrl 
    ? `<a href="${file.handleUrl}" target="_blank" class="card-link">🔗 Ver en Repositorio (Resumen)</a>`
    : `<span class="card-link" style="color: var(--text-muted)">🔗 Handle no disponible</span>`;

  const pdfHtml = file.pdfUrl
    ? `<a href="${file.pdfUrl}" target="_blank" class="card-link" style="color: var(--accent-green)">📄 Descargar PDF Directo</a>`
    : ``;

  card.innerHTML = `
    <div class="card-header">
      <span class="card-title" title="${file.name}">${file.name}</span>
      <span class="card-time">Cazado a las: ${file.date}</span>
    </div>
    <div class="card-links">
      ${pdfHtml}
      ${handleHtml}
      <div class="card-path" title="${file.localPath}">
        📁 ${file.localPath}
      </div>
    </div>
  `;

  resultsGrid.appendChild(card);
}

// --- REGIONAL SCHEDULING INTERFACE ---

const REGIONES_CULTIVOS = {
  "Arica y Parinacota": ["Tomate", "Olivo", "Orégano", "Cítricos"],
  "Tarapacá": ["Alfalfa", "Limón de Pica", "Ajo", "Hortalizas"],
  "Antofagasta": ["Maíz", "Hortalizas", "Papas", "Alfalfa"],
  "Atacama": ["Uva de mesa", "Olivos", "Granados", "Hortalizas"],
  "Coquimbo": ["Uvas", "Paltos", "Cítricos", "Papayas", "Hortalizas"],
  "Valparaíso": ["Paltos", "Cítricos", "Nogales", "Uva de mesa"],
  "Metropolitana": ["Nogales", "Duraznos", "Uvas", "Papas", "Hortalizas"],
  "O'Higgins": ["Manzanos", "Uvas de mesa", "Cerezos", "Ciruelos", "Paltos"],
  "Maule": ["Manzanos", "Cerezos", "Arándanos", "Viñedos", "Arroz", "Papas"],
  "Ñuble": ["Arándanos", "Frambuesas", "Trigo", "Remolacha", "Papas"],
  "Biobío": ["Trigo", "Avena", "Arándanos", "Remolacha"],
  "La Araucanía": ["Trigo", "Avena", "Raps", "Papas", "Avellano europeo"],
  "Los Ríos": ["Trigo", "Papas", "Arándanos", "Praderas"],
  "Los Lagos": ["Papas", "Praderas", "Trigo"],
  "Aysén": ["Praderas", "Hortalizas", "Cerezas"],
  "Magallanes": ["Praderas", "Hortalizas"]
};

// Tab Switcher
const tabBtnManual = document.getElementById('tab-btn-manual');
const tabBtnRegional = document.getElementById('tab-btn-regional');
const tabManual = document.getElementById('tab-manual');
const tabRegional = document.getElementById('tab-regional');

tabBtnManual.addEventListener('click', () => {
  tabBtnManual.classList.add('active');
  tabBtnRegional.classList.remove('active');
  tabManual.style.display = 'block';
  tabRegional.style.display = 'none';
});

tabBtnRegional.addEventListener('click', () => {
  tabBtnRegional.classList.add('active');
  tabBtnManual.classList.remove('active');
  tabManual.style.display = 'none';
  tabRegional.style.display = 'block';
  loadSchedules(); // load list when tab opens
});

// Load crops checkbox list dynamically based on chosen region
const scheduleRegionSelect = document.getElementById('scheduleRegion');
const regionCropsList = document.getElementById('region-crops-list');

function populateCropsForSelectedRegion() {
  const region = scheduleRegionSelect.value;
  const crops = REGIONES_CULTIVOS[region] || [];
  
  regionCropsList.innerHTML = '';
  crops.forEach(crop => {
    const label = document.createElement('label');
    label.className = 'crop-checkbox-item';
    label.innerHTML = `<input type="checkbox" name="crops" value="cultivo ${crop.toLowerCase()}" checked> ${crop}`;
    regionCropsList.appendChild(label);
  });
}

scheduleRegionSelect.addEventListener('change', populateCropsForSelectedRegion);
populateCropsForSelectedRegion(); // Init on load

// Submitting regional schedules
const scheduleForm = document.getElementById('schedule-form');
const activeSchedulesList = document.getElementById('active-schedules-list');

scheduleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const region = scheduleRegionSelect.value;
  const frequency = document.getElementById('scheduleFrequency').value;
  const limit = document.getElementById('scheduleLimit').value;
  
  // Get all checked crops
  const checkedBoxes = document.querySelectorAll('input[name="crops"]:checked');
  const crops = Array.from(checkedBoxes).map(cb => cb.value);

  if (crops.length === 0) {
    alert('Debe seleccionar al menos un cultivo.');
    return;
  }

  // Use same configurations from manual form for Drive and Sheets
  const repoUrl = document.getElementById('repoUrl').value;
  const folderPath = document.getElementById('folderPath').value;
  const sheetsWebhookUrl = document.getElementById('sheetsWebhookUrl').value;
  const driveFolderId = document.getElementById('driveFolderId').value;

  try {
    const response = await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        region,
        crops,
        frequency,
        limit,
        repoUrl,
        folderPath,
        sheetsWebhookUrl,
        driveFolderId
      })
    });

    const data = await response.json();
    if (response.ok) {
      if (frequency === "0") {
        addLocalLog(`📅 Secuencia programada única activada para la región: ${region}`, 'system');
        // Switch view back to console to watch execution
        startPolling();
      } else {
        addLocalLog(`📅 Secuencia programada periódica activada para ${region} cada ${frequency} horas.`, 'success');
        loadSchedules();
      }
    } else {
      alert('Error al programar: ' + (data.error || 'Error desconocido'));
    }
  } catch (err) {
    console.error(err);
    alert('Error al conectar con el servidor.');
  }
});

// Load Active Schedules
async function loadSchedules() {
  try {
    const response = await fetch('/api/schedules');
    if (!response.ok) return;
    const list = await response.json();

    if (list.length === 0) {
      activeSchedulesList.innerHTML = `<p class="empty-schedules-msg">No hay programaciones periódicas activas.</p>`;
      return;
    }

    activeSchedulesList.innerHTML = '';
    list.forEach(item => {
      const card = document.createElement('div');
      card.className = 'schedule-card';
      
      // Clean display of crops
      const cropsLabel = item.crops.map(c => c.replace('cultivo ', '')).join(', ');

      card.innerHTML = `
        <div class="schedule-info">
          <div class="schedule-title">${item.region}</div>
          <div class="schedule-meta">🌾 Cultivos: ${cropsLabel}</div>
          <div class="schedule-meta">⏳ Frecuencia: Cada ${item.frequency} hrs. (Siguiente corrida: ${item.nextRun})</div>
        </div>
        <button class="btn-cancel-schedule" onclick="cancelSchedule('${item.id}')">Cancelar</button>
      `;
      activeSchedulesList.appendChild(card);
    });
  } catch (err) {
    console.error('Error fetching schedules:', err);
  }
}

// Global scope cancel function so inline onclick works
window.cancelSchedule = async function(id) {
  if (!confirm('¿Seguro que deseas cancelar este programa automático?')) return;
  try {
    const response = await fetch('/api/cancel-schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (response.ok) {
      addLocalLog(`📅 Programa cancelado con éxito.`, 'warn');
      loadSchedules();
    }
  } catch (err) {
    console.error(err);
  }
};

// Initial UI check on startup to restore session status if page is refreshed while running
updateStatus();
loadSchedules();
setInterval(loadSchedules, 10000); // Poll schedules list every 10 seconds

