// Serialized as a standalone function so results.html works offline, including file://.
/** Browser entry point for results.html: wires the tabs, selectors and the zoomable waveform/eye canvas to the embedded data. */
export function viewerClient(): void {
  type Eye = { name: string; simulationVoltageProbeId: string; unitIntervalSeconds: number; windowOriginsSeconds: number[]; metrics?: unknown; alignment?: string; ddrAssessment?: { status: string } }
  type Probe = { name: string; simulationVoltageProbeId: string; column: number; signalSourceId?: string; referenceSourceId?: string | null; signalLabel?: string; referenceLabel?: string }
  type Run = { name: string; rows: number[][]; probes: Probe[]; eyes: Eye[] }
  const data = JSON.parse(document.getElementById('simulation-data')!.textContent!) as { runs: Run[]; limitations: string[]; comparisonProbeName?: string;
    changes?: Array<{quiet:string;active:string;peakAbsoluteV:number;timeRmsV:number;startSeconds:number;endSeconds:number}> }
  /** Looks up a report element by id, typed as the element kind the caller expects. */
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
  const runSelect = $<HTMLSelectElement>('run')
  const probeSelect = $<HTMLSelectElement>('probe')
  const eyeSelect = $<HTMLSelectElement>('eye')
  const overlay = $<HTMLInputElement>('overlay')
  const canvas = $<HTMLCanvasElement>('plot')
  const ctx = canvas.getContext('2d')!
  const colors = ['#2563eb', '#e96535', '#159c80', '#a855d0']
  let mode = 'waveform'
  let xMin = 0
  let xMax = 1
  let fullMin = 0
  let fullMax = 1
  let drag: { x: number; min: number; max: number } | null = null
  let width = 1
  let height = 1
  let plotWidth = 1
  let plotHeight = 1
  let yMin = 0
  let yMax = 1
  const pad = { left: 68, right: 24, top: 28, bottom: 48 }
  /** The experiment currently chosen in the run selector. */
  const selectedRun = (): Run => data.runs[Number(runSelect.value)]
  /** The probe currently chosen in the probe selector, within the selected run. */
  const selectedProbe = (): Probe => selectedRun().probes[Number(probeSelect.value)]
  /** The eye currently chosen in the eye selector, within the selected run. */
  const selectedEye = (): Eye => selectedRun().eyes[Number(eyeSelect.value)]
  /** Binary-searches the time-sorted rows for the first sample at or after `time`. */
  const nearestIndex = (rows: number[][], time: number): number => {
    let a = 0
    let b = rows.length - 1
    while (a < b) {
      const middle = Math.floor((a + b) / 2)
      if (rows[middle][0] < time) a = middle + 1
      else b = middle
    }
    return a
  }
  /** The curves to plot: the selected probe in the selected run, or in every run that has it when overlaying. */
  const series = (): Array<{ run: Run; probe: Probe }> => {
    const probe = selectedProbe()
    return (overlay.checked ? data.runs : [selectedRun()]).flatMap(run => {
      const match = run.probes.find(item => item.name === probe.name)
      return match ? [{ run, probe: match }] : []
    })
  }
  /** Appends one choice to a selector. */
  const option = (parent: HTMLSelectElement, label: string, value: number): void => {
    const item = document.createElement('option')
    item.textContent = label
    item.value = String(value)
    parent.append(item)
  }
  data.runs.forEach((run, i) => option(runSelect, run.name, i))
  overlay.disabled = data.runs.length < 2
  overlay.checked = Boolean(data.changes?.length) && data.runs.length > 1
  /** Refills the probe selector for the chosen run, keeping the previous probe when it still exists. */
  const updateProbes = (): void => {
    const previous = probeSelect.selectedOptions[0]?.textContent ?? data.comparisonProbeName
    probeSelect.replaceChildren()
    selectedRun().probes.forEach((probe, i) => option(probeSelect, probe.name, i))
    const match = selectedRun().probes.findIndex(probe => probe.name === previous)
    if (match >= 0) probeSelect.value = String(match)
    updateEyes()
  }
  /** Refills the eye selector with eyes of the chosen probe; falls back to waveform mode when there are none. */
  const updateEyes = (): void => {
    eyeSelect.replaceChildren()
    selectedRun().eyes.forEach((eye, i) => {
      if (eye.simulationVoltageProbeId === selectedProbe().simulationVoltageProbeId) option(eyeSelect, eye.name, i)
    })
    $('eye-button').toggleAttribute('disabled', !eyeSelect.options.length)
    if (!eyeSelect.options.length) mode = 'waveform'
    reset()
  }
  /** Zooms back out to the full time range of the current view and redraws. */
  const reset = (): void => {
    const curves = series()
    fullMin = mode === 'eye' ? 0 : Math.min(...curves.map(({ run }) => run.rows[0][0]))
    fullMax = mode === 'eye' ? 2 * selectedEye().unitIntervalSeconds : Math.max(...curves.map(({ run }) => run.rows.at(-1)![0]))
    xMin = fullMin
    xMax = fullMax
    draw()
  }
  /** Rounds a number to six significant digits for axis labels and inputs. */
  const format = (value: number): string => Number(value.toPrecision(6)).toString()
  /** Repaints the canvas (grid, axes, curves) and the captions and range inputs that describe it. */
  const draw = (): void => {
    width = canvas.clientWidth
    height = canvas.clientHeight
    canvas.width = width * devicePixelRatio
    canvas.height = height * devicePixelRatio
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
    plotWidth = width - pad.left - pad.right
    plotHeight = height - pad.top - pad.bottom
    ctx.clearRect(0, 0, width, height)
    const curves = series()
    yMin = Infinity
    yMax = -Infinity
    for (const { run, probe } of curves) for (const row of run.rows) {
      yMin = Math.min(yMin, row[probe.column])
      yMax = Math.max(yMax, row[probe.column])
    }
    const margin = Math.max((yMax - yMin) * .08, .02)
    yMin -= margin
    yMax += margin
    /** Maps a time in seconds to a canvas x pixel. */
    const sx = (x: number): number => pad.left + (x - xMin) / (xMax - xMin) * plotWidth
    /** Maps a voltage to a canvas y pixel. */
    const sy = (y: number): number => pad.top + (yMax - y) / (yMax - yMin) * plotHeight
    ctx.font = '12px system-ui'
    ctx.lineWidth = 1
    for (let i = 0; i <= 5; i++) {
      const x = pad.left + i / 5 * plotWidth
      const y = pad.top + i / 5 * plotHeight
      ctx.strokeStyle = '#e8edf2'
      ctx.beginPath()
      ctx.moveTo(x, pad.top)
      ctx.lineTo(x, height - pad.bottom)
      ctx.moveTo(pad.left, y)
      ctx.lineTo(width - pad.right, y)
      ctx.stroke()
      ctx.fillStyle = '#65758a'
      ctx.textAlign = 'center'
      ctx.fillText(format((xMin + i / 5 * (xMax - xMin)) * 1e9), x, height - 22)
      ctx.textAlign = 'right'
      ctx.fillText(format(yMax - i / 5 * (yMax - yMin)), pad.left - 10, y + 4)
    }
    ctx.textAlign = 'left'
    ctx.fillText('Voltage (V)', 12, 14)
    ctx.textAlign = 'center'
    ctx.fillText(mode === 'eye' ? 'Time within two UI (ns)' : 'Time (ns)', pad.left + plotWidth / 2, height - 3)
    ctx.save()
    ctx.beginPath()
    ctx.rect(pad.left, pad.top, plotWidth, plotHeight)
    ctx.clip()
    /** Strokes one column of rows between `start` and `end`, shifted left by `origin` (used to fold eye windows). */
    const drawRows = (rows: number[][], column: number, start: number, end: number, origin: number): void => {
      // Per-pixel first/min/max/last envelopes preserve narrow peaks during zoom.
      // Raw samples and metric calculations are never reduced.
      let bucket = -Infinity
      let points: number[][] = []
      /** Draws the buffered points of one pixel column as its first, lowest, highest and last samples. */
      const flush = (): void => {
        if (!points.length) return
        let low = points[0]
        let high = points[0]
        for (const p of points) {
          if (p[1] < low[1]) low = p
          if (p[1] > high[1]) high = p
        }
        const chosen = [...new Set([points[0], low, high, points.at(-1)!])].sort((a, b) => a[0] - b[0])
        for (const [x, y] of chosen) ctx.lineTo(sx(x - origin), sy(y))
      }
      const first = Math.max(0, nearestIndex(rows, start) - 1)
      const last = Math.min(rows.length - 1, nearestIndex(rows, end))
      ctx.beginPath()
      ctx.moveTo(sx(rows[first][0] - origin), sy(rows[first][column]))
      for (let i = first; i <= last; i++) {
        const p = rows[i]
        const next = Math.floor(sx(p[0] - origin))
        if (next !== bucket) {
          flush()
          points = []
          bucket = next
        }
        points.push([p[0], p[column]])
      }
      flush()
      ctx.stroke()
    }
    curves.forEach(({ run, probe }, i) => {
      ctx.strokeStyle = colors[i % colors.length]
      ctx.lineWidth = mode === 'eye' ? .8 : 1.6
      ctx.globalAlpha = mode === 'eye' ? .2 : 1
      if (mode === 'waveform') drawRows(run.rows, probe.column, xMin, xMax, 0)
      else {
        const eye = run.eyes.find(e => e.simulationVoltageProbeId === probe.simulationVoltageProbeId && e.name === selectedEye().name)
          ?? run.eyes.find(e => e.simulationVoltageProbeId === probe.simulationVoltageProbeId)
        if (eye && eye.unitIntervalSeconds === selectedEye().unitIntervalSeconds)
          for (const origin of eye.windowOriginsSeconds) drawRows(run.rows, probe.column, origin + xMin, origin + xMax, origin)
      }
    })
    ctx.restore()
    ctx.globalAlpha = 1
    $('legend').replaceChildren()
    curves.forEach(({ run, probe }, i) => {
      const item = document.createElement('span')
      item.textContent = `${run.name} · ${probe.name}`
      item.style.color = colors[i % colors.length]
      $('legend').append(item)
    })
    $('selection').textContent = `${selectedRun().name} / ${selectedProbe().name}`
    $('binding').textContent = `Measured voltage = ${selectedProbe().signalLabel ?? selectedProbe().signalSourceId ?? 'recorded signal'} − ${selectedProbe().referenceLabel ?? selectedProbe().referenceSourceId ?? 'channel ground'}`
    if (mode === 'eye') {
      const eye = selectedEye()
      $('binding').textContent += eye.alignment === 'received-differential-dqs'
        ? ` · Received DQS alignment; capture at ${format(eye.unitIntervalSeconds * 1e9)} ns · ${eye.windowOriginsSeconds.length} complete windows · ${eye.ddrAssessment?.status ?? 'not-evaluated'} · DDR compliance not evaluated`
        : ' · Declared stimulus clock alignment'
    }
    $('sample-count').textContent = curves.map(({ run }) => run.rows.length.toLocaleString()).join(' + ') + ' actual samples'
    $('waveform-button').setAttribute('aria-pressed', String(mode === 'waveform'))
    $('eye-button').setAttribute('aria-pressed', String(mode === 'eye'))
    $('eye-field').hidden = mode !== 'eye'
    $<HTMLInputElement>('start').value = format(xMin * 1e9)
    $<HTMLInputElement>('end').value = format(xMax * 1e9)
  }
  /** Clamps the visible range so panning and zooming never leave the recorded data. */
  const limit = (): void => {
    const span = Math.min(xMax - xMin, fullMax - fullMin)
    xMin = Math.max(fullMin, Math.min(xMin, fullMax - span))
    xMax = xMin + span
  }
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tab]'))
  /** Shows the tab panel with this id, hides the others, and draws the plot when it becomes visible. */
  const activateTab = (id: string): void => {
    for (const tab of tabs) {
      const active = tab.dataset.tab === id
      $(tab.dataset.tab!).hidden = !active
      tab.setAttribute('aria-selected', String(active))
      tab.tabIndex = active ? 0 : -1
    }
    if (id === 'explore') draw()
  }
  tabs.forEach((tab, i) => {
    tab.onclick = () => activateTab(tab.dataset.tab!)
    tab.onkeydown = event => {
      const next = event.key === 'ArrowRight' ? (i + 1) % tabs.length : event.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
      if (next >= 0) {
        event.preventDefault()
        tabs[next].focus()
        activateTab(tabs[next].dataset.tab!)
      }
    }
  })
  runSelect.onchange = updateProbes
  probeSelect.onchange = updateEyes
  eyeSelect.onchange = reset
  overlay.onchange = reset
  $('waveform-button').onclick = () => {
    mode = 'waveform'
    reset()
  }
  $('eye-button').onclick = () => {
    if (eyeSelect.options.length) {
      mode = 'eye'
      reset()
    }
  }
  $('reset').onclick = reset
  canvas.ondblclick = reset
  $('csv').onclick = event => {
    event.preventDefault()
    const run = selectedRun()
    /** Quotes a CSV header cell, doubling any embedded quotes. */
    const quote = (value: string): string => `"${value.replace(/"/g,'""')}"`
    const csv = ['time_s,' + run.probes.map(probe=>quote(probe.name+'_v')).join(','),
      ...run.rows.map(row=>[row[0],...run.probes.map(probe=>row[probe.column])].join(','))].join('\n')+'\n'
    const url = URL.createObjectURL(new Blob([csv],{type:'text/csv'}))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = run.name.replace(/[^a-zA-Z0-9_-]/g,'_')+'.csv'
    anchor.click()
    setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
  /** Applies the typed start/end times (in ns) when they form a valid range, then redraws. */
  const applyRange = (): void => {
    const a = Number($<HTMLInputElement>('start').value) * 1e-9
    const b = Number($<HTMLInputElement>('end').value) * 1e-9
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
      xMin = a
      xMax = b
      limit()
    }
    draw()
  }
  $('start').onchange = applyRange
  $('end').onchange = applyRange
  canvas.addEventListener('wheel', event => {
    event.preventDefault()
    const fraction = Math.max(0, Math.min(1, (event.offsetX - pad.left) / plotWidth))
    const anchor = xMin + fraction * (xMax - xMin)
    const span = Math.max((fullMax - fullMin) * 1e-7, (xMax - xMin) * (event.deltaY > 0 ? 1.2 : 1 / 1.2))
    xMin = anchor - fraction * span
    xMax = xMin + span
    limit()
    draw()
  }, { passive: false })
  canvas.onpointerdown = event => {
    drag = { x: event.offsetX, min: xMin, max: xMax }
    canvas.setPointerCapture(event.pointerId)
  }
  canvas.onpointerup = () => {
    drag = null
  }
  canvas.onpointercancel = () => {
    drag = null
  }
  canvas.onpointermove = event => {
    if (drag) {
      const shift = (event.offsetX - drag.x) / plotWidth * (drag.max - drag.min)
      xMin = drag.min - shift
      xMax = drag.max - shift
      limit()
      draw()
    } else if (mode === 'waveform') {
      const time = xMin + (event.offsetX - pad.left) / plotWidth * (xMax - xMin)
      const run = selectedRun()
      const probe = selectedProbe()
      const index = nearestIndex(run.rows, time)
      const point = run.rows[index]
      $('cursor').textContent = `${format(point[0] * 1e9)} ns · ${format(point[probe.column])} V · actual sample ${index + 1}`
    }
  }
  $('summary').textContent = `${data.runs.length} runs · ${new Set(data.runs.flatMap(run=>run.probes.map(probe=>probe.name))).size} probes · ${data.runs.reduce((sum,run)=>sum+run.eyes.length,0)} eyes`
  document.querySelectorAll<HTMLButtonElement>('[data-run]').forEach(button => {
    button.onclick = () => {
      runSelect.value = button.dataset.run!
      overlay.checked = false
      updateProbes()
      probeSelect.value = button.dataset.probe!
      mode = button.dataset.mode!
      updateEyes()
      activateTab('explore')
    }
  })
  updateProbes()
  new ResizeObserver(draw).observe(canvas)
}
