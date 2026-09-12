// app.js - Hardware Monitor 插件主逻辑（System Vitals 风格移植版）
// 运行环境：浏览器（由 app.html 加载），document 可用
// 数据来源：LibreHardwareMonitor HTTP API（直连 :8085/data.json）
// 降级策略：LHM 不可用 → 返回全零数据

// ========= 全局状态 =========
const ACTION_CACHE = {};           // context → Action 实例
const _pendingSettings = {};        // context → 提前到达的 onParamFromApp 配置缓存
const LHM_URL = 'http://127.0.0.1:8085/data.json';
const DEBUG = false; // 热路径诊断日志开关：默认关闭，避免每 tick 的 JSON.stringify 开销
let _selectedGpuId = ''; // 用户在设置页手动选择的 GPU HardwareId（空字符串 = Auto 自动）
let _selectedCpuId = ''; // 手动选择的 CPU HardwareId（如 /amdcpu/0、/intelcpu/0）；空 = Auto（取首个 CPU）
let _selectedFanId = ''; // 手动选择的 Fan 传感器 SensorId；空 = Auto（全部风扇取最大值）
let _selectedNicId = ''; // 手动选择的网卡 HardwareId（如 /nic/0）；空 = Auto（全部网卡累加）

// ── 非百分比控件的"满量程"参数（Auto / 自定义）──────────────────────────
// 每个 monitorType 对应一个配置键、显示单位与静态默认上限。
// 0 / 空 = Auto：沿用原有行为（clock/power 走自适应量程，其余用 MONITOR_TYPES 的静态 max）。
// > 0 = 自定义：直接把 config.max 固定为用户填的数值（如 65W TDP、5000MHz 频率上限）。
// 百分比类控件（cpu/gpu/ram-percent）不在表内 —— 它们恒以 100% 为满量程，无需配置。
const SCALE_PARAM = {
  'cpu-temp':   { key: 'tempMaxC',    unit: '°C',  def: 110  },
  'gpu-temp':   { key: 'tempMaxC',    unit: '°C',  def: 110  },
  'cpu-power':  { key: 'powerMaxW',   unit: 'W',   def: 160  },
  'gpu-power':  { key: 'powerMaxW',   unit: 'W',   def: 500  },
  'cpu-clock':  { key: 'clockMaxMHz', unit: 'MHz', def: 6000 },
  'gpu-clock':  { key: 'clockMaxMHz', unit: 'MHz', def: 3000 },
  'gpu-mem':    { key: 'memMaxGB',    unit: 'GB',  def: 24   },
  'ram-gb':     { key: 'ramMaxGB',    unit: 'GB',  def: 64   },
  'fan':        { key: 'fanMaxRPM',   unit: 'RPM', def: 3000 },
};

// 控件类型 → 需要的硬件选择器种类（无条目 = 该类无需选择，如 RAM / 百分比）
const HW_SELECT_KIND = {
  'cpu-temp': 'cpu', 'cpu-percent': 'cpu', 'cpu-power': 'cpu', 'cpu-clock': 'cpu',
  'gpu-temp': 'gpu', 'gpu-percent': 'gpu', 'gpu-power': 'gpu', 'gpu-clock': 'gpu', 'gpu-mem': 'gpu',
  'fan': 'fan',
  'network-up': 'nic', 'network-down': 'nic',
};
// 选择器种类 → 配置键名（与 DEFAULT_CONFIG 中的键一一对应）
const HW_SELECT_KEY = { cpu: 'cpuId', gpu: 'gpuId', fan: 'fanId', nic: 'nicId' };
// 选择器种类 → 模块级状态读写（四个 let 无法动态索引，故用访问器包一层）
const HW_SELECT_STATE = {
  cpu: { get: () => _selectedCpuId, set: (v) => { _selectedCpuId = v; } },
  gpu: { get: () => _selectedGpuId, set: (v) => { _selectedGpuId = v; } },
  fan: { get: () => _selectedFanId, set: (v) => { _selectedFanId = v; } },
  nic: { get: () => _selectedNicId, set: (v) => { _selectedNicId = v; } },
};

// 把配置里的满量程值规整为"有效正数或 0(自动)"：非数字 / NaN / Infinity / ≤0 一律视为自动
function toPositiveNumber(v) {
  const n = (typeof v === 'number') ? v : parseFloat(v);
  return (typeof n === 'number' && isFinite(n) && n > 0) ? n : 0;
}

// ── 网络带宽满量程（网络环 100% 对应的上限，单位 B/s）──────────────────────
// 解析优先级：用户面板显式设置 > LHM 自动探测链路速率 > 兜底。
//
// 关于「能否直接从 LHM 读到带宽上限」——结论：不能直接读，但可以反解：
//   LibreHardwareMonitorLib/Hardware/Network/Network.cs 只创建 5 个传感器：
//   Data Uploaded / Data Downloaded / Upload Speed / Download Speed / Network Utilization，
//   【没有】Connection Speed / Link Speed。（Windows.Forms 中 `case "Connection Speed"`
//   是从 HWiNFO 兼容表继承的死代码，Network 硬件从不产生该传感器；实测 7 张网卡均无此传感器。）
//   但 Network.cs:90 用链路速率计算利用率：
//     load% = ((dBytesUp + dBytesDown) * 8 / dt) / NetworkInterface.Speed * 100
//   而 Upload/Download Speed 是同一 dt 得出的 B/s，故可精确反解：
//     NetworkInterface.Speed(bps) = (upBps + downBps) * 8 / (util% / 100)
//   实测本机反解得 998.6~1004.8 Mbps → 吸附到 1000 Mbps（1 Gbps），误差 < 1%。
// 注意语义差异：反解得到的是【网卡链路速率】（1 Gbps），不是【宽带上限】（如 60 Mbps）。
// 想按宽带上限画满环，请在属性面板显式填写。0/留空 = 自动。
const NET_LINK_FALLBACK_BPS = 125e6;   // 无法反解时的兜底：1 Gbps
const NET_LINK_MIN_UTIL_PCT = 0.5;     // 利用率低于此值：util 仅 1 位小数，反解误差过大 → 丢弃
const NET_LINK_MAX_UTIL_PCT = 97;      // 利用率接近/触顶说明已被 LHM 钳位，只能得到下界 → 丢弃
const NET_LINK_SNAP_TOLERANCE = 0.25;  // 反解值吸附到标准链路速率的相对容差
const NET_LINK_CONFIRM_HITS = 3;       // 连续一致观测达到该次数才切换结果（抗抖动/误判）
const STANDARD_LINK_MBPS = [10, 100, 1000, 2500, 5000, 10000, 20000, 40000, 100000];

// ═══════════════════════════════════════════════════════
//  LibreHardwareMonitor JSON 解析（纯 JavaScript，零依赖）
//  从 hardware-service.js 移植，可在浏览器 WebView 运行
// ═══════════════════════════════════════════════════════

