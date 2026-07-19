// app.js - Hardware Monitor 插件主逻辑（System Vitals 风格移植版）
// 运行环境：浏览器（由 app.html 加载），document 可用
// 数据来源：LibreHardwareMonitor HTTP API（直连 :8085/data.json）
// 降级策略：LHM 不可用 → 返回全零数据

// ========= 全局状态 =========
const ACTION_CACHE = {};           // context → Action 实例
const _pendingSettings = {};        // context → 提前到达的 onParamFromApp 配置缓存
const LHM_URL = 'http://127.0.0.1:8085/data.json';

// ═══════════════════════════════════════════════════════
//  LibreHardwareMonitor JSON 解析（纯 JavaScript，零依赖）
//  从 hardware-service.js 移植，可在浏览器 WebView 运行
// ═══════════════════════════════════════════════════════

function parseValue(val) {
  if (!val || typeof val !== 'string') return 0;
  const m = val.match(/^([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function findHardwareNode(root, hwIdPattern) {
  if (!root || !root.Children) return null;
  for (const child of root.Children) {
    if (child.HardwareId && child.HardwareId.toLowerCase().includes(hwIdPattern.toLowerCase())) {
      return child;
    }
    const found = findHardwareNode(child, hwIdPattern);
    if (found) return found;
  }
  return null;
}

function walkSensors(node, callback) {
  if (!node || !node.Children) return;
  for (const child of node.Children) {
    if (child.Type && child.SensorId) {
      callback(child);
    }
    if (child.Children && child.Children.length > 0) {
      walkSensors(child, callback);
    }
  }
}

function collectSensors(node, typeName) {
  const result = [];
  walkSensors(node, (sensor) => {
    if (sensor.Type === typeName) result.push(sensor);
  });
  return result;
}

function findSensorValue(sensors, typeName, sensorNames) {
  for (const namePattern of sensorNames) {
    for (const s of sensors) {
      if (s.Type === typeName &&
          (s.Text || '').toLowerCase().includes(namePattern.toLowerCase())) {
        return parseValue(s.Value);
      }
    }
  }
  for (const s of sensors) {
    if (s.Type === typeName) {
      const v = parseValue(s.Value);
      if (v > 0) return v;
    }
  }
  return 0;
}

// 精确传感器匹配：按优先级尝试精确名称（大小写不敏感），无 fallback
function findExactSensor(sensors, typeName, ...exactNames) {
  for (const name of exactNames) {
    const lower = name.toLowerCase();
    for (const s of sensors) {
      if (s.Type === typeName && (s.Text || '').toLowerCase() === lower) {
        return parseValue(s.Value);
      }
    }
  }
  return 0;
}

// SensorId 后缀精确匹配（跨平台唯一标识，最高优先级）
function findBySensorId(sensors, ...suffixes) {
  for (const suffix of suffixes) {
    for (const s of sensors) {
      if (s.SensorId && s.SensorId.endsWith(suffix)) {
        return parseValue(s.Value);
      }
    }
  }
  return 0;
}

function parseLHMJson(root) {
  const result = {
    cpu:    { load: 0, temp: 0, clock: 0, power: 0 },
    gpu:    { load: 0, temp: 0, memUsed: 0, memTotal: 0, power: 0, clock: 0 },
    memory: { percent: 0, used: 0, total: 0 },
    fan:    { rpm: 0 },
    source: 'librehardwaremonitor'
  };

  if (!root || !root.Children) return result;

  // ── CPU ───────────────────────────────────────────────
  const cpuNode = findHardwareNode(root, '/amdcpu/') || findHardwareNode(root, '/intelcpu/');
  if (cpuNode) {
    const tempSensors  = collectSensors(cpuNode, 'Temperature');
    const loadSensors  = collectSensors(cpuNode, 'Load');
    const clockSensors = collectSensors(cpuNode, 'Clock');
    const powerSensors = collectSensors(cpuNode, 'Power');

    result.cpu.temp = findBySensorId(tempSensors, '/temperature/2', '/temperature/0')
      || findExactSensor(tempSensors, 'Temperature', 'Core (Tctl/Tdie)', 'CPU Package', 'Core Max');
    result.cpu.load = findBySensorId(loadSensors, '/load/0')
      || findExactSensor(loadSensors, 'Load', 'CPU Total');
    result.cpu.clock = Math.round(
      findBySensorId(clockSensors, '/clock/1', '/clock/0')
      || findExactSensor(clockSensors, 'Clock', 'Cores (Average)', 'Core Average')
    );
    result.cpu.power = findBySensorId(powerSensors, '/power/0')
      || findExactSensor(powerSensors, 'Power', 'Package', 'CPU Package');
  }

  // CPU 温度后备：主板 SuperIO（部分 Intel 无 CPU 节点）
  if (result.cpu.temp === 0) {
    const lpcNode = findHardwareNode(root, '/lpc/');
    if (lpcNode) {
      const lpcTempSensors = collectSensors(lpcNode, 'Temperature');
      result.cpu.temp = findExactSensor(lpcTempSensors, 'Temperature', 'CPU');
    }
  }

  // ── GPU ───────────────────────────────────────────────
  let gpuNode = findHardwareNode(root, '/gpu-amd/') ||
                findHardwareNode(root, '/gpu-nvidia/') ||
                findHardwareNode(root, '/nvgpu/') ||
                findHardwareNode(root, '/amdgpu/');

  if (!gpuNode) {
    function findGPU(root) {
      if (!root || !root.Children) return null;
      for (const child of root.Children) {
        if (child.HardwareId && (child.HardwareId.toLowerCase().includes('/gpu') ||
            (child.Text || '').toLowerCase().includes('radeon') ||
            (child.Text || '').toLowerCase().includes('nvidia'))) {
          return child;
        }
        const found = findGPU(child);
        if (found) return found;
      }
      return null;
    }
    gpuNode = findGPU(root);
  }

  if (gpuNode) {
    const tempSensors = collectSensors(gpuNode, 'Temperature');
    const loadSensors = collectSensors(gpuNode, 'Load');
    const powerSensors = collectSensors(gpuNode, 'Power');
    const clockSensors = collectSensors(gpuNode, 'Clock');

    result.gpu.temp = findBySensorId(tempSensors, '/temperature/0')
      || findExactSensor(tempSensors, 'Temperature', 'GPU Core', 'GPU Hot Spot');
    result.gpu.load = findBySensorId(loadSensors, '/load/0')
      || findExactSensor(loadSensors, 'Load', 'GPU Core');
    result.gpu.power = findBySensorId(powerSensors, '/power/3', '/power/0')
      || findExactSensor(powerSensors, 'Power', 'GPU Package', 'GPU Power');
    result.gpu.clock = Math.round(
      findBySensorId(clockSensors, '/clock/0')
      || findExactSensor(clockSensors, 'Clock', 'GPU Core')
    );

    // GPU 显存：SmallData 类型，SensorId=/smalldata/0,2，单位 MB → GB
    const smallDataSensors = collectSensors(gpuNode, 'SmallData');
    result.gpu.memUsed = Math.round(
      (findBySensorId(smallDataSensors, '/smalldata/0')
       || findExactSensor(smallDataSensors, 'SmallData', 'GPU Memory Used'))
      / 10.24) / 100;
    result.gpu.memTotal = Math.round(
      (findBySensorId(smallDataSensors, '/smalldata/2')
       || findExactSensor(smallDataSensors, 'SmallData', 'GPU Memory Total'))
      / 10.24) / 100;
    if (result.gpu.memTotal === 0 && result.gpu.memUsed > 0) {
      const memFree = Math.round(
        (findBySensorId(smallDataSensors, '/smalldata/1')
         || findExactSensor(smallDataSensors, 'SmallData', 'GPU Memory Free'))
        / 10.24) / 100;
      if (memFree > 0) {
        result.gpu.memTotal = Math.round((result.gpu.memUsed + memFree) * 100) / 100;
      }
    }
  }

  // ── 内存 ──────────────────────────────────────────────
  const memNode = findHardwareNode(root, '/ram');
  if (memNode) {
    const loadSensors = collectSensors(memNode, 'Load');
    const dataSensors = collectSensors(memNode, 'Data');

    result.memory.percent = findSensorValue(loadSensors, 'Load', ['memory']);

    let memUsed = 0, memAvailable = 0;
    for (const s of dataSensors) {
      const text = (s.Text || '').toLowerCase();
      if (text.includes('used') && !text.includes('available')) {
        memUsed = parseValue(s.Value);
      }
      if (text.includes('available')) {
        memAvailable = parseValue(s.Value);
      }
    }

    result.memory.used = memUsed;
    result.memory.total = memUsed + memAvailable;

    if (result.memory.total === 0 && result.memory.percent > 0) {
      result.memory.total = Math.round(result.memory.used / result.memory.percent * 100) / 100;
    }
  }

  // ── 风扇 ──────────────────────────────────────────────
  const fanSensors = [];
  function collectFanNodes(node) {
    if (!node || !node.Children) return;
    for (const child of node.Children) {
      const sensors = collectSensors(child, 'Fan');
      if (sensors.length > 0) {
        fanSensors.push(...sensors);
      }
      collectFanNodes(child);
    }
  }
  collectFanNodes(root);

  if (fanSensors.length > 0) {
    const rpms = fanSensors.map(s => parseValue(s.Value)).filter(r => r > 0);
    if (rpms.length > 0) {
      result.fan.rpm = Math.max(...rpms);
    }
  }

  return result;
}

// LHM NIC Throughput 求和（所有网卡上行/下行 Throughput 累加）
function extractNetworkFromLHM(root) {
  if (!root || !root.Children) return { up: 0, down: 0, upUnit: 'MB/s', downUnit: 'MB/s' };
  let totalUp = 0, totalDown = 0;

  function walkNic(node) {
    if (!node || !node.Children) return;
    for (const child of node.Children) {
      const hwId = (child.HardwareId || '').toLowerCase();
      if (hwId.includes('/nic/')) {
        const tpSensors = collectSensors(child, 'Throughput');
        for (const s of tpSensors) {
          const sid = (s.SensorId || '').toLowerCase();
          const val = parseValue(s.Value);
          if (sid.endsWith('/throughput/7')) totalUp += val;
          if (sid.endsWith('/throughput/8')) totalDown += val;
        }
      }
      walkNic(child);
    }
  }
  walkNic(root);

  const upMB = totalUp / 1048576;
  const downMB = totalDown / 1048576;

  return {
    up: +upMB.toFixed(2),
    down: +downMB.toFixed(2),
    upUnit: upMB > 1 ? 'MB/s' : 'KB/s',
    downUnit: downMB > 1 ? 'MB/s' : 'KB/s',
  };
}

// ========= 全局数据管道（发布-订阅 + Promise 去重）=========
let _pendingFetch = null;           // 进行中的 fetch Promise（去重用）
const _dataSubscribers = new Set(); // callback 集合
let _globalTimer = null;            // 全局轮询定时器
const GLOBAL_INTERVAL = 1000;       // 全局轮询间隔 1000ms

// 获取数据（直连 LHM HTTP API，带 Promise 去重）
async function fetchHardwareData() {
  if (_pendingFetch) return _pendingFetch;

  _pendingFetch = (async () => {
    try {
      const res = await fetch(LHM_URL, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const parsed = parseLHMJson(raw);
      const network = extractNetworkFromLHM(raw);
      return {
        success: true,
        ...parsed,
        network,
        diskUsage: [],  // LHM disk 数据零散，暂不提取
      };
    } catch (e) {
      console.warn('[HardwareMonitor] LHM 读取失败:', e.message);
      return {
        success: false,
        cpu:    { load: 0, temp: 0, clock: 0, power: 0 },
        gpu:    { load: 0, temp: 0, memUsed: 0, memTotal: 0, power: 0, clock: 0 },
        memory: { percent: 0, used: 0, total: 0 },
        fan:    { rpm: 0 },
        network: { up: 0, down: 0, upUnit: 'MB/s', downUnit: 'MB/s' },
        diskUsage: [],
        source: 'error',
      };
    } finally {
      _pendingFetch = null;
    }
  })();
  return _pendingFetch;
}

// 启动/停止全局轮询
function startGlobalTimer() {
  if (_globalTimer) return;
  _globalTimer = setInterval(async () => {
    if (_dataSubscribers.size === 0) return;
    const data = await fetchHardwareData();
    if (data) {
      for (const cb of _dataSubscribers) {
        try { cb(data); } catch (e) { console.error('[HardwareMonitor] 订阅者回调异常:', e); }
      }
    }
  }, GLOBAL_INTERVAL);
}

function stopGlobalTimer() {
  if (_globalTimer) { clearInterval(_globalTimer); _globalTimer = null; }
}

// 默认显示配置（会被 settings 覆盖）
const DEFAULT_CONFIG = {
  monitorType: 'cpu-temp',    // 监视类型
  title: 'CPU',                // 标题文字
  titleFontSize: 18,           // 标题字号（px，144x144 画布）
  titleColor: '#ffffff',        // 标题颜色
  titleStroke: 0,              // 标题描边粗细（0=无）
  titleStrokeColor: '#000000',
  valueFontSize: 48,            // 数值字号
  valueColor: '#00ffcc',       // 数值颜色
  valueStroke: 4,              // 数值描边
  valueStrokeColor: '#000000',
  unit: '°C',                  // 单位文字
  unitFontSize: 20,             // 单位字号（0=不显示）
  unitColor: '#88ccff',
  showTitleOnIcon: true,        // 在图标上渲染标题
  showProgress: true,          // 是否显示进度环
  chartStyle: 'ring',          // 图表样式: 'ring' | 'wave'
  showHistory: true,           // 是否显示历史曲线
};

// 监视类型定义（完整对齐 System Vitals）
const MONITOR_TYPES = {
  // 温度
  'cpu-temp':       { title: 'CPUt',    unit: '°C',  category: 'temperature', field: 'cpu.temp',          min: 0,   max: 100, color: '#ff6644' },
  'gpu-temp':       { title: 'GPUt',    unit: '°C',  category: 'temperature', field: 'gpu.temp',          min: 0,   max: 100, color: '#4488ff' },
  // 使用率 %
  'cpu-percent':    { title: 'CPU%',    unit: '%',    category: 'percent',     field: 'cpu.load',          min: 0,   max: 100, color: '#00ffcc' },
  'gpu-percent':    { title: 'GPU%',    unit: '%',    category: 'percent',     field: 'gpu.load',          min: 0,   max: 100, color: '#4488ff' },
  'ram-percent':    { title: 'RAM',     unit: '%',    category: 'percent',     field: 'memory.percent',    min: 0,   max: 100, color: '#44cc88' },
  // 功耗
  'cpu-power':      { title: 'CPUp',    unit: 'W',    category: 'power',       field: 'cpu.power',         min: 0,   max: 160, color: '#ffaa00' },
  'gpu-power':      { title: 'GPUp',    unit: 'W',    category: 'power',       field: 'gpu.power',         min: 0,   max: 500, color: '#ff6644' },
  // 频率
  'cpu-clock':      { title: 'CPUc',    unit: 'MHz',  category: 'clock',       field: 'cpu.clock',          min: 0,   max: 6000,   color: '#ccccff' },
  'gpu-clock':      { title: 'GPUc',    unit: 'MHz',  category: 'clock',       field: 'gpu.clock',          min: 0,   max: 3000, color: '#ffcc44' },
  // 显存
  'gpu-mem':       { title: 'VRAM',    unit: 'GB',   category: 'data',        field: 'gpu.memUsed',       min: 0,   max: 24,  color: '#ff88ff' },
  // 内存
  'ram-gb':        { title: 'RAM',     unit: 'GB',   category: 'data',        field: 'memory.used',       min: 0,   max: 64,  color: '#44cc88' },
  // 风扇
  'fan':            { title: 'FAN',     unit: 'RPM',  category: 'fan',         field: 'fan.rpm',           min: 0,   max: 3000, color: '#888888' },
  // 网络
  'network-up':     { title: 'UP',      unit: 'MB/s', category: 'network',     field: 'network.up',        min: 0,   max: 100, color: '#00ccff' },
  'network-down':   { title: 'DOWN',    unit: 'MB/s', category: 'network',     field: 'network.down',      min: 0,   max: 100, color: '#ffcc00' },
};

// 从数据类型路径读值，如 'cpu.temp' → data.cpu.temp
function getDataByField(data, field) {
  if (!data) return 0;
  const parts = field.split('.');
  let obj = data;
  for (const p of parts) {
    if (obj == null) return 0;
    obj = obj[p];
  }
  return (obj != null && typeof obj === 'number') ? obj : 0;
}

// ========= Canvas 绘图（System Vitals 风格增强版）==========

function createCanvas() {
  const c = document.createElement('canvas');
  c.width = 144; c.height = 144;
  return c;
}

// 绘制渐变背景（增强效果）
function drawBackground(ctx, config) {
  const { valueColor = '#00ffcc', monitorType = 'cpu-temp' } = config;

  // 主渐变：从深蓝到深紫
  const gradient = ctx.createLinearGradient(0, 0, 144, 144);
  gradient.addColorStop(0, '#0f0f1a');
  gradient.addColorStop(0.5, '#1a1a2e');
  gradient.addColorStop(1, '#0a0a15');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 144, 144);

  // 径向高光（中心偏上，模拟顶部光源）
  const radialGrad = ctx.createRadialGradient(72, 50, 0, 72, 50, 80);
  radialGrad.addColorStop(0, 'rgba(255,255,255,0.05)');
  radialGrad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = radialGrad;
  ctx.fillRect(0, 0, 144, 144);

  // 根据 monitor type 添加微妙的主色调叠加
  const mainColor = valueColor || '#00ffcc';
  ctx.fillStyle = hexToRgba(mainColor, 0.03);
  ctx.fillRect(0, 0, 144, 144);
}

// 绘制增强的进度环（发光、渐变、刻度、末端圆点）
function drawProgressRing(ctx, cx, cy, r, ratio, config) {
  const { valueColor = '#00ffcc' } = config;

  // 底圈（更淡）
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 6;
  ctx.stroke();

  if (ratio <= 0) return;

  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + ratio * Math.PI * 2;

  // 发光效果（外圈，更宽的半透明弧）
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);
  ctx.strokeStyle = hexToRgba(valueColor, 0.3);
  ctx.lineWidth = 12;

  ctx.shadowColor = valueColor;
  ctx.shadowBlur = 15;

  ctx.stroke();
  ctx.shadowBlur = 0; // 重置
  ctx.shadowColor = 'rgba(0,0,0,0)';

  // 进度弧（主环）
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);

  // 根据比例选择颜色（绿 → 黄 → 红）
  let ringColor = valueColor;
  if (ratio > 0.8) ringColor = '#ff4444';
  else if (ratio > 0.5) ringColor = '#ffaa00';
  else ringColor = '#00ff88';

  ctx.strokeStyle = ringColor;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.stroke();

  // 末端圆点（白色高亮）
  const dotX = cx + r * Math.cos(endAngle);
  const dotY = cy + r * Math.sin(endAngle);
  ctx.beginPath();
  ctx.arc(dotX, dotY, 3, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 6;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'rgba(0,0,0,0)';

  // 刻度标记（每 25%）
  for (let i = 0; i < 4; i++) {
    const angle = startAngle + (i * 0.25) * Math.PI * 2;
    const x1 = cx + (r - 8) * Math.cos(angle);
    const y1 = cy + (r - 8) * Math.sin(angle);
    const x2 = cx + (r - 3) * Math.cos(angle);
    const y2 = cy + (r - 3) * Math.sin(angle);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// 绘制带阴影的文本
function drawTextWithShadow(ctx, text, x, y, fontSize, color, strokeWidth, strokeColor, options = {}) {
  const { textAlign = 'center', textBaseline = 'middle', fontFamily = null } = options;

  ctx.textAlign = textAlign;
  ctx.textBaseline = textBaseline;

  // 使用自定义字体（如果可用）
  const font = fontFamily || "'Source Han Sans SC', 'Segoe UI', system-ui, sans-serif";
  ctx.font = `bold ${fontSize}px ${font}`;

  // 阴影效果
  ctx.shadowColor = 'rgba(0,0,0,0.8)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  // 描边
  if (strokeWidth > 0) {
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
  }

  // 填充
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);

  // 重置阴影（设为 'rgba(0,0,0,0)' 避免某些浏览器仍计算透明阴影）
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

// 绘制监控类型图标（简化几何版本）
function drawMonitorIcon(ctx, x, y, size, monitorType, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = 'transparent';
  ctx.lineWidth = 2;

  const type = (monitorType || '').toLowerCase();

  if (type.includes('cpu') || type.includes('gpu')) {
    // CPU/GPU 图标：方格阵列
    const gridSize = 3;
    const cellSize = size / (gridSize + 2);
    for (let i = 0; i < gridSize; i++) {
      for (let j = 0; j < gridSize; j++) {
        const cx = x - size / 2 + (i + 1) * cellSize;
        const cy = y - size / 2 + (j + 1) * cellSize;
        ctx.strokeRect(cx - cellSize / 3, cy - cellSize / 3, cellSize * 0.66, cellSize * 0.66);
      }
    }
    // 引脚（底部）
    ctx.beginPath();
    ctx.moveTo(x - size / 3, y + size / 2);
    ctx.lineTo(x + size / 3, y + size / 2);
    ctx.stroke();
  } else if (type.includes('ram') || type.includes('mem')) {
    // RAM 图标：矩形条
    for (let i = 0; i < 4; i++) {
      const barH = size * 0.2;
      const barY = y - size / 2 + i * (barH + 2);
      ctx.fillStyle = i % 2 === 0 ? hexToRgba(color, 0.6) : 'transparent';
      ctx.fillRect(x - size / 3, barY, size * 0.66, barH);
      ctx.strokeRect(x - size / 3, barY, size * 0.66, barH);
    }
  } else if (type.includes('fan')) {
    // 风扇图标：圆形 + 叶片
    ctx.beginPath();
    ctx.arc(x, y, size / 3, 0, Math.PI * 2);
    ctx.stroke();
    // 叶片
    for (let i = 0; i < 3; i++) {
      const angle = (i * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (size / 2) * Math.cos(angle), y + (size / 2) * Math.sin(angle));
      ctx.stroke();
    }
  } else if (type.includes('network') || type.includes('wifi')) {
    // 网络图标：扇形信号
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(x, y + size / 4, i * size / 6, -Math.PI * 0.8, -Math.PI * 0.2);
      ctx.stroke();
    }
    // 中心点
    ctx.beginPath();
    ctx.arc(x, y + size / 4, 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  } else if (type.includes('disk')) {
    // 磁盘图标：圆形 + 矩形
    ctx.beginPath();
    ctx.arc(x, y - size / 6, size / 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeRect(x - size / 3, y, size * 0.66, size / 3);
  } else if (type.includes('battery')) {
    // 电池图标：矩形 + 正极
    ctx.strokeRect(x - size / 3, y - size / 4, size * 0.66, size / 2);
    ctx.fillRect(x + size / 3 - 2, y - size / 8, 4, size / 4);
  } else {
    // 默认：圆形指示器
    ctx.beginPath();
    ctx.arc(x, y, size / 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, size / 6, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(color, 0.3);
    ctx.fill();
  }
}

// 绘制装饰元素（顶部/底部线条，无角落圆点 — T02a）
function drawDecorations(ctx, config) {
  const { valueColor = '#00ffcc' } = config;

  // 顶部装饰线
  ctx.beginPath();
  ctx.moveTo(20, 28);
  ctx.lineTo(124, 28);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 底部装饰线
  ctx.beginPath();
  ctx.moveTo(20, 130);
  ctx.lineTo(124, 130);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// 辅助函数：十六进制颜色转 rgba
function hexToRgba(hex, alpha = 1) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// 锐化滤镜：卷积核增强边缘（增强4）
function applySharpen(ctx, width, height, amount = 2) {
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const w = width, h = height;
  const copy = new Uint8ClampedArray(data);
  const kernel = [0, -1, 0, -1, 5, -1, 0, -1, 0]; // 3x3 sharpen kernel
  const kSize = 3, kHalf = 1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = -kHalf; ky <= kHalf; ky++) {
        for (let kx = -kHalf; kx <= kHalf; kx++) {
          const px = Math.min(w - 1, Math.max(0, x + kx));
          const py = Math.min(h - 1, Math.max(0, y + ky));
          const idx = (py * w + px) * 4;
          const kVal = kernel[(ky + kHalf) * kSize + (kx + kHalf)];
          r += copy[idx] * kVal;
          g += copy[idx + 1] * kVal;
          b += copy[idx + 2] * kVal;
        }
      }
      const idx = (y * w + x) * 4;
      data[idx] = Math.min(255, Math.max(0, r));
      data[idx + 1] = Math.min(255, Math.max(0, g));
      data[idx + 2] = Math.min(255, Math.max(0, b));
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

// 绘制完整图标：背景 + 图表（根据样式）+ 标题 + 数值 + 单位 + 装饰
// T03: 三模式布局重构
function drawIcon(config, value, extraText, history) {
  const {
    title = 'CPU',
    titleFontSize = 18,
    titleColor = '#ffffff',
    titleStroke = 0,
    titleStrokeColor = '#000000',
    valueFontSize = 48,
    valueColor = '#00ffcc',
    valueStroke = 4,
    valueStrokeColor = '#000000',
    unit = '°C',
    unitFontSize = 20,
    unitColor = '#88ccff',
    min = 0,
    max = 100,
    showProgress = true,
    monitorType = 'cpu-temp',
    chartStyle = 'ring',  // 'ring' | 'bar' | 'wave'
    category = '',
    showTitleOnIcon = true,
  } = config;

  const canvas = createCanvas();
  const ctx = canvas.getContext('2d');

  // 0. 彻底清空画布
  ctx.clearRect(0, 0, 144, 144);

  // 1. 渐变背景
  drawBackground(ctx, { valueColor, monitorType });

  // 2. 图表（根据样式）— 用 save/restore 隔离状态
  ctx.save();
  if (chartStyle === 'ring') {
    // T04c: minimal 预设 showProgress=false 时不绘环和图标
    if (showProgress && max > min) {
      const cx = 72, cy = 68, r = 54;
      const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));
      drawProgressRing(ctx, cx, cy, r, ratio, { valueColor });
    }
  } else if (chartStyle === 'wave') {
    // 曲线图 — 对 network/diskIO 根据历史数据动态调整 max
    const chartMax = getChartMax(config, history, value, min, max);
    drawWaveChart(ctx, history || [value], { valueColor, min, max: chartMax });
  }
  ctx.restore();

  // 3. 装饰元素（仅顶部/底部线条，无角落圆点）
  drawDecorations(ctx, config);

  // 4. 格式化数值 + 动态单位
  const displayVal = formatValue(value, config);

  const displayUnit = unit;

  // T03: 根据 chartStyle 分两种布局模式
  if (chartStyle === 'ring') {
    // === Ring 模式 ===
    // 标题：居中顶部（Y=22，与单位 Y=100 相对于环心 Y=68 趋于对称）
    if (showTitleOnIcon !== false && titleFontSize > 0) {
      drawTextWithShadow(ctx, title, 72, 22, titleFontSize, titleColor, titleStroke, titleStrokeColor, {
        textAlign: 'center', textBaseline: 'top',
      });
    }

    // 动态字号：
    // - data/network 分类（VRAM/RAM GB / 网络速度）强制缩小至与 clock 同级（valueFontSize - 12）
    // - 其他类型：4 字符以上缩小 8px 避免溢出圆环（r=54, 可用宽度约 100px）
    let ringValueFontSize = valueFontSize;
    if (category === 'data' || category === 'network') {
      ringValueFontSize = valueFontSize - 12;
    } else if (displayVal.length >= 4) {
      ringValueFontSize = valueFontSize - 8;
    }

    drawTextWithShadow(ctx, displayVal, 72, 68, ringValueFontSize, valueColor, valueStroke, valueStrokeColor, {
      textAlign: 'center', textBaseline: 'middle',
      fontFamily: "'Lucida Console', 'Courier New', monospace",
    });

    // 单位：居中在数值下方（字体与标题相同）
    if (displayUnit && unitFontSize > 0) {
      const superFontSize = titleFontSize;
      drawTextWithShadow(ctx, displayUnit, 72, 100, superFontSize, unitColor, 0, valueStrokeColor, {
        textAlign: 'center', textBaseline: 'middle',
      });
    }

  } else if (chartStyle === 'wave') {
    // === Wave 模式 ===
    // 标题：左上角左对齐
    if (showTitleOnIcon !== false && titleFontSize > 0) {
      drawTextWithShadow(ctx, title, 16, 18, titleFontSize, titleColor, titleStroke, titleStrokeColor, {
        textAlign: 'left', textBaseline: 'top',
      });
    }

    const waveValueFontSize = Math.max(24, valueFontSize - 8);
    // 数值：左对齐，字体缩小
    drawTextWithShadow(ctx, displayVal, 16, 40, waveValueFontSize, valueColor, valueStroke, valueStrokeColor, {
      textAlign: 'left', textBaseline: 'top',
      fontFamily: "'Lucida Console', 'Courier New', monospace",
    });

    // 单位：左对齐，在数值下方（字体与标题相同）
    if (displayUnit && unitFontSize > 0) {
      const superFontSize = titleFontSize;
      drawTextWithShadow(ctx, displayUnit, 16, 80, superFontSize, unitColor, Math.max(1, Math.round(valueStroke / 2)), valueStrokeColor, {
        textAlign: 'left', textBaseline: 'top',
      });
    }

    // 波形图，Y 范围下移以避开顶部文字
    const chartMax = getChartMax(config, history, value, min, max);
    drawWaveChart(ctx, history || [value], { valueColor, min, max: chartMax });
  }

  // 7. 副文本（底部）
  if (extraText) {
    ctx.font = '11px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.fillText(extraText, 72, 140);
  }

  applySharpen(ctx, 144, 144, 1.5);  // 增强4：轻度锐化

  return canvas.toDataURL('image/png');
}

// 动态计算图表 max 值（对 network/diskIO 根据历史数据自适应）
function getChartMax(config, history, currentValue, staticMin, staticMax) {
  const { category } = config;
  // 仅对 network/diskIO 做动态缩放，其他类别保持静态 max
  if (category !== 'network' && category !== 'diskIO') return staticMax;

  const vals = history && history.length > 0 ? history : [currentValue];
  const historyMax = Math.max(...vals.filter(v => v != null), currentValue);

  // 取 historyMax * 1.5 与 staticMax/10 中的较大值，确保低流量时不贴底
  const dynamicMax = Math.max(historyMax * 1.5, staticMax / 10, 0.1);
  return Math.min(dynamicMax, staticMax); // 不超过原始静态上限
}

// 绘制曲线图（贝塞尔曲线 + 渐变填充）— T03: y range 70-130
function drawWaveChart(ctx, history, { valueColor, min, max }) {
  if (!history || history.length === 0) return;

  const points = history.map((val, i) => {
    const x = 10 + (i / (Math.max(history.length - 1, 1))) * 124;
    const ratio = Math.max(0, Math.min(1, (val - min) / (max - min)));
    const y = 130 - ratio * 60;  // 曲线在上方（y 越小越靠上，range: 70-130）
    return { x, y };
  });

  // 渐变填充（曲线下方）
  ctx.beginPath();
  ctx.moveTo(points[0].x, 135);
  ctx.lineTo(points[0].x, points[0].y);

  // 贝塞尔曲线连接点（平滑）
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const cpx = (prev.x + curr.x) / 2;
    ctx.bezierCurveTo(cpx, prev.y, cpx, curr.y, curr.x, curr.y);
  }

  ctx.lineTo(points[points.length - 1].x, 135);
  ctx.closePath();

  const fillGrad = ctx.createLinearGradient(0, 50, 0, 135);
  fillGrad.addColorStop(0, hexToRgba(valueColor, 0.50));
  fillGrad.addColorStop(0.5, hexToRgba(valueColor, 0.12));
  fillGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // 曲线描边
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const cpx = (prev.x + curr.x) / 2;
    ctx.bezierCurveTo(cpx, prev.y, cpx, curr.y, curr.x, curr.y);
  }
  ctx.strokeStyle = valueColor;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function formatValue(value, config) {
  const { category, unit } = config;
  if (category === 'temperature' || category === 'power') {
    return Math.round(value).toString();
  }
  if (category === 'percent') {
    return Math.round(value).toString();
  }
  if (category === 'clock') {
    if (unit === 'GHz') return Number(value).toFixed(2);
    return Math.round(value).toString();
  }
  if (category === 'fan') {
    return Math.round(value).toString();
  }
  if (category === 'network') {
    // 固定 4 字符显示：与 data 分类一致
    if (value >= 100) return Math.round(value).toString();
    if (value >= 10) return Number(value).toFixed(1);
    return Number(value).toFixed(2);
  }
  if (category === 'data') {
    // 固定 4 字符显示：≥100 用整数，≥10 用 .1f，<10 用 .2f
    if (value >= 100) return Math.round(value).toString();
    if (value >= 10) return Number(value).toFixed(1);
    return Number(value).toFixed(2);
  }
  // 默认保留1位小数
  return Math.round(value * 10) / 10;
}

// ========= 单一 SystemVitals Action 类（全局发布-订阅模式）=========
class SystemVitalsAction {
  constructor(context, monitorType) {
    this.context = context;
    this.monitorType = monitorType || 'cpu-temp';
    this.config = { ...DEFAULT_CONFIG, ...MONITOR_TYPES[this.monitorType] };

    // 历史数据（用于曲线图）
    this.history = [];
    this.historyMax = 10;  // T02b: 硬编码 10

    // 最新数值（用于同步绘制）
    this.latestValue = 0;
    this.latestExtraText = '';

    // 订阅全局数据管道
    this._onData = this._handleData.bind(this);
    _dataSubscribers.add(this._onData);
    startGlobalTimer();

    console.log(`[HardwareMonitor] [${this.monitorType}] 已订阅全局数据管道`);
  }

  _handleData(data) {
    try {
      const typeInfo = MONITOR_TYPES[this.monitorType];
      if (!typeInfo) return;

      let value = 0;
      let extraText = '';

      // 根据字段路径读取值
      if (typeInfo.field.startsWith('cpu.')) {
        value = getDataByField(data, typeInfo.field);
      } else if (typeInfo.field.startsWith('gpu.')) {
        value = getDataByField(data, typeInfo.field);
        // 诊断日志：输出 GPU 数据的实际值以定位渲染偏差
        if (this.monitorType.startsWith('gpu-')) {
          console.log(`[HWDiag] ${this.monitorType}: raw=${value}, data.gpu=`, JSON.stringify(data.gpu));
        }
      } else if (typeInfo.field.startsWith('memory.')) {
        value = getDataByField(data, typeInfo.field);
        // ram-gb 动态设置 max
        if (this.monitorType === 'ram-gb' && data.memory && data.memory.total > 0) {
          this.config.max = Math.ceil(data.memory.total);
        }
      } else if (typeInfo.field.startsWith('fan.')) {
        value = getDataByField(data, 'fan.rpm');
      } else if (typeInfo.field.startsWith('network.')) {
        value = getDataByField(data, typeInfo.field);
        // 动态单位：LHM 返回 upUnit/downUnit 元数据（Fix 5: 仅在实际变化时更新）
        if (typeInfo.field === 'network.up' && data.network && data.network.upUnit) {
          if (this.config.unit !== data.network.upUnit) {
            this.config.unit = data.network.upUnit;
          }
        } else if (typeInfo.field === 'network.down' && data.network && data.network.downUnit) {
          if (this.config.unit !== data.network.downUnit) {
            this.config.unit = data.network.downUnit;
          }
        }
      } else if (typeInfo.field.startsWith('diskUsage.')) {
        const idx = parseInt(typeInfo.field.split('.')[1]) || 0;
        const diskUsage = data.diskUsage;
        if (diskUsage && diskUsage[idx]) {
          value = diskUsage[idx].percent;
          extraText = diskUsage[idx].drive || '';
        }
      }

      // 保存最新数值
      this.latestValue = value;
      this.latestExtraText = extraText;

      // 更新历史数据
      if (this.config.showHistory) {
        this.history.push(value);
        if (this.history.length > this.historyMax) {
          this.history.shift();
        }
      }

      // 自动刷新显示
      this.updateDisplay();
    } catch (err) {
      console.error(`[HardwareMonitor] [${this.monitorType}] 数据处理异常:`, err);
      // 保留 this.latestValue 不变（F6 修复）
    }
  }

  updateDisplay() {
    // 同步绘制：使用最新数值
    const value = this.latestValue;
    const extraText = this.latestExtraText;
    const typeInfo = MONITOR_TYPES[this.monitorType];

    if (!typeInfo) return;

    // 绘制图标并发送
    const icon = drawIcon(this.config, value, extraText, this.history);
    const bottomText = this.config.title || typeInfo.title || '';
    $UD.setBaseDataIcon(this.context, icon, bottomText);
  }

  destroy() {
    if (this._onData) {
      _dataSubscribers.delete(this._onData);
      this._onData = null;
    }
    if (_dataSubscribers.size === 0) {
      stopGlobalTimer();
    }
    console.log(`[HardwareMonitor] [${this.monitorType}] 已销毁`);
  }
}

// ========= 向后兼容的旧 Action 类 =========
class CpuAction {
  constructor(context) { this.context = context; this.monitorType = 'cpu-temp'; this.config = { ...DEFAULT_CONFIG, ...MONITOR_TYPES['cpu-temp'] }; }
  async updateDisplay() {
    const data = await fetchHardwareData();
    if (!data) return;
    const icon = drawIcon(this.config, data.cpu ? data.cpu.temp : 0, '');
    $UD.setBaseDataIcon(this.context, icon, data.cpu ? Math.round(data.cpu.temp) + '°C' : 'CPU');
  }
  destroy() {}
}
class GpuAction {
  constructor(context) { this.context = context; }
  async updateDisplay() {
    const data = await fetchHardwareData();
    if (!data) return;
    const icon = drawIcon({ ...DEFAULT_CONFIG, ...MONITOR_TYPES['gpu-temp'] }, data.gpu ? data.gpu.temp : 0, '');
    $UD.setBaseDataIcon(this.context, icon, data.gpu ? Math.round(data.gpu.temp) + '°C' : 'GPU');
  }
  destroy() {}
}
class MemoryAction {
  constructor(context) { this.context = context; }
  async updateDisplay() {
    const data = await fetchHardwareData();
    if (!data) return;
    const icon = drawIcon({ ...DEFAULT_CONFIG, ...MONITOR_TYPES['ram-percent'] }, data.memory ? data.memory.percent : 0, '');
    $UD.setBaseDataIcon(this.context, icon, data.memory ? Math.round(data.memory.percent) + '%' : 'RAM');
  }
  destroy() {}
}
class FanAction {
  constructor(context) { this.context = context; }
  async updateDisplay() {
    const data = await fetchHardwareData();
    if (!data) return;
    const icon = drawIcon({ ...DEFAULT_CONFIG, ...MONITOR_TYPES['fan'] }, data.fan ? data.fan.rpm : 0, '');
    $UD.setBaseDataIcon(this.context, icon, data.fan ? Math.round(data.fan.rpm) + ' RPM' : 'FAN');
  }
  destroy() {}
}

// ========= 插件事件 =========
console.log('[HardwareMonitor] 插件加载中...');

$UD.connect('com.ulanzi.ulanzistudio.HardwareMonitor');

$UD.onConnected(() => {
  console.log('[HardwareMonitor] 已连接到 Ulanzi Studio');
  // 每个 Action 实例通过全局发布-订阅管道获取数据
});

$UD.onAdd((jsn) => {
  const context = jsn.context;
  const uuid = jsn.uuid || '';
  console.log('[HardwareMonitor] 添加 Action:', uuid, '→', context);

  // 从 UUID 判断 monitorType
  let monitorType = 'cpu-temp';
  const uuidLower = uuid.toLowerCase();
  if (uuidLower.includes('cpu-temp'))       monitorType = 'cpu-temp';
  else if (uuidLower.includes('gpu-temp'))    monitorType = 'gpu-temp';
  else if (uuidLower.includes('cpu-percent')) monitorType = 'cpu-percent';
  else if (uuidLower.includes('gpu-percent')) monitorType = 'gpu-percent';
  else if (uuidLower.includes('ram-percent')) monitorType = 'ram-percent';
  else if (uuidLower.includes('cpu-power'))   monitorType = 'cpu-power';
  else if (uuidLower.includes('gpu-power'))   monitorType = 'gpu-power';
  else if (uuidLower.includes('cpu-clock'))   monitorType = 'cpu-clock';
  else if (uuidLower.includes('gpu-clock'))   monitorType = 'gpu-clock';
  else if (uuidLower.includes('gpu-mem'))    monitorType = 'gpu-mem';
  else if (uuidLower.includes('ram-gb'))     monitorType = 'ram-gb';
  else if (uuidLower.includes('fan'))         monitorType = 'fan';
  else if (uuidLower.includes('network-up'))  monitorType = 'network-up';
  else if (uuidLower.includes('network-down')) monitorType = 'network-down';

  // 若实例已存在则复用（参考 analog clock 模式），避免回退到默认配置
  let inst = ACTION_CACHE[context];
  if (!inst) {
    inst = new SystemVitalsAction(context, monitorType);
    ACTION_CACHE[context] = inst;
    // 恢复配置优先级：onAdd.param → 缓存的上位机配置（onParamFromApp 先于 onAdd 到达时）
    const savedParams = (jsn.param && Object.keys(jsn.param).length > 0) ? jsn.param : _pendingSettings[context];
    delete _pendingSettings[context];
    console.log(`[HardwareMonitor] onAdd: monitorType=${monitorType}, jsn.param=`, jsn.param, 'savedParams=', savedParams);
    if (savedParams) {
      applySettings(inst, savedParams);
    }
    $UD.getSettings(jsn.context);
  } else {
    // 已有实例：立即刷新（analog clock 的 drawClock 等价操作）
    inst.updateDisplay();
  }

  // 保存 key 到实例（用于调试）
  if (jsn.key) {
    inst.key = jsn.key;
  }
});

$UD.onRun((jsn) => {
  const inst = ACTION_CACHE[jsn.context];
  if (inst) inst.updateDisplay();
});

// 接收属性检查器发送的设置（Ulanzi 插件 API）
// T04a: 新增 presetParams 处理 + chartStyle 独立覆盖 + title 保护
console.log('[HardwareMonitor] 注册 onParamFromPlugin 处理器...');

// 共享设置应用函数（onParamFromPlugin / onParamFromApp / onAdd 共用）
function applySettings(inst, settings) {
  if (!inst || !settings) return;

  // requestSettings 仅用于 PI 请求当前配置，不做任何更新
  if (settings.action === 'requestSettings') return;

  const oldChartStyle = inst.config.chartStyle;

  // 现有 settings 合并逻辑
  for (const key of Object.keys(settings)) {
    if (inst.config && inst.config.hasOwnProperty(key)) {
      inst.config[key] = settings[key];
    }
  }

  // T04a: 预设参数应用 — 先覆盖样式（保护 title/unit 不被覆盖）
  if (settings.presetParams) {
    for (const key of Object.keys(settings.presetParams)) {
      if (key !== 'title' && key !== 'unit' && inst.config && inst.config.hasOwnProperty(key)) {
        inst.config[key] = settings.presetParams[key];
      }
    }
  }

  // T04a: chartStyle 独立覆盖 — 变化时清空历史
  if (settings.chartStyle !== undefined && settings.chartStyle !== oldChartStyle) {
    inst.history = [];
    console.log(`[HardwareMonitor] chartStyle 变化: ${oldChartStyle} → ${settings.chartStyle}，历史数据已清空`);
  }

  // T04a: title 保护 — 始终使用 MONITOR_TYPES 定义的标题
  const typeInfo = MONITOR_TYPES[inst.monitorType];
  if (typeInfo) {
    inst.config.title = typeInfo.title;
  }

  console.log('[HardwareMonitor] 收到设置更新:', settings, 'for monitorType:', inst.monitorType);

  inst.updateDisplay();
}

// 统一设置入口（对齐 demo 插件 onSetParams 模式）
function onSetSettings(jsn) {
  const settings = jsn.param || {};
  const context = jsn.context;
  const inst = context ? ACTION_CACHE[context] : null;
  if (!settings || !inst || JSON.stringify(settings) === '{}') return;
  applySettings(inst, settings);
}

$UD.onParamFromPlugin((jsn) => {
  onSetSettings(jsn);
});

// 接收上位机转发的已保存配置（参考 analog clock onParamFromApp）
$UD.onParamFromApp((jsn) => {
  const context = jsn.context;
  const inst = context ? ACTION_CACHE[context] : null;
  if (inst) {
    applySettings(inst, jsn.param);
  } else if (context && jsn.param) {
    // 实例尚未创建（onParamFromApp 先于 onAdd 到达）→ 缓存配置
    _pendingSettings[context] = jsn.param;
  }
});

$UD.onWillAppear((jsn) => {
  const inst = ACTION_CACHE[jsn.context];
  if (inst) inst.updateDisplay();
});

$UD.onWillDisappear((jsn) => {
  const inst = ACTION_CACHE[jsn.context];
  if (inst) {
    inst.destroy();
    delete ACTION_CACHE[jsn.context];
  }
});

// 主动请求上位机已保存的参数（didReceiveSettings 响应）
$UD.onDidReceiveSettings((jsn) => {
  if (jsn && jsn.settings) {
    onSetSettings({ context: jsn.context, param: jsn.settings });
  }
});

console.log('[HardwareMonitor] 插件加载完成，支持', Object.keys(MONITOR_TYPES).length, '种数据类型');
