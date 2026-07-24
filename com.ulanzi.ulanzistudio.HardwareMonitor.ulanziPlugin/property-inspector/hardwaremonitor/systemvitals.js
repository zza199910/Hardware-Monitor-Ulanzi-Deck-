// ===== Hardware Monitor Property Inspector =====
// Follows Ulanzi Plugin API pattern (same as demo/analogclock)
// Uses: $UD.sendParamFromPlugin() / $UD.onParamFromApp() / $UD.onAdd()

let ACTION_SETTING = {};
let form = '';
let currentPresetParams = {};

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

  // 配置由上位机通过 onAdd / onParamFromApp 自动恢复，无需手动 requestSettings
});

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
  const settings = { chartStyle, preset: presetName, ...currentPresetParams };

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