function parseValue(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;          // RawValue 为数字（如网速 B/s）时直接返回
  if (typeof val !== 'string') return 0;
  const m = val.match(/^([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

// 兼容数字 RawValue：RawValue 为数字时直接返回，否则回退字符串解析
function parseRaw(val) {
  return (typeof val === 'number') ? val : parseValue(val);
}

// LHM 的 Throughput.Value 是"已格式化带单位"的字符串（最小档位为 KB/s，如 "40.0 KB/s"），
// RawValue 才是真实 B/s（如 "40963.9 B/s"）。当 RawValue 缺失而直接 parseValue("40.0 KB/s") 时
// 会得到 40 并被当成 40 B/s（少算 1024 倍）→ 显示与环形比例双双失真。此函数按单位还原回 B/s（1024 基）。
// 无单位后缀时行为与 parseValue 一致（保持向后兼容）。
function parseThroughputValue(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val !== 'string') return 0;
  const m = val.match(/^([\d.]+)\s*(k|m|g)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return 0;
  const p = (m[2] || '').toLowerCase();
  const KB = 1024, MB = 1024 * 1024, GB = 1024 * 1024 * 1024;
  if (p === 'k') return n * KB;
  if (p === 'm') return n * MB;
  if (p === 'g') return n * GB;
  return n; // B/s（无后缀）
}

// 网速字节单位自动缩放（与 LHM 一致的 KB/s|MB/s|GB/s，并补 LHM 缺失的 GB/s 档）
// 输入 B/s（数字），输出 {value, unit}
function formatThroughput(bytesPerSec) {
  const b = (typeof bytesPerSec === 'number' && isFinite(bytesPerSec)) ? bytesPerSec : 0;
  const KB = 1024, MB = 1024 * 1024, GB = 1024 * 1024 * 1024;
  if (b >= GB)  return { value: +(b / GB).toFixed(2), unit: 'GB/s' };
  if (b >= MB)  return { value: +(b / MB).toFixed(2), unit: 'MB/s' };
  if (b >= KB)  return { value: +(b / KB).toFixed(2), unit: 'KB/s' };
  return { value: +b.toFixed(2), unit: 'B/s' };
}

// 将字节/秒按目标显示单位换算（与 formatThroughput 档位一致：KB/MB/GB ×1024）
// 用于把 NIC Connection Speed（字节 B/s）对齐到当前吞吐量显示单位，使 ring/wave 的 max 与 value 同单位
function convertBytesToUnit(bytesPerSec, unit) {
  const b = (typeof bytesPerSec === 'number' && isFinite(bytesPerSec)) ? bytesPerSec : 0;
  const KB = 1024, MB = 1024 * 1024, GB = 1024 * 1024 * 1024;
  switch (unit) {
    case 'GB/s': return +(b / GB).toFixed(2);
    case 'MB/s': return +(b / MB).toFixed(2);
    case 'KB/s': return +(b / KB).toFixed(2);
    default: return +b.toFixed(2); // B/s
  }
}

// 将显示单位数值反算回字节/秒（convertBytesToUnit 的逆运算，1024 基）。
// 用于图形渲染：把缩放后的显示值统一换算回 B/s 基准，避免单位变化导致 ring/wave 顶满/跳变。
function unitToBytes(num, unit) {
  const n = (typeof num === 'number' && isFinite(num)) ? num : 0;
  const KB = 1024, MB = 1024 * 1024, GB = 1024 * 1024 * 1024;
  switch (unit) {
    case 'GB/s': return n * GB;
    case 'MB/s': return n * MB;
    case 'KB/s': return n * KB;
    default: return n; // B/s
  }
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

// 精确匹配 HardwareId（用于多 GPU 场景手动选择指定显卡）
function findHardwareNodeById(root, hwId) {
  if (!root || !root.Children || !hwId) return null;
  for (const child of root.Children) {
    if (child.HardwareId === hwId) return child;
    const found = findHardwareNodeById(child, hwId);
    if (found) return found;
  }
  return null;
}

// ── 手动硬件选择解析 ──────────────────────────────────────
// 语义与 GPU 选择保持一致：指定了就用指定的；指定的 HardwareId 当前不存在（换机/驱动变动）
// 则回退到自动发现，避免整块面板永久显示 0。
function resolveCpuNode(root, selectedCpuId) {
  if (selectedCpuId) {
    const byId = findHardwareNodeById(root, selectedCpuId);
    if (byId) return byId;
  }
  return findHardwareNode(root, '/amdcpu/') || findHardwareNode(root, '/intelcpu/');
}

// 风扇选择：Auto = 返回全部（调用方取最大值）；指定 = 仅该 SensorId（不存在则回退全部）
function applyFanSelection(sensorIds, selectedFanId) {
  if (!selectedFanId) return sensorIds;
  return sensorIds.indexOf(selectedFanId) >= 0 ? [selectedFanId] : sensorIds;
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

function parseLHMJson(root, selectedGpuId) {
  const result = {
    cpu:    { load: 0, temp: 0, clock: 0, power: 0 },
    gpu:    { load: 0, temp: 0, memUsed: 0, memTotal: 0, power: 0, clock: 0 },
    memory: { percent: 0, used: 0, total: 0 },
    fan:    { rpm: 0 },
    source: 'librehardwaremonitor'
  };

  if (!root || !root.Children) return result;

  // ── CPU ───────────────────────────────────────────────
  const cpuNode = resolveCpuNode(root, _selectedCpuId);
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
  let gpuNode = selectedGpuId
    ? findHardwareNodeById(root, selectedGpuId)
    : (findHardwareNode(root, '/gpu-amd/') ||
       findHardwareNode(root, '/gpu-nvidia/') ||
       findHardwareNode(root, '/nvgpu/') ||
       findHardwareNode(root, '/amdgpu/') ||
       findHardwareNode(root, '/gpu-intel-integrated/') ||
       findHardwareNode(root, '/gpu-intel/'));

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
      || findExactSensor(loadSensors, 'Load', 'GPU Core')
      || (loadSensors.length ? Math.max(0, ...loadSensors.map(s => parseValue(s.Value))) : 0); // iGPU 兜底：D3D 引擎负载最大值
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
    // 手动选择单个风扇时只读该传感器；Auto 时读全部并取最大值
    const chosenIds = applyFanSelection(fanSensors.map(s => s.SensorId).filter(Boolean), _selectedFanId);
    const chosenSet = new Set(chosenIds);
    const rpms = fanSensors
      .filter(s => chosenSet.has(s.SensorId))
      .map(s => parseValue(s.Value))
      .filter(r => r > 0);
    if (rpms.length > 0) {
      result.fan.rpm = Math.max(...rpms);
    }
  }

  return result;
}

// ── 网络真满量程：NIC Connection Speed（链路速率）解析 ──
// LHM 的 "Connection Speed" 是 NIC 硬件下独立传感器（与 throughput 上下行不同），
// 单位为 bit（Kbps/Mbps/Gbps），需 ÷8 转成字节 B/s。按名称在同 NIC 节点内定位。

// 解析 Connection Speed 字符串（如 "1 Gbit/s" / "1000 Mbps" / "100 Mbit/s"）→ 字节 B/s
function parseLinkSpeedToBytes(str) {
  // 去掉千位分隔符（如 "1,000 Mbps"）：否则正则只吃到 "1" → 满量程被算成 0.125 B/s → 环形恒满
  const s = ((typeof str === 'string') ? str : String(str == null ? '' : str)).replace(/,/g, '');
  const m = s.match(/([\d.]+)\s*(k|m|g)?/i);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  if (!isFinite(num)) return 0;
  const prefix = (m[2] || '').toLowerCase();
  let multiplier = 1;
  if (prefix === 'k') multiplier = 1e3;
  else if (prefix === 'm') multiplier = 1e6;
  else if (prefix === 'g') multiplier = 1e9;
  // 默认 bit 单位（LHM Connection Speed 为 bit 单位）；仅当显式出现 "byte" 才按字节处理
  const isBytes = /\bbyte\b/i.test(s);
  const bitsPerSec = num * multiplier;
  return isBytes ? bitsPerSec : bitsPerSec / 8;
}

// 在 NIC 节点子树内按名称定位 "Connection Speed" 传感器
function findConnectionSpeedSensor(nicNode) {
  let found = null;
  walkSensors(nicNode, (sensor) => {
    if (!found && ((sensor.Text || '').toLowerCase().includes('connection speed') || (sensor.Text || '').toLowerCase().includes('link speed'))) {
      found = sensor;
    }
  });
  return found;
}

// 取某 NIC 节点的 Connection Speed（字节 B/s），无则 0
function getNicConnectionSpeedBytes(nicNode) {
  const cs = findConnectionSpeedSensor(nicNode);
  if (!cs) return 0;
  return parseLinkSpeedToBytes(cs.Value);
}

// ── 由 Network Utilization 反解 NIC 链路速率 ──────────────────────────────
// 背景见文件顶部常量区注释：LHM 不暴露 NetworkInterface.Speed，但利用率公式可反解。

// 从 SensorId 提取 NIC 归属键：'/nic/{GUID}/throughput/7' → '/nic/%7bguid%7d'
function nicKeyOf(sensorId) {
  const m = String(sensorId || '').match(/^\/nic\/[^/]+/i);
  return m ? m[0].toLowerCase() : null;
}

// 松散数值解析（RawValue 可能是 '86090.3 B/s' 这类带单位字符串）
function parseNumericLoose(val) {
  if (typeof val === 'number') return val;
  const m = String(val == null ? '' : val).replace(/,/g, '').match(/-?[\d.]+/);
  return m ? parseFloat(m[0]) : NaN;
}

// 吸附到标准链路速率（1 Gbps 这类整数档最有价值）；超出容差则原样返回（如 Wi-Fi 协商速率）
function snapToStandardLinkBps(bps) {
  if (!(bps > 0)) return 0;
  let best = 0, bestErr = Infinity;
  for (let i = 0; i < STANDARD_LINK_MBPS.length; i++) {
    const cand = STANDARD_LINK_MBPS[i] * 1e6;
    const err = Math.abs(cand - bps) / cand;
    if (err < bestErr) { bestErr = err; best = cand; }
  }
  return (bestErr <= NET_LINK_SNAP_TOLERANCE) ? best : bps;
}

// 遍历 LHM 原始 JSON，逐 NIC 反解链路速率，取所有 NIC 中最大者（B/s）；0 = 本次无法反解
// 逐 NIC 配对是必须的：up/down/util 必须来自同一张网卡，跨网卡组合会算出无意义的数值。
function inferLinkSpeedFromReport(root) {
  if (!root || !root.Children) return 0;
  const byNic = new Map();

  (function walk(node) {
    if (!node || !node.Children) return;
    for (const child of node.Children) {
      const key = nicKeyOf(child.HardwareId);
      if (key) {
        const rec = { up: 0, down: 0, util: 0, hasUtil: false };
        (function collect(n) {
          if (!n || !n.Children) return;
          for (const s of n.Children) {
            const sid = String(s.SensorId || '').toLowerCase();
            if (sid.endsWith('/throughput/7')) {
              rec.up += (s.RawValue !== null && s.RawValue !== undefined) ? parseNumericLoose(s.RawValue) : parseThroughputValue(s.Value);
            } else if (sid.endsWith('/throughput/8')) {
              rec.down += (s.RawValue !== null && s.RawValue !== undefined) ? parseNumericLoose(s.RawValue) : parseThroughputValue(s.Value);
            } else if (sid.endsWith('/load/1')) {
              rec.util = parseNumericLoose(s.Value); rec.hasUtil = true;
            }
            collect(s);
          }
        })(child);
        byNic.set(key, rec);
      }
      walk(child);
    }
  })(root);

  let maxBpsBits = 0;
  for (const rec of byNic.values()) {
    if (!rec.hasUtil) continue;
    if (rec.util < NET_LINK_MIN_UTIL_PCT || rec.util > NET_LINK_MAX_UTIL_PCT) continue;
    const bits = (rec.up + rec.down) * 8;
    if (!isFinite(bits) || bits <= 0) continue;
    const link = snapToStandardLinkBps(bits / (rec.util / 100));
    if (link > maxBpsBits) maxBpsBits = link;
  }
  // 内部按 bit/s 计算（标准档位表是 Mbps），返回前 ÷8 统一为 B/s，与 graphMaxBps / connectionSpeed 字段口径一致
  return maxBpsBits / 8;
}

// 链路速率观测状态（机器级属性，与具体 action 无关，故用模块级状态）
const _linkObs = { locked: 0, candidate: 0, hits: 0 };

// 投入一次观测（B/s，0 = 本次无效），返回当前锁定的链路速率（B/s，0 = 尚未锁定）。
// 需要连续 NET_LINK_CONFIRM_HITS 次一致才切换：单次反解仍受 util 一位小数影响，不能直接采信。
function observeLinkSpeed(observedBps) {
  if (!(observedBps > 0)) return _linkObs.locked;           // 空闲样本不参与，也不清空已有结论
  if (observedBps === _linkObs.locked) { _linkObs.candidate = 0; _linkObs.hits = 0; return _linkObs.locked; }
  if (observedBps === _linkObs.candidate) _linkObs.hits++;
  else { _linkObs.candidate = observedBps; _linkObs.hits = 1; }
  if (_linkObs.hits >= NET_LINK_CONFIRM_HITS) {
    _linkObs.locked = observedBps;
    _linkObs.candidate = 0; _linkObs.hits = 0;
  }
  return _linkObs.locked;
}

// 网络环满量程解析 → { bps, source }
//   source: 'user' 用户面板指定 | 'link-sensor' LHM 直供 | 'link-inferred' Utilization 反解 | 'fallback' 兜底
function resolveNetMaxBps(config, monitorType, sensorBps, inferredBps) {
  const key = (monitorType === 'network-up') ? 'netMaxUpMbps' : 'netMaxDownMbps';
  const userMbps = parseFloat(config ? config[key] : NaN);
  if (isFinite(userMbps) && userMbps > 0) return { bps: userMbps * 1e6 / 8, source: 'user' };
  if (sensorBps > 0) return { bps: sensorBps, source: 'link-sensor' };
  if (inferredBps > 0) return { bps: inferredBps, source: 'link-inferred' };
  return { bps: NET_LINK_FALLBACK_BPS, source: 'fallback' };
}

// ── 网卡节点收集与选择 ────────────────────────────────────
// 收集所有 NIC 节点（HardwareId 含 /nic/，如 /nic/0、/nic/1）
function collectNicNodes(node, out) {
  if (!node || !node.Children) return;
  for (const child of node.Children) {
    if ((child.HardwareId || '').toLowerCase().includes('/nic/')) out.push(child);
    collectNicNodes(child, out);
  }
}
// 网卡选择：Auto（空）= 全部；指定且存在 = 仅该张；指定但当前不存在 = 回退全部（避免永久 0）
function selectNicNodes(nicNodes, selectedNicId) {
  if (!selectedNicId) return nicNodes;
  const hit = nicNodes.filter(n => n.HardwareId === selectedNicId);
  return hit.length > 0 ? hit : nicNodes;
}

// LHM NIC Throughput 求和（Auto = 所有网卡上行/下行 Throughput 累加；指定网卡 = 仅该张）
function extractNetworkFromLHM(root, selectedNicId) {
  if (!root || !root.Children) return { up: 0, down: 0, upUnit: 'MB/s', downUnit: 'MB/s', connectionSpeed: 0 };
  let totalUp = 0, totalDown = 0, linkSpeedBytes = 0;

  const nicNodes = [];
  collectNicNodes(root, nicNodes);
  for (const nic of selectNicNodes(nicNodes, selectedNicId)) {
    const tpSensors = collectSensors(nic, 'Throughput');
    for (const s of tpSensors) {
      const sid = (s.SensorId || '').toLowerCase();
      // 优先用 RawValue（LHM 输出的真实 B/s 数字），缺失时回退解析 Value 字符串（按单位还原 B/s）
      const val = (s.RawValue !== null && s.RawValue !== undefined)
        ? parseRaw(s.RawValue)
        : parseThroughputValue(s.Value);
      if (sid.endsWith('/throughput/7')) totalUp += val;
      if (sid.endsWith('/throughput/8')) totalDown += val;
    }
    // 同 NIC 节点的链路速率（Connection Speed 或 Link Speed，bit 单位）→ 字节 B/s；
    // 取选中网卡中的【最大】链路速率作为网络 chart 真满量程（多网卡累加成错，见 BugFix 说明）
    const _cs = getNicConnectionSpeedBytes(nic);
    if (_cs > linkSpeedBytes) linkSpeedBytes = _cs;
  }

  // 以 B/s 累加后统一按字节单位缩放，避免二次换算丢精度
  const up = formatThroughput(totalUp);
  const down = formatThroughput(totalDown);
  return {
    up: up.value,
    down: down.value,
    upUnit: up.unit,
    downUnit: down.unit,
    connectionSpeed: linkSpeedBytes,  // 选中 NIC 的链路速率（字节 B/s）
  };
}

// ========= 传感器引用缓存（T-C：避免每 tick 全树遍历）=========
// 每 tick 仅 1 次建索引 + 按 SensorId 直读；缺失或 TTL 到期回退原慢路径，数值 100% 等价
let _sensorIndex = null;   // Map<SensorId, sensorNode>
let _roleIds = null;       // 各角色命中的 SensorId 选择列表
let _indexTick = 0;
const SENSOR_TTL = 60;     // 每 60 tick 强制重校验拓扑

// 节点匹配辅助（返回 node，而非 value，便于记录 SensorId）
function matchNodeBySensorId(sensors, ...suffixes) {
  for (const suffix of suffixes) {
    for (const s of sensors) {
      if (s.SensorId && s.SensorId.endsWith(suffix)) return s;
    }
  }
  return null;
}
function matchExactNode(sensors, typeName, ...exactNames) {
  for (const name of exactNames) {
    const lower = name.toLowerCase();
    for (const s of sensors) {
      if (s.Type === typeName && (s.Text || '').toLowerCase() === lower) return s;
    }
  }
  return null;
}
function firstPositiveLoadNode(sensors) {
  for (const s of sensors) {
    if (s.Type === 'Load') {
      const v = parseValue(s.Value);
      if (v > 0) return s;
    }
  }
  return null;
}
// iGPU 兜底：返回同节点下所有 Load 传感器中值最大者的 SensorId（无则 null）
function maxLoadSensorId(loadSensors) {
  let maxVal = -1, maxId = null;
  for (const s of (loadSensors || [])) {
    const v = parseValue(s.Value);
    if (v > maxVal) { maxVal = v; maxId = s.SensorId; }
  }
  return maxId;
}
function sidOf(node) {
  return (node && node.SensorId) ? node.SensorId : null;
}
// 收集所有 Fan 传感器（对应 parseLHMJson 的 collectFanNodes）
function collectAllFanSensors(node, out) {
  if (!node || !node.Children) return;
  for (const child of node.Children) {
    const sensors = collectSensors(child, 'Fan');
    if (sensors.length > 0) out.push(...sensors);
    collectAllFanSensors(child, out);
  }
}
// 通用 GPU 节点发现（对应 parseLHMJson 的 findGPU）
function findGpuNode(root) {
  if (!root || !root.Children) return null;
  for (const child of root.Children) {
    if (child.HardwareId && (child.HardwareId.toLowerCase().includes('/gpu') ||
        (child.Text || '').toLowerCase().includes('radeon') ||
        (child.Text || '').toLowerCase().includes('nvidia'))) {
      return child;
    }
    const found = findGpuNode(child);
    if (found) return found;
  }
  return null;
}
// 收集 NIC throughput 的 up/down SensorId（选取语义与 extractNetworkFromLHM 保持一致）
function collectNicThroughput(root, upOut, downOut, linkOut, selectedNicId) {
  if (!root || !root.Children) return;
  const nicNodes = [];
  collectNicNodes(root, nicNodes);
  for (const nic of selectNicNodes(nicNodes, selectedNicId)) {
    const tpSensors = collectSensors(nic, 'Throughput');
    for (const s of tpSensors) {
      const sid = (s.SensorId || '').toLowerCase();
      if (sid.endsWith('/throughput/7')) upOut.push(s.SensorId);
      if (sid.endsWith('/throughput/8')) downOut.push(s.SensorId);
    }
    // 同 NIC 节点的 Connection Speed 传感器（链路速率），用于网络真满量程（与慢路径 100% 一致）
    const cs = findConnectionSpeedSensor(nic);
    if (cs && cs.SensorId) linkOut.push(cs.SensorId);
  }
}

// 迭代式建索引（避免递归/回调开销），存储 node 引用；索引仅用于拓扑检测与按 sid 直读，
// 数值在 readFastPath 中按需 parseValue（仅 ~30 个被引用 sid，远少于全树 384 个）。
function buildSensorIndex(root) {
  const m = new Map();
  if (!root || !root.Children) return m;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    const ch = node.Children;
    if (!ch || !ch.length) continue;
    for (let i = 0; i < ch.length; i++) {
      const child = ch[i];
      if (child.Type && child.SensorId) m.set(child.SensorId, child);
      if (child.Children && child.Children.length) stack.push(child);
    }
  }
  return m;
}

// 与 discoverRoleIds 配合：忽略 null/空（硬件本就不存在），仅当记录的非空 SensorId 在"当前 raw 新索引"中缺失时判定拓扑变化
// 说明：相比原规格的 `!sid ||` 改为仅检查非空 sid，避免"硬件不存在"导致每 tick 重建索引而引入额外开销，
// 且快路径对缺失角色返回与原慢路径一致的 0，行为等价。
function roleIdsAllPresent(roleIds, index) {
  if (!roleIds) return false;
  const check = (x) => {
    if (typeof x === 'string') return !x || !!index.get(x);
    if (Array.isArray(x)) {
      for (const sid of x) if (!check(sid)) return false;
    } else if (x && typeof x === 'object') {
      for (const k of Object.keys(x)) if (!check(x[k])) return false;
    }
    return true;
  };
  return check(roleIds);
}

// 复用原 parseLHMJson / extractNetworkFromLHM 的匹配顺序，仅记录命中的 SensorId 选择列表
// 每个"选择列表"对应原函数中一个 `findBySensorId(...) || findExactSensor(...)` 的 || 链：
// 列表元素按优先级排列，readFastPath 在读取时按 `||` 语义取首个非空（非零）值。
function discoverRoleIds(raw, selectedGpuId) {
  const roleIds = {
    cpu:    { temp: [], load: [], clock: [], power: [] },
    cpuTempFallback: [],
    gpu:    { temp: [], load: [], power: [], clock: [], memUsed: [], memTotal: [], memFree: [] },
    memory: { percent: [], used: [], available: [] },
    fan:    [],
    network: { up: [], down: [], linkSpeed: [] },
  };
  if (!raw || !raw.Children) return roleIds;

  // ── CPU ──
  const cpuNode = resolveCpuNode(raw, _selectedCpuId);
  if (cpuNode) {
    const tempSensors  = collectSensors(cpuNode, 'Temperature');
    const loadSensors  = collectSensors(cpuNode, 'Load');
    const clockSensors = collectSensors(cpuNode, 'Clock');
    const powerSensors = collectSensors(cpuNode, 'Power');
    roleIds.cpu.temp.push(
      sidOf(matchNodeBySensorId(tempSensors, '/temperature/2', '/temperature/0')),
      sidOf(matchExactNode(tempSensors, 'Temperature', 'Core (Tctl/Tdie)', 'CPU Package', 'Core Max'))
    );
    roleIds.cpu.load.push(
      sidOf(matchNodeBySensorId(loadSensors, '/load/0')),
      sidOf(matchExactNode(loadSensors, 'Load', 'CPU Total'))
    );
    roleIds.cpu.clock.push(
      sidOf(matchNodeBySensorId(clockSensors, '/clock/1', '/clock/0')),
      sidOf(matchExactNode(clockSensors, 'Clock', 'Cores (Average)', 'Core Average'))
    );
    roleIds.cpu.power.push(
      sidOf(matchNodeBySensorId(powerSensors, '/power/0')),
      sidOf(matchExactNode(powerSensors, 'Power', 'Package', 'CPU Package'))
    );
  }
  // CPU 温度后备（主板 SuperIO）：仅当主 temp 未命中任何 SensorId 时记录
  if (!roleIds.cpu.temp.length || roleIds.cpu.temp.every((s) => !s)) {
    const lpcNode = findHardwareNode(raw, '/lpc/');
    if (lpcNode) {
      const lpcTempSensors = collectSensors(lpcNode, 'Temperature');
      roleIds.cpuTempFallback.push(sidOf(matchExactNode(lpcTempSensors, 'Temperature', 'CPU')));
    }
  }

  // ── GPU ──
  let gpuNode = selectedGpuId
    ? findHardwareNodeById(raw, selectedGpuId)
    : (findHardwareNode(raw, '/gpu-amd/') ||
       findHardwareNode(raw, '/gpu-nvidia/') ||
       findHardwareNode(raw, '/nvgpu/') ||
       findHardwareNode(raw, '/amdgpu/') ||
       findHardwareNode(raw, '/gpu-intel-integrated/') ||
       findHardwareNode(raw, '/gpu-intel/'));
  if (!gpuNode) gpuNode = findGpuNode(raw);
  if (gpuNode) {
    const tempSensors = collectSensors(gpuNode, 'Temperature');
    const loadSensors = collectSensors(gpuNode, 'Load');
    const powerSensors = collectSensors(gpuNode, 'Power');
    const clockSensors = collectSensors(gpuNode, 'Clock');
    const smallDataSensors = collectSensors(gpuNode, 'SmallData');
    roleIds.gpu.temp.push(
      sidOf(matchNodeBySensorId(tempSensors, '/temperature/0')),
      sidOf(matchExactNode(tempSensors, 'Temperature', 'GPU Core', 'GPU Hot Spot'))
    );
    roleIds.gpu.load.push(
      sidOf(matchNodeBySensorId(loadSensors, '/load/0')),
      sidOf(matchExactNode(loadSensors, 'Load', 'GPU Core')),
      maxLoadSensorId(loadSensors) // iGPU 兜底：同节点所有 Load 传感器最大值（已为 SensorId，勿用 sidOf 包裹）
    );
    roleIds.gpu.power.push(
      sidOf(matchNodeBySensorId(powerSensors, '/power/3', '/power/0')),
      sidOf(matchExactNode(powerSensors, 'Power', 'GPU Package', 'GPU Power'))
    );
    roleIds.gpu.clock.push(
      sidOf(matchNodeBySensorId(clockSensors, '/clock/0')),
      sidOf(matchExactNode(clockSensors, 'Clock', 'GPU Core'))
    );
    roleIds.gpu.memUsed.push(
      sidOf(matchNodeBySensorId(smallDataSensors, '/smalldata/0')),
      sidOf(matchExactNode(smallDataSensors, 'SmallData', 'GPU Memory Used'))
    );
    roleIds.gpu.memTotal.push(
      sidOf(matchNodeBySensorId(smallDataSensors, '/smalldata/2')),
      sidOf(matchExactNode(smallDataSensors, 'SmallData', 'GPU Memory Total'))
    );
    roleIds.gpu.memFree.push(
      sidOf(matchNodeBySensorId(smallDataSensors, '/smalldata/1')),
      sidOf(matchExactNode(smallDataSensors, 'SmallData', 'GPU Memory Free'))
    );
  }

  // ── 内存 ──
  const memNode = findHardwareNode(raw, '/ram');
  if (memNode) {
    const loadSensors = collectSensors(memNode, 'Load');
    const dataSensors = collectSensors(memNode, 'Data');
    let usedNode = null, availNode = null, memTextNode = null;
    for (const s of loadSensors) {
      if ((s.Text || '').toLowerCase().includes('memory')) memTextNode = memTextNode || s;
    }
    roleIds.memory.percent.push(sidOf(memTextNode), sidOf(firstPositiveLoadNode(loadSensors)));
    for (const s of dataSensors) {
      const text = (s.Text || '').toLowerCase();
      if (text.includes('used') && !text.includes('available')) usedNode = usedNode || s;
      if (text.includes('available')) availNode = availNode || s;
    }
    roleIds.memory.used.push(sidOf(usedNode));
    roleIds.memory.available.push(sidOf(availNode));
  }

  // ── 风扇 ──
  const fanSensors = [];
  collectAllFanSensors(raw, fanSensors);
  // 手动选择单个风扇时只记录该 SensorId；Auto 时记录全部（readFastPath 取最大值）
  roleIds.fan = applyFanSelection(
    fanSensors.map((s) => s.SensorId).filter(Boolean),
    _selectedFanId
  );

  // ── 网络 ──
  const netUp = [], netDown = [], netLink = [];
  collectNicThroughput(raw, netUp, netDown, netLink, _selectedNicId);
  roleIds.network.up = netUp;
  roleIds.network.down = netDown;
  roleIds.network.linkSpeed = netLink;

  return roleIds;
}

// 按已记录的 SensorId 选择列表直读数值，复用原 parseLHMJson / extractNetworkFromLHM 的算术语义
function readFastPath(index, roleIds) {
  if (!index || !roleIds) return null;

  const result = {
    cpu:    { load: 0, temp: 0, clock: 0, power: 0 },
    gpu:    { load: 0, temp: 0, memUsed: 0, memTotal: 0, power: 0, clock: 0 },
    memory: { percent: 0, used: 0, total: 0 },
    fan:    { rpm: 0 },
    network: { up: 0, down: 0, upUnit: 'MB/s', downUnit: 'MB/s' },
    source: 'librehardwaremonitor',
  };

  // 按选择列表取首个非零值，等价原 findBySensorId || findExactSensor 的 || 语义
  const readChoice = (choices) => {
    let acc = 0;
    for (const sid of (choices || [])) {
      const n = sid ? index.get(sid) : null;
      const v = n ? parseValue(n.Value) : 0;
      acc = acc || v;
    }
    return acc;
  };

  // CPU
  result.cpu.temp = readChoice(roleIds.cpu.temp) || readChoice(roleIds.cpuTempFallback);
  result.cpu.load = readChoice(roleIds.cpu.load);
  result.cpu.clock = Math.round(readChoice(roleIds.cpu.clock));
  result.cpu.power = readChoice(roleIds.cpu.power);

  // GPU
  result.gpu.temp = readChoice(roleIds.gpu.temp);
  result.gpu.load = readChoice(roleIds.gpu.load);
  result.gpu.power = readChoice(roleIds.gpu.power);
  result.gpu.clock = Math.round(readChoice(roleIds.gpu.clock));
  result.gpu.memUsed = Math.round(readChoice(roleIds.gpu.memUsed) / 10.24) / 100;
  result.gpu.memTotal = Math.round(readChoice(roleIds.gpu.memTotal) / 10.24) / 100;
  if (result.gpu.memTotal === 0 && result.gpu.memUsed > 0) {
    const memFree = Math.round(readChoice(roleIds.gpu.memFree) / 10.24) / 100;
    if (memFree > 0) {
      result.gpu.memTotal = Math.round((result.gpu.memUsed + memFree) * 100) / 100;
    }
  }

  // 内存
  result.memory.percent = readChoice(roleIds.memory.percent);
  const memUsed = readChoice(roleIds.memory.used);
  const memAvailable = readChoice(roleIds.memory.available);
  result.memory.used = memUsed;
  result.memory.total = memUsed + memAvailable;
  if (result.memory.total === 0 && result.memory.percent > 0) {
    result.memory.total = Math.round(result.memory.used / result.memory.percent * 100) / 100;
  }

  // 风扇：所有 Fan rpm 取最大值
  if (roleIds.fan && roleIds.fan.length > 0) {
    const rpms = roleIds.fan.map((sid) => {
      const n = sid ? index.get(sid) : null;
      return n ? parseValue(n.Value) : 0;
    }).filter((r) => r > 0);
    if (rpms.length > 0) result.fan.rpm = Math.max(...rpms);
  }

  // 网络：up/down 各自累加（优先 RawValue 真实 B/s，回退 Value 字符串并按单位还原）
  let totalUp = 0, totalDown = 0;
  for (const sid of (roleIds.network.up || [])) {
    const n = index.get(sid);
    if (n) totalUp += (n.RawValue !== null && n.RawValue !== undefined) ? parseRaw(n.RawValue) : parseThroughputValue(n.Value);
  }
  for (const sid of (roleIds.network.down || [])) {
    const n = index.get(sid);
    if (n) totalDown += (n.RawValue !== null && n.RawValue !== undefined) ? parseRaw(n.RawValue) : parseThroughputValue(n.Value);
  }
  // 以 B/s 累加后统一按字节单位缩放，避免二次换算丢精度
  const netUp = formatThroughput(totalUp);
  const netDown = formatThroughput(totalDown);
  // 同 NIC 的 Connection Speed（bit 单位）→ 字节 B/s，作为网络 chart 真满量程（与慢路径 100% 一致）
  let linkSpeedBytes = 0;
  for (const sid of (roleIds.network.linkSpeed || [])) {
    const n = index.get(sid);
    // 多网卡：取【最大】链路速率作为真满量程（不再累加，避免虚拟/慢速网卡压低量程）
    if (n) { const _cs = parseLinkSpeedToBytes(n.Value); if (_cs > linkSpeedBytes) linkSpeedBytes = _cs; }
  }
  result.network = {
    up: netUp.value,
    down: netDown.value,
    upUnit: netUp.unit,
    downUnit: netDown.unit,
    connectionSpeed: linkSpeedBytes,  // 字节 B/s
  };

  return result;
}

// 统一解析入口：命中缓存则快路径直读，否则回退原慢路径（行为 100% 等价）
function resolveLHM(raw, settings) {
  // 每 tick 仅一次轻量建索引（单次 walk）；用"当前 raw 的新索引"做拓扑检测，
  // 避免旧实现中拿"上一次缓存在同一历史 tick 的 _roleIds 与 _sensorIndex 互比"而永远为 true、
  // 导致传感器消失后最多 60 tick 才重建（样例 D：移除 CPU Load 仍返回陈旧值）。
  const selectedGpuId = (settings && settings.gpuId) ? settings.gpuId : _selectedGpuId;
  const newIndex = buildSensorIndex(raw);
  const topoChanged = !_roleIds ||
    (++_indexTick % SENSOR_TTL === 0) || !roleIdsAllPresent(_roleIds, newIndex);
  if (topoChanged) {
    _sensorIndex = newIndex;
    _roleIds = discoverRoleIds(raw, selectedGpuId);   // 拓扑变化：重发现（昂贵，仅在变化时发生）
  } else {
    _sensorIndex = newIndex;           // 拓扑稳定：仍用当前索引，数值变化即时可见
  }
  const fast = readFastPath(_sensorIndex, _roleIds);
  let data;
  if (!fast) {
    const parsed = parseLHMJson(raw, selectedGpuId);
    _roleIds = discoverRoleIds(raw, selectedGpuId);
    data = { ...parsed, network: extractNetworkFromLHM(raw, _selectedNicId) };
  } else {
    data = fast;
  }
  // 附加链路速率：两条路径（快/慢）都经此处，保证语义一致
  return attachNetworkLinkSpeed(data, raw);
}

// 把链路速率（B/s）挂到 network 上，供 _handleData 解析网络环满量程。
// LHM 无 Connection Speed 传感器，故由 Utilization 反解；需多帧一致才锁定（见 observeLinkSpeed）。
function attachNetworkLinkSpeed(data, raw) {
  const inferred = observeLinkSpeed(inferLinkSpeedFromReport(raw));
  data.network = Object.assign({}, data.network, {
    linkSpeedBps: inferred,                                  // 反解锁定后的链路速率（B/s），0 = 未知
    linkSpeedSource: inferred > 0 ? 'util-inference' : 'none',
  });
  return data;
}

// ========= 全局数据管道（发布-订阅 + Promise 去重）=========
let _pendingFetch = null;           // 进行中的 fetch Promise（去重用）
const _dataSubscribers = new Set(); // callback 集合
let _globalTimer = null;            // 全局轮询定时器
let _globalInterval = 1000;         // 全局轮询间隔（可经 setRefreshInterval 调整，默认 1000ms）

// 获取数据（直连 LHM HTTP API，带 Promise 去重）
async function fetchHardwareData() {
  if (_pendingFetch) return _pendingFetch;

  _pendingFetch = (async () => {
    try {
      const res = await fetch(LHM_URL, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const resolved = resolveLHM(raw);
      return {
        success: true,
        ...resolved,
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
  }, _globalInterval);
}

function stopGlobalTimer() {
  if (_globalTimer) { clearInterval(_globalTimer); _globalTimer = null; }
}

// T-F：可配置刷新间隔（本期不接 UI，保持默认 1000ms）
// 调用即 clamp 到 250–5000ms 并重启定时器；未变化时直接返回
function setRefreshInterval(ms) {
  const clamped = Math.max(250, Math.min(5000, Math.round(ms) || 1000));
  if (clamped === _globalInterval) return;
  _globalInterval = clamped;
  if (_globalTimer) { stopGlobalTimer(); startGlobalTimer(); }
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
  enableSharpen: false,        // 是否启用图标锐化（默认关闭，省去每 tick 的卷积计算）

  // ── 手动硬件选择（空字符串 = Auto，由插件自动挑一个）──
  cpuId: '',                   // CPU HardwareId（如 /amdcpu/0、/intelcpu/0）
  gpuId: '',                   // GPU HardwareId（多显卡场景指定用哪张）
  fanId: '',                   // Fan 传感器 SensorId（多个风扇时指定读哪一个）
  nicId: '',                   // 网卡 HardwareId（如 /nic/0；Auto = 所有网卡累加）

  // ── 非百分比控件的满量程（0 = Auto 自动；> 0 = 自定义固定量程，单位见 SCALE_PARAM）──
  tempMaxC: 0,                 // 温度满量程 °C
  powerMaxW: 0,                // 功耗 / TDP 满量程 W
  clockMaxMHz: 0,              // 频率满量程 MHz
  memMaxGB: 0,                 // 显存满量程 GB
  ramMaxGB: 0,                 // 内存满量程 GB
  fanMaxRPM: 0,                // 风扇转速满量程 RPM
};

// 监视类型定义（完整对齐 System Vitals）
const MONITOR_TYPES = {
  // 温度
  'cpu-temp':       { title: 'CPUt',    unit: '°C',  category: 'temperature', field: 'cpu.temp',          min: 0,   max: 110, color: '#ff6644' },
  'gpu-temp':       { title: 'GPUt',    unit: '°C',  category: 'temperature', field: 'gpu.temp',          min: 0,   max: 110, color: '#4488ff' },
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

// T-E：背景渐变预缓存（按 valueColor|monitorType 缓存 144×144 offscreen canvas）
// 输出像素与原 drawBackground 完全一致（3 段线性渐变 + 径向高光 + 主色 0.03 叠加），仅把"重建"换成"贴图"
const _bgCache = new Map(); // key: `${valueColor}|${monitorType}` → offscreen canvas
function getCachedBackground(valueColor, monitorType) {
  const k = `${valueColor}|${monitorType}`;
  let cv = _bgCache.get(k);
  if (cv) return cv;
  cv = document.createElement('canvas'); cv.width = 144; cv.height = 144;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, 144, 144);
  g.addColorStop(0, '#0f0f1a'); g.addColorStop(0.5, '#1a1a2e'); g.addColorStop(1, '#0a0a15');
  c.fillStyle = g; c.fillRect(0, 0, 144, 144);
  const rg = c.createRadialGradient(72, 50, 0, 72, 50, 80);
  rg.addColorStop(0, 'rgba(255,255,255,0.05)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = rg; c.fillRect(0, 0, 144, 144);
  c.fillStyle = hexToRgba(valueColor || '#00ffcc', 0.03); c.fillRect(0, 0, 144, 144);
  _bgCache.set(k, cv);
  if (_bgCache.size > 32) _bgCache.clear(); // 超过 32 条时清空重建，避免无限增长
  return cv;
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
  ctx.shadowBlur = 8;

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
  ctx.shadowBlur = 4;
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

  // 网络类型判定：以 category 为准（category 不依赖 config.monitorType，天然免疫该类覆盖问题），
  // monitorType 仅作辅助，双保险防止"KB 以下环形拉满"回归。
  const isNetwork = (category === 'network') ||
    (monitorType === 'network-up' || monitorType === 'network-down');

  const canvas = createCanvas();
  const ctx = canvas.getContext('2d');

  // 0. 彻底清空画布
  ctx.clearRect(0, 0, 144, 144);

  // 1. 渐变背景（T-E：改用预缓存贴图，避免每 tick 重建渐变）
  ctx.drawImage(getCachedBackground(valueColor, monitorType), 0, 0);

  // 2. 图表（根据样式）— 用 save/restore 隔离状态
  ctx.save();
  if (chartStyle === 'ring') {
    // T04c: minimal 预设 showProgress=false 时不绘环和图标
    if (showProgress && max > min) {
      const cx = 72, cy = 68, r = 54;
      let ratio;
      if (isNetwork) {
        // 图形以 B/s 基准归一化；graphMaxBps 在 _handleData 中恒 > 0（未知链路回退 1Gbps）
        const gv = config.graphValueBps || 0, gm = config.graphMaxBps || 1;
        ratio = Math.max(0, Math.min(1, gm > 0 ? gv / gm : 0));
      } else {
        ratio = Math.max(0, Math.min(1, (value - min) / (max - min)));
      }
      drawProgressRing(ctx, cx, cy, r, ratio, { valueColor });
    }
  } else if (chartStyle === 'wave') {
    // 曲线图 — 对 network/diskIO 根据历史数据动态调整 max
    const isNet = isNetwork;
    const chartMax = getChartMax(config, history, isNet ? (config.graphValueBps || 0) : value, min, isNet ? (config.graphMaxBps || max) : max);
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
    const isNet = isNetwork;
    const chartMax = getChartMax(config, history, isNet ? (config.graphValueBps || 0) : value, min, isNet ? (config.graphMaxBps || max) : max);
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

  if (config.enableSharpen) {
    applySharpen(ctx, 144, 144, 1.5);  // 增强4：轻度锐化（默认关闭）
  }

  return canvas.toDataURL('image/png');
}

// ═══════════════════════════════════════════════════════════════
//  图表量程自适应（clock/power 类别）
//  - 维护 per-metric 观测峰值 _observedPeak（模块级，key = monitorType），ring/wave 共用
//  - max = min( max(observedPeak * 1.1, 冷启地板, staticFloor), 硬顶 )
//  - 冷启地板 = 原静态上限 / 10；staticFloor = 绝对下限 0.1（防除零）
//  - 硬顶封死异常尖峰（上限远高于设计静态上限）
//  - 严禁使用 LHM 传感器的 Min/Max 字段（会话运行极值，冷启≈0，会除零/误导）
// ═══════════════════════════════════════════════════════════════
const _observedPeak = {};        // { [monitorType]: number } 平滑观测峰值（MHz / W 等原单位）
const PEAK_DECAY = 0.995;        // 峰值慢速衰减：下降缓慢、上升即时（峰保持）
const ADAPTIVE_ABS_FLOOR = 0.1;  // staticFloor：绝对下限，避免除零
const ADAPTIVE_HARD_CAP = {      // 硬顶：封死异常尖峰
  'cpu-power': 1000,   // W
  'gpu-power': 1500,   // W
  'cpu-clock': 8000,   // MHz
  'gpu-clock': 4000,   // MHz
};

function isAdaptiveMetric(monitorType) {
  return Object.prototype.hasOwnProperty.call(ADAPTIVE_HARD_CAP, monitorType);
}

// 更新观测峰值：上升即时（峰保持），下降按 PEAK_DECAY 缓慢回落，避免瞬时抖动与除零
function updateObservedPeak(monitorType, currentValue) {
  if (!isAdaptiveMetric(monitorType)) return;
  const v = (typeof currentValue === 'number' && isFinite(currentValue)) ? currentValue : 0;
  const prev = _observedPeak[monitorType] ?? 0;
  _observedPeak[monitorType] = v > prev ? v : prev * PEAK_DECAY;
}

// 计算自适应 max（单位与 value 一致：MHz / W）
// max = min( max(observedPeak * 1.1, 冷启地板, staticFloor), 硬顶 )
function getAdaptiveMax(monitorType, staticMax) {
  const peak = _observedPeak[monitorType] ?? 0;
  const coldFloor = (typeof staticMax === 'number' && isFinite(staticMax) && staticMax > 0) ? staticMax / 10 : ADAPTIVE_ABS_FLOOR;
  const dynamicMax = Math.max(peak * 1.1, coldFloor, ADAPTIVE_ABS_FLOOR); // 含 staticFloor
  const cap = ADAPTIVE_HARD_CAP[monitorType] ?? (coldFloor * 4);          // 硬顶封死异常尖峰
  return Math.min(dynamicMax, cap);
}

// 动态计算图表 max 值
// - network/diskIO：沿用历史自适应（network 的 staticMax 已由 Connection Speed 注入，作为真满量程上限）
// - clock/power 等自适应类别：config.max 已在 _handleData 中写入观测峰值自适应值，此处直接返回即可
function getChartMax(config, history, currentValue, staticMin, staticMax) {
  const { category } = config;
  // 仅对 network/diskIO 做动态缩放，其他类别保持静态 max
  if (category !== 'network' && category !== 'diskIO') return staticMax;

  // 网络类：history 已统一为 B/s 基准，满量程用 Connection Speed（graphMaxBps），
  // 未知链路时回退到传入的 staticMax（调用方对 network 已传 graphMaxBps）。
  const baseMax = category === 'network' ? (config.graphMaxBps || staticMax) : staticMax;
  const vals = history && history.length > 0 ? history : [currentValue];
  const historyMax = Math.max(...vals.filter(v => v != null), currentValue);

  // 取 historyMax * 1.5 与 baseMax/10 中的较大值，确保低流量时不贴底
  const dynamicMax = Math.max(historyMax * 1.5, baseMax / 10, 0.1);
  return Math.min(dynamicMax, baseMax); // 不超过链路真满量程
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
    // 【根因修复】DEFAULT_CONFIG.monitorType='cpu-temp'，而 MONITOR_TYPES 各项不含 monitorType，
    // 展开后 config.monitorType 会被覆盖成 'cpu-temp' → drawIcon 走非网络分支，用 (value-min)/(max-min)
    // 即 (B/s 数字)/100 算比例；网速 < 1KB/s 时单位是 B/s、数值可达数百 → 比例必被钳到 1（环形拉满）。
    // 显式把 monitorType 写回 config，保证 drawIcon 走网络分支（graphValueBps/graphMaxBps）。
    this.config = { ...DEFAULT_CONFIG, ...MONITOR_TYPES[this.monitorType], monitorType: this.monitorType };

    // 历史数据（用于曲线图）
    this.history = [];
    this.historyMax = 10;  // T02b: 硬编码 10

    // 渲染缓存 + 脏检查（T-A：值未变化则跳过绘制/编码/发送）
    this._lastRenderKey = null;
    this._lastIcon = null;

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
      let ramTotalGB = 0;   // ram-gb 的动态总量，供下方统一的量程计算使用

      // 根据字段路径读取值
      if (typeInfo.field.startsWith('cpu.')) {
        value = getDataByField(data, typeInfo.field);
      } else if (typeInfo.field.startsWith('gpu.')) {
        value = getDataByField(data, typeInfo.field);
        if (DEBUG && this.monitorType.startsWith('gpu-')) {
          console.log(`[HWDiag] ${this.monitorType}: raw=${value}`);
        }
      } else if (typeInfo.field.startsWith('memory.')) {
        value = getDataByField(data, typeInfo.field);
        // ram-gb 动态总量：这里只记录，不直接写 config.max（统一交给下方"自动量程"一处写）
        if (this.monitorType === 'ram-gb' && data.memory && data.memory.total > 0) {
          ramTotalGB = Math.ceil(data.memory.total);
        }
      } else if (typeInfo.field.startsWith('fan.')) {
        value = getDataByField(data, 'fan.rpm');
      } else if (typeInfo.field.startsWith('network.')) {
        value = getDataByField(data, typeInfo.field);
        // 动态单位：LHM 返回 upUnit/downUnit 元数据（Fix 5: 仅在实际变化时更新）
        const dir = this.monitorType === 'network-up' ? 'up' : 'down';
        const unitKey = dir + 'Unit';
        if (data.network && data.network[unitKey]) {
          if (this.config.unit !== data.network[unitKey]) {
            this.config.unit = data.network[unitKey];
          }
        }
        // 图形渲染统一以字节/秒(B/s)为基准，规避"显示数字 vs max 单位不一致"导致的
        // 低速顶满 / 单位跳变问题。显示数值与单位保持不变（formatValue 仍用缩放后的 value + config.unit）。
        const csBytes = (data.network && data.network.connectionSpeed) || 0;   // LHM 直供（当前版本不提供该传感器，恒 0）
        const inferredBps = (data.network && data.network.linkSpeedBps) || 0;  // 由 Network Utilization 反解
        const graphValueBps = unitToBytes(value, this.config.unit);
        // 满量程解析：用户面板指定 > LHM 链路速率 > 1Gbps 兜底。
        // 不再硬编码 7M/60M —— 那两个数是"宽带上限"，与"网卡链路速率"语义不同，改由用户按需覆盖。
        const nm = resolveNetMaxBps(this.config, this.monitorType, csBytes, inferredBps);
        this.config.graphValueBps = graphValueBps;
        this.config.graphMaxBps = nm.bps;
        this.config.netLimitSource = nm.source;
        this.config.netAutoBps = (csBytes > 0) ? csBytes : inferredBps;  // 自动探测值（不含用户覆盖），供面板展示
        this._pushNetLinkInfo();
      } else if (typeInfo.field.startsWith('diskUsage.')) {
        const idx = parseInt(typeInfo.field.split('.')[1]) || 0;
        const diskUsage = data.diskUsage;
        if (diskUsage && diskUsage[idx]) {
          value = diskUsage[idx].percent;
          extraText = diskUsage[idx].drive || '';
        }
      }

      // ── 量程：每帧先重算「自动量程」并写回 config.max，再叠加「自定义覆盖」──
      // 【关键】自动量程必须每帧重算，不能只在实例构造时算一次。否则用户填过自定义值后
      // 再清空（回到 Auto）时，config.max 会残留上一次的自定义值 —— 静态默认类
      // （cpu-temp / gpu-temp / gpu-mem / fan）没有别的重算路径，表现为"填了数字就回不到 Auto"。
      // 自适应公式 max = min(max(observedPeak*1.1, 冷启地板, staticFloor), 硬顶)；
      // 严禁使用 LHM 传感器的 Min/Max 字段（运行时极值，冷启≈0）。
      let autoMax = typeInfo.max;                                        // 静态默认（MONITOR_TYPES）
      if (this.monitorType === 'ram-gb' && ramTotalGB > 0) {
        autoMax = ramTotalGB;                                            // 内存动态总量
      }
      if (isAdaptiveMetric(this.monitorType)) {
        updateObservedPeak(this.monitorType, value);
        autoMax = getAdaptiveMax(this.monitorType, typeInfo.max);         // 时钟 / 功耗观测峰值自适应
      }
      this.config.max = autoMax;

      // 满量程覆盖：面板填了自定义值则量程固定（TDP / 频率上限 / 温度 / 显存 / 内存 / 转速）。
      // 0 / 空 = Auto，直接沿用上面每帧重算出的自动量程 —— 因此清空后能立刻回到 Auto。
      const scale = SCALE_PARAM[this.monitorType];
      if (scale) {
        const customMax = toPositiveNumber(this.config[scale.key]);
        if (customMax > 0) this.config.max = customMax;
      }

      // 保存最新数值
      this.latestValue = value;
      this.latestExtraText = extraText;

      // 更新历史数据
      if (this.config.showHistory) {
        // 网络类：history 存 B/s 基准值，保证波形图在不同显示单位间不跳变
        const hv = (this.monitorType === 'network-up' || this.monitorType === 'network-down')
          ? (this.config.graphValueBps || 0) : value;
        this.history.push(hv);
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

  _computeRenderKey(value) {
    const c = this.config;
    const displayVal = formatValue(value, c);
    const min = c.min || 0;
    let max = c.max || 1, ratioVal = value, ratioMax = max;
    if (this.monitorType === 'network-up' || this.monitorType === 'network-down') {
      ratioVal = c.graphValueBps || 0; ratioMax = c.graphMaxBps || 1;
    }
    const ratio = Math.max(0, Math.min(1, (ratioVal - min) / (ratioMax - min)));
    return [
      this.monitorType,
      displayVal, c.unit, min, max,
      c.valueColor, c.titleColor,
      c.showProgress ? 1 : 0,
      c.chartStyle,
      this.latestExtraText || '',
      'r' + Math.round(ratio * 100)
    ].join('|');
  }

  updateDisplay() {
    const value = this.latestValue;
    const typeInfo = MONITOR_TYPES[this.monitorType];
    if (!typeInfo) return;
    // wave 模式始终重绘（曲线滚动）；其余模式走脏检查
    if (this.config.chartStyle !== 'wave') {
      const key = this._computeRenderKey(value);
      if (key === this._lastRenderKey && this._lastIcon) return; // 无变化：跳过绘制/编码/发送
      this._lastRenderKey = key;
    }
    const icon = drawIcon(this.config, value, this.latestExtraText, this.history);
    this._lastIcon = icon;
    const bottomText = this.config.title || typeInfo.title || '';
    $UD.setBaseDataIcon(this.context, icon, bottomText);
  }

  // 把「当前生效的带宽上限」「自动探测到的链路速率」「取值来源」推给属性面板。
  // 面板打开后可立即看到自动探测结果，便于判断是否需要手动覆盖。仅在取值变化时推送。
  _pushNetLinkInfo() {
    const info = MONITOR_TYPES[this.monitorType];
    if (!info || info.category !== 'network') return;
    if (typeof $UD.sendToPropertyInspector !== 'function') return;
    const effBps = this.config.graphMaxBps || 0;
    const autoBps = this.config.netAutoBps || 0;
    const source = this.config.netLimitSource || 'fallback';
    const sig = effBps + '|' + autoBps + '|' + source;
    if (sig === this._lastNetPushSig) return;
    this._lastNetPushSig = sig;
    const toMbps = (v) => (v > 0 ? Math.round((v * 8 / 1e6) * 10) / 10 : 0);
    $UD.sendToPropertyInspector({
      type: 'netlink-info',
      effectiveMbps: toMbps(effBps),   // 实际用于归一化的上限
      detectedMbps: toMbps(autoBps),   // 自动探测（LHM 反解）；0 = 尚未探测到
      source: source,                  // user | link-sensor | link-inferred | fallback
    }, this.context);
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

  // 手动硬件选择（CPU / GPU / 风扇 / 网卡）：任一变化即失效角色索引，
  // 下一次 resolveLHM 强制重建，选择立即生效（无需等 SENSOR_TTL 到期）。
  for (const kind of Object.keys(HW_SELECT_KEY)) {
    const cfgKey = HW_SELECT_KEY[kind];
    if (settings[cfgKey] === undefined) continue;
    const next = settings[cfgKey] || '';
    const state = HW_SELECT_STATE[kind];
    if (next === state.get()) continue;
    state.set(next);
    _roleIds = null;
    console.log(`[HardwareMonitor] 硬件选择变化 ${cfgKey}: "${next || 'Auto'}"，已失效角色索引`);
  }

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

  // 回归防护：monitorType 决定 drawIcon 的渲染分支（网络环用 graphValueBps/graphMaxBps 归一化），
  // 不允许被外部 settings/presetParams 覆盖，否则会退回 (value-min)/(max-min) 导致低速环满。
  inst.config.monitorType = inst.monitorType;

  console.log('[HardwareMonitor] 收到设置更新:', settings, 'for monitorType:', inst.monitorType);

  // T-A：配置变化强制失效渲染缓存，下一帧正常重绘
  inst._lastRenderKey = null;
  inst._lastIcon = null;

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

// 事件注册安全包装：本插件随包的 libs/js/ulanziApi.js 并未实现 onWillAppear / onWillDisappear，
// 直接调用会抛 TypeError 并【中断其后所有注册】——曾导致 onDidReceiveSettings 从未生效。
// 存在才注册、缺失则跳过，保证后续注册不被阻塞（模拟器与实机均验证无报错）。
function safeRegisterEvent(name, fn) {
  if (typeof $UD[name] === 'function') { $UD[name](fn); return true; }
  console.warn(`[HardwareMonitor] 当前 SDK 未提供 ${name}，已跳过该事件注册`);
  return false;
}

safeRegisterEvent('onWillAppear', (jsn) => {
  const inst = ACTION_CACHE[jsn.context];
  if (inst) inst.updateDisplay();
});

safeRegisterEvent('onWillDisappear', (jsn) => {
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

// 属性面板每次打开都会主动询问带宽上限：面板与插件启动时机不同步，
// 只靠"取值变化时推送"会漏掉（面板打开时值早已稳定，不会再变化）。
safeRegisterEvent('onSendToPlugin', (jsn) => {
  const payload = jsn && jsn.payload;
  if (!payload || payload.type !== 'netlink-query') return;
  const inst = jsn.context ? ACTION_CACHE[jsn.context] : null;
  if (inst) {
    inst._lastNetPushSig = '';   // 清掉去重标记，强制重推
    inst._pushNetLinkInfo();
  }
});

console.log('[HardwareMonitor] 插件加载完成，支持', Object.keys(MONITOR_TYPES).length, '种数据类型');
