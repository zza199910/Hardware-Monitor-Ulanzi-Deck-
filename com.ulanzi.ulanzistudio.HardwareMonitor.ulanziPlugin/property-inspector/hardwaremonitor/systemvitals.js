// ===== Hardware Monitor Property Inspector =====
// Follows Ulanzi Plugin API pattern (same as demo/analogclock)
// Uses: $UD.sendParamFromPlugin() / $UD.onParamFromApp() / $UD.onAdd()

let ACTION_SETTING = {};
let form = '';
let currentPresetParams = {};
let pendingSelectValue = ''; // 硬件下拉选项尚未加载完成时，暂存待回设的选择值

// Connect to Ulanzi plugin
$UD.connect();

// ── 当前控件类型（取自 uuid 末段，决定显示哪些设置项）──────────────────────
// 14 个 Action 共用同一个设置页，但并非所有设置项都适用，故按类型【显隐分区】，
// 而不是复制 14 份设置页（维护成本高、容易漂移）。
//
// 注意：控件类型必须从 uuid 取，不能用 actionid ——
// actionid 是上位机为每个按键实例生成的运行时 id（模拟器里形如 "A1"），与控件类型无关；
// uuid 才是形如 com.ulanzi.ulanzistudio.HardwareMonitor.network-down 的 Action UUID。
const KNOWN_MONITOR_TYPES = [
  'cpu-temp', 'gpu-temp', 'cpu-percent', 'gpu-percent', 'ram-percent',
  'cpu-power', 'gpu-power', 'cpu-clock', 'gpu-clock', 'gpu-mem', 'ram-gb',
  'fan', 'network-up', 'network-down',
];
const UUID_TAIL = (($UD.uuid || '').split('.').pop() || '');
const MONITOR_TYPE = (KNOWN_MONITOR_TYPES.indexOf(UUID_TAIL) >= 0) ? UUID_TAIL : '';
const ACTION_ID = $UD.actionid || '';
const IS_NET_TYPE = (MONITOR_TYPE === 'network-up' || MONITOR_TYPE === 'network-down');
const NET_MAX_KEY = (MONITOR_TYPE === 'network-up') ? 'netMaxUpMbps' : 'netMaxDownMbps';
const LHM_DATA_URL = 'http://127.0.0.1:8085/data.json';

// ── 每个控件自己的「硬件选择器」────────────────────────────────────────────
// CPU 控件 → 选 CPU；GPU 控件 → 选显卡；风扇控件 → 选具体风扇；网络控件 → 选网卡。
// 未列出的类型（ram-percent / ram-gb）无选择器：内存只有一套，无需挑。
const HW_KIND_BY_TYPE = {
  'cpu-temp': 'cpu', 'cpu-percent': 'cpu', 'cpu-power': 'cpu', 'cpu-clock': 'cpu',
  'gpu-temp': 'gpu', 'gpu-percent': 'gpu', 'gpu-power': 'gpu', 'gpu-clock': 'gpu', 'gpu-mem': 'gpu',
  'fan': 'fan',
  'network-up': 'nic', 'network-down': 'nic',
};
const HW_KIND = HW_KIND_BY_TYPE[MONITOR_TYPE] || '';
const HW_CONFIG_KEY = { cpu: 'cpuId', gpu: 'gpuId', fan: 'fanId', nic: 'nicId' }[HW_KIND] || '';
const HW_LABEL_KEY = { cpu: 'hwLabelCpu', gpu: 'hwLabelGpu', fan: 'hwLabelFan', nic: 'hwLabelNic' }[HW_KIND] || '';
const HW_LABEL_FALLBACK = { cpu: 'CPU', gpu: 'GPU', fan: 'Fan', nic: 'Network Adapter' }[HW_KIND] || '';

