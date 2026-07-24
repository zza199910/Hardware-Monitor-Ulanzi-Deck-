// ===== Hardware Monitor Property Inspector =====
// Follows Ulanzi Plugin API pattern (same as demo/analogclock)
// Uses: $UD.sendParamFromPlugin() / $UD.onParamFromApp() / $UD.onAdd()

let ACTION_SETTING = {};
let form = '';
let currentPresetParams = {};
let pendingGpuId = ''; // 选项尚未加载完成时，暂存的 GPU 选择

// Connect to Ulanzi plugin
$UD.connect();

$UD.onConnected(conn => {
  console.log('[systemvitals.js] Connected to Ulanzi plugin');

  // Get form reference
  form = document.querySelector('#property-inspector');

  // Show the UI (remove 'hidden' class)
  const el = document.querySelector('.uspi-wrapper');
  el.classList.remove('hidden');

  // --- Chart Style ---
  const chartStyle = document.getElementById('chartStyle');
  if (chartStyle) {
    chartStyle.onchange = () => saveSettings();
  }

  // --- Preset dropdown ---
  const presetSelect = document.getElementById('presetSelect');
  if (presetSelect) {
    presetSelect.onchange = () => {
      const presetName = presetSelect.value;
      if (presetName) {
        applyPreset(presetName);
      }
    };
  }

  // --- GPU 选择下拉框（多 GPU 场景手动指定）---
  const gpuSelect = document.getElementById('gpuSelect');
  if (gpuSelect) {
    loadGpuOptions(gpuSelect); // 从 LHM 拉取 GPU 列表填充选项（失败则保留仅 Auto）
    gpuSelect.onchange = () => saveSettings();
  }

  // 配置由上位机通过 onAdd / onParamFromApp 自动恢复，无需手动 requestSettings
});

