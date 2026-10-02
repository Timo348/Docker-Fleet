# Metrics and log behavior

## CPU

The agent reads Docker's real statistics for running containers. Given current and previous samples:

```text
containerDelta = current.cpu_usage.total_usage - previous.cpu_usage.total_usage
systemDelta    = current.system_cpu_usage - previous.system_cpu_usage
CPU %          = containerDelta / systemDelta × onlineCPUs × 100
```

`onlineCPUs` falls back to the length of Docker's per-CPU usage array. Invalid counters, nonpositive system deltas, counter resets or unavailable CPU counts yield `null` (shown as `—`), not zero. One fully used logical CPU is 100%; multicore work can exceed 100%. This matches Linux Docker CLI-style semantics. The first sample can be unavailable until a usable previous sample exists.

## RAM

```text
RAM bytes = memory_stats.usage - inactive file cache
```

The cache is `total_inactive_file` (cgroup v1) or `inactive_file` (cgroup v2) when present and not greater than usage. Otherwise the actual usage value is retained. A positive Docker `memory_stats.limit` is displayed as the reported limit; Docker may report host memory when no explicit container memory restriction exists. A missing/invalid limit is unavailable. The app does not invent a zero or configured limit.

Stopped containers have no live CPU/RAM values. Health is shown only when Docker reports a healthcheck state; no healthcheck means no `healthy` assertion. Start time comes from Docker's inspected `State.StartedAt`; uptime is computed for a running container. CPU/RAM failures do not create synthetic readings.

Image sizes come from Docker's image inventory. Volume size is always `Unavailable` in this version because no dependable volume-size result is collected. The normal refresh never walks a filesystem.

## Logs

The agent asks Docker for stdout and stderr with timestamps and a bounded `tail`. Non-TTY Docker logs contain an eight-byte multiplex header; the agent decodes it and keeps stdout/stderr attribution across chunk boundaries. TTY logs are a combined raw stream, labeled console because stderr cannot be separated reliably. UTF-8 decoding and partial lines are handled incrementally. Unsupported logging drivers return a readable error rather than silently empty success.

The UI renders plain escaped text, never HTML. Control/terminal escape sequences are removed, not executed. Search/filter operates on the bounded visible buffer. Copy and download use that current text excerpt; they do not download the container's full historical log file. Pausing ends the current live stream; resuming opens a new bounded stream. Closing/leaving the log view aborts the browser request and upstream Docker stream. A finite stream expiry allows a user to resume with a new authenticated request.

## Default bounds

| Limit                             |           Central app example |    Agent template |
| --------------------------------- | ----------------------------: | ----------------: |
| Default tail                      |                     200 lines |  Requested by app |
| Maximum tail                      |                    5000 lines |        5000 lines |
| Buffer / non-follow excerpt bytes |                         2 MiB | 2 MiB per request |
| Live cumulative transfer          | Bounded by duration and agent | 2 MiB per request |
| Maximum line                      |                        64 KiB |            64 KiB |
| Concurrent streams per user       |                             2 |    Not user-aware |
| Total concurrent streams          |                             8 |       4 per agent |
| Maximum stream duration           |                   600 seconds |       600 seconds |

Both sides enforce their own line, concurrency and duration bounds; the stricter limit wins. The UI keeps a bounded rolling buffer. The central service also bounds a non-follow excerpt's total bytes, while live follow is limited by its memory buffer and duration. The agent caps cumulative transferred bytes for both modes. Truncated lines and deliberate stream end are reported; reconnecting is an explicit request. Large quantities of output may hit the agent byte limit before the duration limit. Changing log settings or disabling/changing a host connection closes affected streams.

Host inventory and statistic updates run on separate configured intervals. A host failure labels its previously collected values stale and displays the last successful update. Stale monitoring is not a fresh measurement and should not be used to infer current state. Actions route by the selected host ID and full resource ID, regardless of matching display names on another host.