// ── 每个控件自己的「满量程」（非百分比参数：TDP / 频率上限 / 温度 / 显存 / 内存 / 转速）──
// 留空 = Auto（沿用插件原有的自适应量程或静态默认）；填值 = 固定量程。
// adaptive:true 的类型在插件侧走"观测峰值自适应"，填了值才会被钉死。
const SCALE_PARAM = {
  'cpu-temp':  { key: 'tempMaxC',    unit: '°C',  def: 110,  adaptive: false },
  'gpu-temp':  { key: 'tempMaxC',    unit: '°C',  def: 110,  adaptive: false },
  'cpu-power': { key: 'powerMaxW',   unit: 'W',   def: 160,  adaptive: true  },
  'gpu-power': { key: 'powerMaxW',   unit: 'W',   def: 500,  adaptive: true  },
  'cpu-clock': { key: 'clockMaxMHz', unit: 'MHz', def: 6000, adaptive: true  },
  'gpu-clock': { key: 'clockMaxMHz', unit: 'MHz', def: 3000, adaptive: true  },
  'gpu-mem':   { key: 'memMaxGB',    unit: 'GB',  def: 24,   adaptive: false },
  'ram-gb':    { key: 'ramMaxGB',    unit: 'GB',  def: 64,   adaptive: false },
  'fan':       { key: 'fanMaxRPM',   unit: 'RPM', def: 3000, adaptive: false },
};
const SCALE = SCALE_PARAM[MONITOR_TYPE] || null;
const SCALE_KEY = SCALE ? SCALE.key : '';

// 预设只包含「视觉样式」参数。用白名单重建 currentPresetParams，避免把
// gpuId / 硬件选择 / 满量程 / 带宽键混进去 —— saveSettings() 里 `...currentPresetParams`
// 若带上旧 gpuId，会覆盖掉用户刚在面板里选的新值（曾导致 GPU 选择无法保存）。
const PRESET_KEYS = [
  'titleFontSize', 'titleColor', 'titleStroke', 'titleStrokeColor',
  'valueFontSize', 'valueColor', 'valueStroke', 'valueStrokeColor',
  'unitFontSize', 'unitColor', 'showTitleOnIcon', 'showProgress', 'showHistory', 'enableSharpen',
];

$UD.onConnected(conn => {
  console.log('[systemvitals.js] Connected to Ulanzi plugin, action =', ACTION_ID);
  console.log('[systemvitals.js] monitorType =', MONITOR_TYPE || '(unknown)', '| hwKind =', HW_KIND || '-', '| scaleKey =', SCALE_KEY || '-');

  form = document.querySelector('#property-inspector');

  const el = document.querySelector('.uspi-wrapper');
  el.classList.remove('hidden');

  // --- 按控件类型显隐分区（未知类型时仅保留通用项）---
  const hwItem = document.getElementById('hwSelectItem');
  if (hwItem) hwItem.style.display = HW_KIND ? '' : 'none';
  const scaleItem = document.getElementById('scaleItem');
  if (scaleItem) scaleItem.style.display = SCALE ? '' : 'none';
  const netItem = document.getElementById('netLimitItem');
  if (netItem) netItem.style.display = IS_NET_TYPE ? '' : 'none';

  // --- Chart Style ---
  const chartStyle = document.getElementById('chartStyle');
  if (chartStyle) chartStyle.onchange = () => saveSettings();

  // --- Preset dropdown ---
  const presetSelect = document.getElementById('presetSelect');
  if (presetSelect) {
    presetSelect.onchange = () => {
      const presetName = presetSelect.value;
      if (presetName) applyPreset(presetName);
    };
  }

  // --- 硬件选择下拉框：标签随类型变化，选项实时枚举自 LHM ---
  const hwSelect = document.getElementById('hwSelect');
  if (hwSelect && HW_KIND) {
    loadHardwareOptions(HW_KIND, hwSelect); // 失败则仅保留 Auto（离线降级）
    hwSelect.onchange = () => saveSettings();
  }

  // --- 满量程（TDP / 频率上限 / 温度 / …）：数字 + 单位后缀 ---
  const scaleInput = document.getElementById('scaleInput');
  if (scaleInput && SCALE) {
    const unit = document.getElementById('scaleUnit');
    if (unit) unit.textContent = SCALE.unit;   // 单位是符号，不参与本地化
    scaleInput.oninput = () => saveSettings();
    scaleInput.onchange = () => saveSettings();
  }

  // --- 网络带宽上限（仅 network-up / network-down）---
  if (IS_NET_TYPE) {
    const netInput = document.getElementById('netMaxMbps');
    if (netInput) {
      netInput.oninput = () => saveSettings();
      netInput.onchange = () => saveSettings();
    }
  }

  // 文案类内容统一交给 applyLabels()：本地化词条是【异步】加载的 ——
  // SDK 在 connect 回调里 await readJson 之后才填充 $UD.localization，
  // 而 onConnected 此刻已触发，$UD.localization 仍为 null → 直接读会永久停在英文。
  // 因此先按英文兜底渲染，词条就绪后再刷新一次。
  applyLabels();
  whenLocalized(applyLabels);

  // 配置由上位机通过 onAdd / onParamFromApp 自动恢复，无需手动 requestSettings
});

