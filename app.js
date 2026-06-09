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
document.getElementById('driveFolderId').value = "1cJu_a1m3BJvl16zgR8U1UJpGZg4D4d24";

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const repoUrl = document.getElementById('repoUrl').value;
  const keywords = document.getElementById('keywords').value;
  const folderPath = document.getElementById('folderPath').value;
  const limit = document.getElementById('limit').value;
  const sheetsWebhookUrl = document.getElementById('sheetsWebhookUrl').value;
  const driveFolderId = document.getElementById('driveFolderId').value;

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
      body: JSON.stringify({ repoUrl, keywords, folderPath, limit, sheetsWebhookUrl, driveFolderId })
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

