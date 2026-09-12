# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.4] - 2026-09-12

> 2.0.2 and 2.0.3 were never published as separate releases — everything below ships together in 2.0.4.

### Added

- **Per-control settings.** The Property Inspector now adapts to the action being configured. A
  hardware selector, a full-scale override, and the network bandwidth cap are shown only for the
  actions they actually apply to — one page, sections revealed by action type.
- **Hardware selection** — pick a specific CPU, GPU, fan or network adapter reported by
  LibreHardwareMonitor, or leave it on `Auto`. Persisted as `cpuId` / `gpuId` / `fanId` / `nicId`.
- **Custom full-scale ranges** for non-percentage metrics, with the unit shown inline:
  CPU/GPU temperature (°C), CPU/GPU power (W), CPU/GPU clock (MHz), GPU VRAM (GB),
  RAM used (GB) and fan speed (RPM). Empty field = `Auto`.
- **Configurable network bandwidth cap** (`netMaxUpMbps` / `netMaxDownMbps`, in Mbps), so the ring
  can be normalised to your broadband plan instead of the raw NIC link rate.

### Changed

- Removed the hard-coded `USER_NET_MAX_BPS` cap (previously 7 Mbps up / 60 Mbps down).
- Full-scale resolution is now a three-tier chain: user setting → NIC link rate inferred from
  LHM's Network Utilization sensor → 1 Gbps fallback.
- The network ring normalises against the resolved cap; the wave chart keeps its own adaptive
  range so it does not hug the baseline at low traffic.
- Dropped the obsolete auto-detection hint block from the Property Inspector.

### Fixed

- **Full-scale could not be returned to `Auto`.** After typing a custom value into a full-scale
  field and then clearing it, `cpu-temp` / `gpu-temp` / `gpu-mem` / `fan` kept drawing against the
  stale custom maximum. The automatic range is now recomputed on every sample, with the custom
  override layered on top.
- **GPU selection was silently discarded** when saving the Property Inspector, because the preset
  parameter list was rebuilt with an exclude list instead of a whitelist.
- **Dynamic labels rendered in English on first paint** — the SDK emits `CONNECTED` before
  asynchronous localisation finishes. Labels are now re-applied once localization is ready.

## [2.0.0] - 2026-07-05

### Added

- Initial release of Hardware Monitor plugin
- CPU temperature monitoring action
- GPU monitoring action
- Memory usage monitoring action
- Fan speed monitoring action
- Network speed monitoring action
- Multi-language support: English, 简体中文, 繁體中文, Deutsch, Español, 日本語, 한국어, Português

[2.0.4]: https://github.com/zza199910/Hardware-Monitor-Ulanzi-Deck-/tree/v2.0.4
[2.0.0]: https://github.com/zza199910/Hardware-Monitor-Ulanzi-Deck-/tree/v2.0.0