// 渲染所有"随控件类型变化"的文案（硬件标签 / 满量程标签 / Auto 占位 / 悬停说明）。
// 可安全重复调用：本地化未就绪时用英文兜底，就绪后被译文覆盖。
function applyLabels() {
  if (HW_KIND) {
    const hwLabel = document.getElementById('hwSelectLabel');
    if (hwLabel) hwLabel.textContent = loc(HW_LABEL_KEY, HW_LABEL_FALLBACK);
    const autoOpt = document.getElementById('hwSelectAuto');
    if (autoOpt) autoOpt.textContent = loc('hwAuto', 'Auto');
  }
  if (SCALE) {
    const scaleLabel = document.getElementById('scaleLabel');
    if (scaleLabel) scaleLabel.textContent = loc('rangeMaxLabel', 'Range Max');
    const scaleInput = document.getElementById('scaleInput');
    if (scaleInput) {
      scaleInput.placeholder = loc('hwAuto', 'Auto');
      // 悬停说明 Auto 的含义（自适应 vs 静态默认），避免在面板上堆可见注释
      scaleInput.title = SCALE.adaptive
        ? loc('rangeMaxAutoAdaptive', 'Auto — scales to the observed peak. Enter a value to pin the range (e.g. TDP or max boost clock).')
        : loc('rangeMaxAutoStatic', 'Auto — {d} {u}. Enter a value to override.')
            .replace('{d}', SCALE.def).replace('{u}', SCALE.unit);
    }
  }
  if (IS_NET_TYPE) {
    const netInput = document.getElementById('netMaxMbps');
    if (netInput) netInput.placeholder = loc('hwAuto', 'Auto');
  }
}

// 本地化词条异步就绪后执行 cb（最长等 ~6s；超时则保留英文兜底，不阻塞面板）
function whenLocalized(cb) {
  if ($UD.localization) { cb(); return; }
  let tries = 0;
  const timer = setInterval(() => {
    if ($UD.localization) { clearInterval(timer); cb(); return; }
    if (++tries > 40) clearInterval(timer);
  }, 150);
}

// 读本地化词条（localization 由 SDK 的 localizeUI 异步加载，可能尚未就绪）
function loc(key, fallback) {
  if (!key) return fallback;
  return ($UD.localization && $UD.localization[key]) || fallback;
}

// ── 从 LHM 枚举可选硬件，填充下拉框 ────────────────────────────────────────
// kind: 'cpu' 取 /amdcpu/|/intelcpu/ 硬件节点
//       'gpu' 取 /gpu* 硬件节点
//       'nic' 取 /nic/ 硬件节点
//       'fan' 取所有 Type==='Fan' 的传感器（值用 SensorId，标签带所属硬件名）
// 任何失败都只保留 Auto（离线降级，不阻塞面板其余部分）。
async function loadHardwareOptions(kind, select) {
  try {
    const res = await fetch(LHM_DATA_URL, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const root = await res.json();
    const items = collectHardwareOptions(root, kind);
    for (const it of items) {
      const opt = document.createElement('option');
      opt.value = it.value;
      opt.textContent = it.text;
      select.appendChild(opt);
    }
    console.log('[systemvitals.js] 已枚举', kind, '选项数:', items.length);
  } catch (e) {
    console.warn('[systemvitals.js] 枚举 ' + kind + ' 列表失败（离线降级，仅保留 Auto）:', e && e.message);
  }
  // 无论成功与否都回设暂存值：枚举失败时保持 Auto 而不是显示错误项
  if (pendingSelectValue !== '') {
    select.value = pendingSelectValue;
    pendingSelectValue = '';
  }
}

// 遍历 LHM 树收集候选；curHwName = 最近的祖先硬件名（用于给风扇传感器加前缀）
function collectHardwareOptions(root, kind) {
  const out = [];
  const seen = new Set();
  const push = (value, text) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ value, text: text || value });
  };

  const walk = (node, curHwName) => {
    if (!node || !Array.isArray(node.Children)) return;
    for (const child of node.Children) {
      const hwId = child.HardwareId || '';
      const low = hwId.toLowerCase();
      const name = child.Text || hwId;
      const isSensor = !!(child.Type && child.SensorId);

      if (isSensor) {
        if (kind === 'fan' && child.Type === 'Fan') {
          push(child.SensorId, curHwName ? curHwName + ' — ' + name : name);
        }
      } else if (hwId) {
        if (kind === 'cpu' && (low.indexOf('/amdcpu/') === 0 || low.indexOf('/intelcpu/') === 0)) {
          push(hwId, name);
        } else if (kind === 'gpu' && low.indexOf('/gpu') === 0) {
          push(hwId, name);
        } else if (kind === 'nic' && low.indexOf('/nic/') >= 0) {
          push(hwId, name);
        }
      }
      walk(child, hwId ? name : curHwName);
    }
  };
  walk(root, '');
  return out;
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