// 从 LHM HTTP API 拉取 GPU 列表，填充下拉框（失败则保留仅 Auto，离线降级）
async function loadGpuOptions(select) {
  try {
    const res = await fetch('http://127.0.0.1:8085/data.json', { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || !Array.isArray(data.Children)) return;
    const gpuNodes = [];
    const walk = (node) => {
      if (!node || !node.Children) return;
      for (const child of node.Children) {
        const hwId = (child.HardwareId || '').toLowerCase();
        if (hwId.startsWith('/gpu')) {
          gpuNodes.push({ hwId: child.HardwareId, text: child.Text || child.HardwareId });
        }
        walk(child);
      }
    };
    walk(data);
    const seen = new Set();
    for (const g of gpuNodes) {
      if (seen.has(g.hwId)) continue;
      seen.add(g.hwId);
      const opt = document.createElement('option');
      opt.value = g.hwId;
      opt.textContent = g.text;
      select.appendChild(opt);
    }
    // 若已有待恢复的选择，选项加载完成后回设
    if (pendingGpuId) {
      select.value = pendingGpuId;
      pendingGpuId = '';
    }
  } catch (e) {
    console.warn('[systemvitals.js] 加载 GPU 列表失败（离线降级，仅保留 Auto）:', e && e.message);
  }
}

// Receive settings from plugin (when action is added or selected)
$UD.onAdd(jsonObj => {
  console.log('[systemvitals.js] onAdd:', jsonObj);
  if (jsonObj && jsonObj.param) {
    settingSaveParam(jsonObj.param);
  }
});

$UD.onParamFromApp(jsonObj => {
  console.log('[systemvitals.js] onParamFromApp:', jsonObj);
  if (jsonObj && jsonObj.param) {
    settingSaveParam(jsonObj.param);
  }
});

// Save settings to plugin — chartStyle + currentPresetParams + preset name
function saveSettings() {
  if (!form) {
    console.warn('[systemvitals.js] saveSettings: form not ready');
    return;
  }

  const chartStyle = document.getElementById('chartStyle')?.value || 'ring';
  const presetName = document.getElementById('presetSelect')?.value || '';
  const gpuId = document.getElementById('gpuSelect')?.value || '';
  const settings = { chartStyle, preset: presetName, gpuId, ...currentPresetParams };

  ACTION_SETTING = settings;
  console.log('[systemvitals.js] saveSettings:', ACTION_SETTING);
  $UD.sendParamFromPlugin(ACTION_SETTING);
}

// ===== Preset Definitions (no title / no unit fields) =====
const presets = {
  minimal: {
    titleFontSize: 0, titleColor: '#ffffff', titleStroke: 0,
    valueFontSize: 48, valueColor: '#ffffff', valueStroke: 0,
    unitFontSize: 20, unitColor: '#aaaaaa',
    showProgress: false, showHistory: false,
  },
  gaming: {
    titleFontSize: 18, titleColor: '#ffffff', titleStroke: 0,
    valueFontSize: 48, valueColor: '#00ffcc', valueStroke: 0,
    unitFontSize: 20, unitColor: '#88ccff',
    showProgress: true, showHistory: true,
  },
  retro: {
    titleFontSize: 18, titleColor: '#ffaa00', titleStroke: 1,
    valueFontSize: 48, valueColor: '#ff6644', valueStroke: 2,
    unitFontSize: 20, unitColor: '#ffaa00',
    showProgress: true, showHistory: true,
  },
  cyberpunk: {
    titleFontSize: 18, titleColor: '#ff00ff', titleStroke: 0,
    valueFontSize: 48, valueColor: '#00ffff', valueStroke: 0,
    unitFontSize: 20, unitColor: '#ff00ff',
    showProgress: true, showHistory: true,
  },
};

// Apply preset configuration — visual params only, never touch chartStyle
function applyPreset(presetName) {
  console.log('[systemvitals.js] Applying preset:', presetName);
  const preset = presets[presetName];
  if (!preset) return;

  // 不再修改 chartStyle dropdown
  currentPresetParams = { ...preset };

  // 发送到插件：preset 名称 + 视觉参数（不含 chartStyle）
  const chartStyle = document.getElementById('chartStyle')?.value || 'ring';
  ACTION_SETTING = { chartStyle, preset: presetName, ...preset };
  console.log('[systemvitals.js] applyPreset send:', ACTION_SETTING);
  $UD.sendParamFromPlugin(ACTION_SETTING);
}

// Load settings into form — restore chartStyle, preset dropdown + rebuild currentPresetParams
function settingSaveParam(params) {
  console.log('[systemvitals.js] settingSaveParam:', params);
  ACTION_SETTING = params || {};

  // Restore chartStyle dropdown
  if (ACTION_SETTING.chartStyle !== undefined && document.getElementById('chartStyle')) {
    document.getElementById('chartStyle').value = ACTION_SETTING.chartStyle;
  }

  // Restore preset dropdown
  if (document.getElementById('presetSelect')) {
    document.getElementById('presetSelect').value = ACTION_SETTING.preset || 'gaming';
  }

  // Restore GPU selection（选项可能尚未加载完成，先暂存）
  const gpuSel = document.getElementById('gpuSelect');
  if (gpuSel && ACTION_SETTING.gpuId) {
    if (gpuSel.options.length > 1) {
      gpuSel.value = ACTION_SETTING.gpuId;
    } else {
      pendingGpuId = ACTION_SETTING.gpuId;
    }
  }

  // Rebuild currentPresetParams so saveSettings() sends complete config
  // 优先从 presetParams 恢复（旧格式兼容）
  if (ACTION_SETTING.presetParams) {
    currentPresetParams = { ...ACTION_SETTING.presetParams };
    console.log('[systemvitals.js] Restored currentPresetParams from presetParams:', currentPresetParams);
  } else {
    // 新格式：flat settings 提取视觉参数（排除 chartStyle, preset, presetParams, action）
    const { chartStyle, preset, presetParams, action, ...rest } = ACTION_SETTING;
    if (Object.keys(rest).length > 0) {
      currentPresetParams = rest;
      console.log('[systemvitals.js] Rebuilt currentPresetParams from flat settings:', currentPresetParams);
    }
  }
}