// 收集预设样式键（白名单），其余键一律不透传
function pickPresetKeys(src) {
  const out = {};
  if (!src) return out;
  for (const k of PRESET_KEYS) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

// Save settings to plugin — 显式写入各项后再发送，避免被展开的预设参数覆盖
function saveSettings() {
  if (!form) {
    console.warn('[systemvitals.js] saveSettings: form not ready');
    return;
  }

  // 先铺预设视觉参数，再逐项显式赋值 —— 后者必须放在后面才能"赢"
  const settings = { ...currentPresetParams };
  settings.chartStyle = document.getElementById('chartStyle')?.value || 'ring';
  settings.preset = document.getElementById('presetSelect')?.value || '';

  // 硬件选择（空字符串 = Auto）
  if (HW_CONFIG_KEY) {
    settings[HW_CONFIG_KEY] = document.getElementById('hwSelect')?.value || '';
  }

  // 满量程（0 / 空 = Auto）
  if (SCALE_KEY) {
    const v = parseFloat(document.getElementById('scaleInput')?.value);
    settings[SCALE_KEY] = (isFinite(v) && v > 0) ? v : 0;
  }

  // 网络带宽上限（Mbps）：0 / 空 = Auto。仅网络控件携带，避免污染其他控件配置。
  if (IS_NET_TYPE) {
    const v = parseFloat(document.getElementById('netMaxMbps')?.value);
    settings[NET_MAX_KEY] = (isFinite(v) && v > 0) ? v : 0;
  }

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

  // 统一走 saveSettings()：顺带带上 chartStyle / 硬件选择 / 满量程 / 带宽上限。
  saveSettings();
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

  // Restore 硬件选择（选项可能尚未加载完成，先暂存）
  if (HW_CONFIG_KEY) {
    const sel = document.getElementById('hwSelect');
    if (sel) {
      const want = ACTION_SETTING[HW_CONFIG_KEY] || '';
      if (sel.options.length > 1) {
        sel.value = want;
      } else {
        pendingSelectValue = want;
      }
    }
  }

  // Restore 满量程（0 / 空 = Auto，输入框留空并显示 Auto 占位符）
  if (SCALE_KEY) {
    const input = document.getElementById('scaleInput');
    if (input) {
      const v = parseFloat(ACTION_SETTING[SCALE_KEY]);
      input.value = (isFinite(v) && v > 0) ? v : '';
    }
  }

  // Restore 网络带宽上限（0 / 空 = Auto）
  if (IS_NET_TYPE) {
    const netInput = document.getElementById('netMaxMbps');
    if (netInput) {
      const v = parseFloat(ACTION_SETTING[NET_MAX_KEY]);
      netInput.value = (isFinite(v) && v > 0) ? v : '';
    }
  }

  // Rebuild currentPresetParams so saveSettings() sends complete config.
  // 白名单重建：只保留视觉样式键，硬件选择 / 满量程 / 带宽键绝不混入，
  // 否则它们在 saveSettings 里会被旧值回灌，表现为"改了不生效"。
  if (ACTION_SETTING.presetParams) {
    currentPresetParams = pickPresetKeys(ACTION_SETTING.presetParams);   // 旧格式兼容
  } else {
    currentPresetParams = pickPresetKeys(ACTION_SETTING);
  }
  console.log('[systemvitals.js] currentPresetParams:', currentPresetParams);
}
