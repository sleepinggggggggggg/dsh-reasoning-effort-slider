/**
 * dsh-reasoning-effort-slider — browser half.
 *
 * A Codex-style reasoning-effort slider that lives INSIDE the official model
 * menu, as a second line under the「推理等级 / Effort」row. Nothing is added to
 * the composer tool row; the collapsed seat keeps the native
 * `model · effort ⌄` typography, and only the effort text is tinted by level.
 *
 * Two halves in one file:
 *   1. a DOM bridge — finds the official trigger of THIS composer card, follows
 *      its menu through `aria-expanded` / `aria-controls`, and appends one
 *      container under the effort row (fail-open: any unexpected shape means
 *      "do nothing", never a broken menu);
 *   2. a React control portaled into that container, reading the same
 *      `modelSelection` projection and `session.modelCatalog()` the shipped menu
 *      reads, and writing through `session.selectModel`.
 *
 * The knob follows the pointer continuously while a gesture is open and snaps
 * onto the nearest level on release; the fill, its gradient and the tinted text
 * track the same position, so the control reads as one continuous bar.
 *
 * @module dsh-reasoning-effort-slider/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-reasoning-effort-slider',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } = React

    /** Locale namespace this control registers its dictionaries under. */
    const NS = 'reasoningEffort'

    /** Track geometry. The knob is a circle as tall as the track. */
    const TRACK_HEIGHT = 28
    const INSET = TRACK_HEIGHT / 2

    /** Milliseconds of dwell before a level change is written to the Host. */
    const COMMIT_IDLE_MS = 160

    /** How long a failed switch stays visible on the control. */
    const FAILURE_MS = 4000

    /** Upper bound on the star field; the drawn count scales with energy. */
    const MAX_STARS = 26

    /** Horizontal travel of one star, in px (the track is clipped, so exact width is irrelevant). */
    const STAR_TRAVEL = -420

    /**
     * UI text, localized through the Client locale service.
     *
     * Effort LEVELS are adapter-owned and deliberately not translated here: the
     * official menu prints the adapter's exact `name`, and two surfaces showing
     * one value must not disagree in any locale.
     */
    const DICTS = {
      zh: {
        'meta.title': '推理强度滑条',
        'meta.description': '把官方模型菜单里的「推理等级」变成一条 Codex 风格滑条：按档吸附的白色圆钮、蓝紫渐变、高档星尘，档位名与取值随主题高亮。',
        label: '推理强度',
        hint: '拖动调整推理强度（越往右越费 token）',
        'error.prefix': '切换失败：',
      },
      en: {
        'meta.title': 'Reasoning Effort Slider',
        'meta.description': 'Turns the model menu Effort row into a Codex-style slider: a level-snapping white knob, blue-to-violet fill, starfield at high levels, and a tinted effort label.',
        label: 'Reasoning effort',
        hint: 'Drag to set reasoning effort (further right costs more tokens)',
        'error.prefix': 'Switch failed: ',
      },
    }

    /** Effort ids/names that mean "no reasoning"; these keep the official text color. */
    const OFF_LEVELS = new Set(['off', 'none', 'disabled', 'no', '关闭', '无', '关'])

    // ---------------------------------------------------------------------
    // Colour maths (position → fill / energy / text tint)
    // ---------------------------------------------------------------------

    const BLUE = [77, 147, 248]
    const VIOLET = [147, 51, 234]
    const DEEP = [76, 29, 149]
    const TEXT_BLUE = [77, 147, 248]
    const TEXT_VIOLET = [139, 92, 246]

    const clamp01 = (value) => Math.min(Math.max(value, 0), 1)

    const mix = (from, to, ratio) => from.map((channel, index) => Math.round(channel + (to[index] - channel) * ratio))

    const rgb = (channels) => `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`

    /** Right-hand end of the fill gradient at one ladder position. */
    function fillColor(pct) {
      if (pct <= 1 / 3) return rgb(BLUE)
      if (pct <= 2 / 3) return rgb(mix(BLUE, VIOLET, (pct - 1 / 3) * 3))
      return rgb(mix(VIOLET, DEEP, (pct - 2 / 3) * 3))
    }

    /** Nova / star intensity: zero until the middle level, then ramps to 1. */
    function energyAt(pct) {
      return clamp01((pct - 1 / 3) / (2 / 3))
    }

    /** Official value-text tint: blue → indigo → violet. */
    function textColorAt(pct) {
      return rgb(mix(TEXT_BLUE, TEXT_VIOLET, pct))
    }

    /** True for levels that must keep the official (uncoloured) text. */
    function isOffLevel(effort) {
      if (effort === undefined || effort === null) return false
      return OFF_LEVELS.has(String(effort.id).toLowerCase().trim())
        || OFF_LEVELS.has(String(effort.name).toLowerCase().trim())
    }

    // ---------------------------------------------------------------------
    // Star field (deterministic, so a re-render never reshuffles it)
    // ---------------------------------------------------------------------

    function hash01(seed) {
      const value = Math.sin(seed * 12.9898) * 43758.5453
      return value - Math.floor(value)
    }

    const STAR_SPECS = Array.from({ length: MAX_STARS }, (_, index) => {
      const height = hash01(index + 1)
      const phase = hash01(index + 977)
      return {
        top: 10 + height * 78,
        size: 1 + Math.round(phase * 2),
        opacity: 0.35 + phase * 0.55,
        duration: 2.6 + height * 3.4,
        delay: -phase * 6,
      }
    })

    // ---------------------------------------------------------------------
    // Shared model catalog (one per connection generation)
    // ---------------------------------------------------------------------

    const catalog = {
      value: null,
      error: null,
      inflight: null,
      generation: 0,
      listeners: new Set(),
    }

    function emitCatalog() {
      for (const listener of [...catalog.listeners]) listener()
    }

    function subscribeCatalog(listener) {
      catalog.listeners.add(listener)
      return () => {
        catalog.listeners.delete(listener)
      }
    }

    function getCatalog() {
      return catalog.value
    }

    function resetCatalog() {
      catalog.generation += 1
      catalog.value = null
      catalog.error = null
      catalog.inflight = null
      emitCatalog()
    }

    /**
     * Load the Host model catalog once and share the in-flight request.
     * @param remote - the Client remote namespace (`ctx.remote`).
     * @returns the loaded catalog.
     */
    function loadCatalog(remote) {
      if (catalog.value !== null) return Promise.resolve(catalog.value)
      if (catalog.inflight !== null) return catalog.inflight
      const generation = catalog.generation
      const operation = remote.session.modelCatalog()
        .then((result) => {
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
          if (generation === catalog.generation) {
            catalog.value = result.value
            catalog.error = null
            emitCatalog()
          }
          return result.value
        })
        .catch((error) => {
          if (generation === catalog.generation) {
            catalog.error = error instanceof Error ? error.message : String(error)
            emitCatalog()
          }
          throw error
        })
      catalog.inflight = operation
      const settle = () => {
        if (catalog.inflight === operation) catalog.inflight = null
      }
      operation.then(settle, settle)
      return operation
    }

    // ---------------------------------------------------------------------
    // Selection helpers
    // ---------------------------------------------------------------------

    function findModel(value, selection) {
      if (value === null || selection === null || selection === undefined) return undefined
      const group = value.groups.find((item) => item.id === selection.provider)
      if (group === undefined) return undefined
      return group.models.find((item) => item.id === selection.model)
    }

    /** Index of the committed level, tolerating an id the model no longer advertises. */
    function effortIndex(efforts, explicit, fallback) {
      if (efforts.length === 0) return 0
      const wanted = explicit ?? fallback
      if (wanted === undefined) return 0
      const index = efforts.findIndex((effort) => String(effort.id) === String(wanted))
      return index < 0 ? 0 : index
    }

    /** Level position as a 0..1 fraction of the ladder. */
    function levelPct(index, count) {
      return count > 1 ? index / (count - 1) : 0
    }

    /** CSS position of a 0..1 track fraction, measured against the inset span. */
    function positionOf(fraction) {
      return `calc(${INSET}px + (100% - ${INSET * 2}px) * ${fraction})`
    }

    /** CSS position of one level centre. */
    function centreOf(index, count) {
      return positionOf(levelPct(index, count))
    }

    // ---------------------------------------------------------------------
    // DOM bridge: official model menu → one container under the effort row
    // ---------------------------------------------------------------------

    /**
     * Observe one composer card and keep a container mounted under its model
     * menu's effort row.
     *
     * Every step is fail-open: when the trigger, the menu, or the expected two
     * root rows are absent, nothing is injected and the official menu stays
     * exactly as the host rendered it.
     *
     * @param anchor - the (hidden) slot element owned by this plugin.
     * @param onTarget - called with `{ container, value, paint }` or `null`.
     * @returns the disposer.
     */
    function createBridge(anchor, onTarget) {
      let disposed = false
      let card = null
      let trigger = null
      let menu = null
      let row = null
      let container = null
      let target = null
      let frame = 0
      let triggerObserver = null
      let menuObserver = null
      let coloredValue = null
      let coloredTrigger = null
      let menuClickGuard = null
      let clickGuard = null

      const bodyObserver = new MutationObserver(schedule)
      bodyObserver.observe(document.body, { childList: true })

      function schedule() {
        if (disposed || frame !== 0) return
        frame = requestAnimationFrame(() => {
          frame = 0
          reconcile()
        })
      }

      /** Publish only when the portal target actually changed. */
      function publish(next) {
        const same = target === next
          || (target !== null && next !== null && target.container === next.container && target.value === next.value)
        if (same) return
        target = next
        onTarget(next)
      }

      /** Drop the armed click window and its timer. */
      function clearClickGuard() {
        if (clickGuard !== null && clickGuard.timer !== 0) clearTimeout(clickGuard.timer)
        clickGuard = null
      }

      /**
       * Swallow the click that a press on the slider produces.
       *
       * A click's target is the nearest common ancestor of pointerdown and
       * pointerup, so a press on the track that is released a few pixels away —
       * or released after React replaced the row — resolves to the official
       * effort row and its `onClick` would drill into the native list. The guard
       * is geometric, so ordinary clicks on the row keep working.
       */
      function suppressClicks(rect) {
        clearClickGuard()
        if (rect === undefined || rect === null) return
        clickGuard = {
          rect,
          timer: setTimeout(clearClickGuard, 2500),
        }
      }

      function onRowClickCapture(event) {
        if (clickGuard === null) return
        const { rect } = clickGuard
        const inside = event.clientX >= rect.left - 18 && event.clientX <= rect.right + 18
          && event.clientY >= rect.top - 18 && event.clientY <= rect.bottom + 18
        if (!inside) return
        event.preventDefault()
        event.stopPropagation()
        clearClickGuard()
      }

      function detachRow() {
        if (row === null) return
        if (row.isConnected) row.removeAttribute('data-dres-row')
        row = null
      }

      function clearInjection() {
        if (container !== null) {
          container.remove()
          container = null
        }
        detachRow()
        clearClickGuard()
        coloredValue = null
        publish(null)
      }

      function observeTrigger(next) {
        if (trigger === next) return
        if (triggerObserver !== null) triggerObserver.disconnect()
        trigger = next
        triggerObserver = next === null ? null : new MutationObserver(schedule)
        if (triggerObserver !== null) {
          triggerObserver.observe(next, { attributes: true, attributeFilter: ['aria-expanded', 'aria-controls'] })
        }
      }

      function observeMenu(next) {
        if (menu === next) return
        if (menuObserver !== null) menuObserver.disconnect()
        if (menuClickGuard !== null) {
          if (menu !== null && menu.isConnected) menu.removeEventListener('click', menuClickGuard, true)
          menuClickGuard = null
        }
        menu = next
        if (next !== null) {
          menuClickGuard = onRowClickCapture
          next.addEventListener('click', menuClickGuard, true)
        }
        menuObserver = next === null ? null : new MutationObserver((records) => {
          // Our own portal lives inside the menu; ignoring its mutations stops
          // every drag frame from re-running the bridge.
          for (const record of records) {
            if (container !== null && (record.target === container || container.contains(record.target))) continue
            schedule()
            return
          }
        })
        if (menuObserver !== null) menuObserver.observe(next, { childList: true, subtree: true, characterData: true })
      }

      /** The first ancestor of the anchor that owns a menu trigger. */
      function findCard() {
        let node = anchor
        while (node !== null && node !== document.body) {
          if (typeof node.querySelector === 'function' && node.querySelector('button[aria-haspopup="menu"]') !== null) return node
          node = node.parentElement
        }
        return null
      }

      /**
       * Direct child spans only: a custom model label may nest its own spans, and
       * the effort text is always the LAST direct span of the trigger.
       */
      function directSpans(element) {
        return element === null ? [] : Array.from(element.children).filter((child) => child.tagName === 'SPAN')
      }

      /** The effort span inside the official trigger (its last direct span). */
      function triggerEffortSpan() {
        const spans = directSpans(trigger)
        return spans.length >= 2 ? spans[spans.length - 1] : null
      }

      /** Grow the official row only while the control actually renders. */
      function setActive(active) {
        if (row !== null) {
          if (active) row.setAttribute('data-dres-row', '')
          else row.removeAttribute('data-dres-row')
        }
        if (container !== null) container.style.display = active ? 'block' : 'none'
      }

      function paint(color) {
        if (coloredValue !== null) {
          coloredValue.style.color = ''
          coloredValue = null
        }
        if (coloredTrigger !== null) {
          coloredTrigger.style.color = ''
          coloredTrigger = null
        }
        if (color === null || color === '') return
        if (target !== null && target.value !== null) {
          target.value.style.color = color
          coloredValue = target.value
        }
        const effort = triggerEffortSpan()
        if (effort !== null) {
          effort.style.color = color
          coloredTrigger = effort
        }
      }

      function reconcile() {
        if (disposed) return

        if (card === null || !card.isConnected) {
          card = findCard()
          if (card === null) {
            clearInjection()
            return
          }
        }

        if (trigger === null || !trigger.isConnected || !card.contains(trigger)) {
          observeTrigger(card.querySelector('button[aria-haspopup="menu"]'))
          if (trigger === null) {
            clearInjection()
            return
          }
        }

        const expanded = trigger.getAttribute('aria-expanded') === 'true'
        const menuId = trigger.getAttribute('aria-controls')
        const nextMenu = expanded && menuId !== null ? document.getElementById(menuId) : null
        observeMenu(nextMenu)
        if (nextMenu === null) {
          clearInjection()
          return
        }

        // Root pane only: exactly the model / effort rows are `menuitem`; the
        // drilled panes use `menuitemradio`. The last root row is the effort row.
        const rows = menu.querySelectorAll('button[role="menuitem"]')
        if (rows.length < 2) {
          clearInjection()
          return
        }
        const nextRow = rows[rows.length - 1]
        if (row !== nextRow) {
          detachRow()
          row = nextRow
          coloredValue = null
        }

        if (container === null) {
          container = document.createElement('div')
          container.className = 'dres-inject'
        }
        if (container.parentElement !== row) row.appendChild(container)

        const spans = directSpans(row)
        const value = spans.length >= 2 ? spans[spans.length - 1] : null
        publish({ container, value, paint, setActive, suppressClicks })
      }

      reconcile()

      return {
        paint,
        dispose() {
          disposed = true
          if (frame !== 0) cancelAnimationFrame(frame)
          bodyObserver.disconnect()
          if (triggerObserver !== null) triggerObserver.disconnect()
          if (menuObserver !== null) menuObserver.disconnect()
          paint(null)
          clearClickGuard()
          if (container !== null) container.remove()
          if (menuClickGuard !== null && menu !== null && menu.isConnected) {
            menu.removeEventListener('click', menuClickGuard, true)
            menuClickGuard = null
          }
          detachRow()
          onTarget(null)
        },
      }
    }

    // ---------------------------------------------------------------------
    // The control
    // ---------------------------------------------------------------------

    /**
     * One session's effort slider, portaled into the official effort row.
     *
     * The knob is pointer driven while a gesture is open — it follows the cursor
     * frame by frame — and level driven once released. A level change settles for
     * {@link COMMIT_IDLE_MS} before one `session.selectModel` call is issued;
     * releasing flushes it.
     */
    function EffortSlider({ sessionId, useProjection, useSession, target, catalogValue, bridge }) {
      const projected = useProjection('modelSelection')
      const subagent = useSession((snapshot) => snapshot.subagent)

      const selection = projected?.next ?? catalogValue?.default ?? null
      const model = findModel(catalogValue, selection)
      const efforts = model?.reasoning?.efforts ?? []
      const count = efforts.length
      const committed = effortIndex(efforts, selection?.reasoningEffort, model?.reasoning?.defaultEffort)

      const [preview, setPreview] = useState(null)
      const [grab, setGrab] = useState(null)
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(null)

      const drag = useRef({ active: false, detach: null })
      const track = useRef(null)
      const level = useRef(committed)
      const desired = useRef(null)
      const sending = useRef(false)
      const timer = useRef(0)
      const selectionRef = useRef(selection)
      const effortsRef = useRef(efforts)
      const mounted = useRef(true)

      selectionRef.current = selection
      effortsRef.current = efforts

      const index = preview !== null && preview < count ? preview : committed
      const pct = grab !== null ? grab : levelPct(index, count)
      const energy = energyAt(pct)
      const off = isOffLevel(efforts[index])
      const tint = off || count === 0 ? null : textColorAt(pct)

      // Grow the official row only while there is a ladder to show, and keep
      // its value text in step with the knob (preview included).
      useLayoutEffect(() => {
        target.setActive(subagent === null && count >= 2)
      }, [target, subagent, count])

      useLayoutEffect(() => {
        target.paint(tint)
      }, [target, tint])

      useEffect(() => () => {
        mounted.current = false
        clearTimeout(timer.current)
        const state = drag.current
        if (state.active && state.detach !== null) state.detach()
        drag.current = { active: false, detach: null }
        target.paint(null)
      }, [target])

      // The durable selection settling (or the model changing) retires the preview.
      useEffect(() => {
        setPreview(null)
        level.current = committed
      }, [committed, selection?.provider, selection?.model])

      useEffect(() => {
        if (failure === null) return undefined
        const handle = setTimeout(() => setFailure(null), FAILURE_MS)
        return () => clearTimeout(handle)
      }, [failure])

      /** Serialise writes; the newest requested level always wins. */
      const drain = useCallback(async () => {
        if (sending.current) return
        sending.current = true
        try {
          while (desired.current !== null) {
            const next = desired.current
            desired.current = null
            const current = selectionRef.current
            const effort = effortsRef.current[next]
            if (current === null || effort === undefined) break
            if (mounted.current) setBusy(true)
            let result
            try {
              result = await bridge.remote.session.selectModel({
                sessionId,
                provider: current.provider,
                model: current.model,
                reasoningEffort: effort.id,
              })
            } catch (error) {
              result = { ok: false, error: { code: 'transport', message: error instanceof Error ? error.message : String(error) } }
            }
            if (!mounted.current) return
            setBusy(false)
            if (!result.ok) {
              setFailure(`${result.error.code}: ${result.error.message}`)
              setPreview(null)
              break
            }
          }
        } finally {
          sending.current = false
        }
      }, [bridge, sessionId])

      /** Request one level, coalescing bursts into a single trailing write. */
      const request = useCallback((next) => {
        desired.current = next
        clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          void drain()
        }, COMMIT_IDLE_MS)
      }, [drain])

      const flush = useCallback(() => {
        clearTimeout(timer.current)
        if (desired.current !== null) void drain()
      }, [drain])

      /** Continuous ladder position (0..1) under one pointer x. */
      const fractionAt = useCallback((clientX) => {
        const element = track.current
        if (element === null || count < 2) return 0
        const rect = element.getBoundingClientRect()
        const span = Math.max(rect.width - INSET * 2, 1)
        return Math.min(Math.max((clientX - rect.left - INSET) / span, 0), 1)
      }, [count])

      /** Put the knob under the pointer and settle on the nearest level. */
      const trackPointer = useCallback((clientX) => {
        if (!drag.current.active) return
        const fraction = fractionAt(clientX)
        setGrab(fraction)
        const next = Math.round(fraction * (count - 1))
        if (next === level.current) return
        level.current = next
        setPreview(next)
        request(next)
      }, [count, fractionAt, request])

      /** Detach the window listeners and let the knob snap onto its level. */
      const endDrag = useCallback((commitNow) => {
        const state = drag.current
        if (!state.active) return
        state.active = false
        if (state.detach !== null) {
          state.detach()
          state.detach = null
        }
        setGrab(null)
        if (commitNow) flush()
      }, [flush])

      const onPointerDown = (event) => {
        if (busy || event.button !== 0) return
        if (drag.current.active) endDrag(false)
        event.preventDefault()
        event.stopPropagation()
        // Arm the click guard before anything re-renders: the click that follows
        // this press must not reach the official effort row.
        if (track.current !== null) target.suppressClicks(track.current.getBoundingClientRect())
        // The gesture is owned by `window`, not by this element: a menu re-render
        // that replaces the node can no longer leave the slider armed, and a move
        // with no button held ends the drag instead of following the cursor.
        const move = (moveEvent) => {
          if (moveEvent.buttons === 0) {
            endDrag(true)
            return
          }
          trackPointer(moveEvent.clientX)
        }
        const up = () => {
          endDrag(true)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
        window.addEventListener('blur', up)
        drag.current = {
          active: true,
          detach: () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            window.removeEventListener('pointercancel', up)
            window.removeEventListener('blur', up)
          },
        }
        trackPointer(event.clientX)
      }

      const onKeyDown = (event) => {
        if (busy) return
        let next = null
        if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = index + 1
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = index - 1
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = count - 1
        else if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (next === null) return
        event.preventDefault()
        event.stopPropagation()
        if (next < 0 || next > count - 1) return
        level.current = next
        setPreview(next)
        request(next)
        flush()
      }

      const active = efforts[index]
      const name = active?.name ?? ''
      const visibleStars = Math.round(MAX_STARS * energy)

      // No reasoning ladder (or a single fixed level) means nothing to slide.
      if (subagent !== null || count < 2) return null

      return createPortal(h('div', {
        className: 'dres',
        role: 'slider',
        tabIndex: 0,
        'aria-label': bridge.text('label'),
        'aria-valuemin': 0,
        'aria-valuemax': count - 1,
        'aria-valuenow': index,
        'aria-valuetext': name,
        'aria-disabled': busy ? 'true' : undefined,
        'data-busy': busy ? 'true' : 'false',
        'data-off': off ? 'true' : 'false',
        'data-dragging': grab !== null ? 'true' : 'false',
        title: failure === null ? bridge.text('hint') : `${bridge.text('error.prefix')}${failure}`,
        onKeyDown,
      },
        h('div', {
          className: 'dres-track',
          ref: track,
          onPointerDown,
        },
          h('div', { className: 'dres-fill', style: { width: positionOf(pct), '--dres-end': fillColor(pct) } },
            h('div', { className: 'dres-nova', style: { opacity: energy } }),
            visibleStars > 0 && h('div', { className: 'dres-stars', style: { '--dres-travel': `${STAR_TRAVEL}px` } },
              STAR_SPECS.slice(0, visibleStars).map((star, position) => h('span', {
                key: position,
                className: 'dres-star',
                style: {
                  top: `${star.top}%`,
                  width: `${star.size}px`,
                  height: `${star.size}px`,
                  opacity: star.opacity,
                  animationDuration: `${star.duration}s`,
                  animationDelay: `${star.delay}s`,
                },
              }))),
          ),
          h('div', { className: 'dres-knob', style: { left: positionOf(pct) } }),
        ),
        h('div', { className: 'dres-dots' },
          efforts.map((effort, stop) => h('span', {
            key: String(effort.id),
            className: 'dres-dot',
            'data-on': stop <= index ? 'true' : 'false',
            style: { left: centreOf(stop, count) },
          }))),
        h('div', { className: 'dres-name', 'data-error': failure === null ? 'false' : 'true' }, name),
      ), target.container)
    }

    // ---------------------------------------------------------------------
    // Anchor: owns the bridge, the catalog and the portal
    // ---------------------------------------------------------------------

    function EffortAnchor(props) {
      const { sessionId, useProjection, useSession, bridge } = props
      const anchor = useRef(null)
      const api = useRef(null)
      const [target, setTarget] = useState(null)
      const catalogValue = useSyncExternalStore(subscribeCatalog, getCatalog)
      const projected = useProjection('modelSelection')
      const subagent = useSession((snapshot) => snapshot.subagent)

      useEffect(() => {
        if (anchor.current === null) return undefined
        const bridgeApi = createBridge(anchor.current, setTarget)
        api.current = bridgeApi
        return () => {
          api.current = null
          bridgeApi.dispose()
        }
      }, [])

      // A slider lives in this composer; make sure the Host catalog is loaded.
      useEffect(() => {
        if (subagent !== null) return
        loadCatalog(bridge.remote).catch(() => {})
      }, [subagent, sessionId, bridge, catalogValue])

      // Colour the collapsed seat's effort text even while the menu is closed.
      const selection = projected?.next ?? catalogValue?.default ?? null
      const model = findModel(catalogValue, selection)
      const efforts = model?.reasoning?.efforts ?? []
      const index = effortIndex(efforts, selection?.reasoningEffort, model?.reasoning?.defaultEffort)
      const tint = efforts.length === 0 || isOffLevel(efforts[index])
        ? null
        : textColorAt(levelPct(index, efforts.length))

      // With the menu closed there is no slider to paint the row; the collapsed
      // seat still shows the effort, so tint that one span from here.
      useEffect(() => {
        if (target === null) api.current?.paint(tint)
      }, [target, tint])

      const active = target !== null && subagent === null

      return h(React.Fragment, null,
        h('span', { ref: anchor, className: 'dres-anchor', 'aria-hidden': 'true' }),
        active && h(EffortSlider, {
          sessionId,
          useProjection,
          useSession,
          target,
          catalogValue,
          bridge,
        }),
      )
    }

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------

    /**
     * `[data-dres-row]` only re-shapes the official effort row (wrap + padding);
     * the hashed classes the host uses are never touched. All colours are host
     * theme tokens, with literal fallbacks for a renamed token.
     */
    const CSS = `
[data-dres-row]{height:auto!important;flex-wrap:wrap!important;padding-top:9px!important;padding-bottom:9px!important}

.dres-anchor{display:none!important}
.dres-inject{flex:0 0 100%!important;width:100%!important;display:block!important;margin-top:5px}

.dres{display:block;width:100%;font:inherit;color:inherit;user-select:none;-webkit-user-select:none;
  animation:dres-pop 220ms cubic-bezier(.2,.9,.25,1.08) both}

@keyframes dres-pop{
  0%{opacity:0;transform:translateY(6px) scale(.94)}
  60%{opacity:1;transform:translateY(-1px) scale(1.012)}
  100%{opacity:1;transform:none}
}

.dres-track{position:relative;height:${TRACK_HEIGHT}px;border-radius:999px;
  background:var(--dsw-alias-border-l1,color-mix(in srgb,var(--dsw-alias-label-secondary) 22%,transparent));
  box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent);
  cursor:pointer;touch-action:none}

.dres:focus-visible{outline:none}
.dres:focus-visible .dres-track{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}

.dres-fill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;overflow:hidden;
  background:linear-gradient(90deg,#4d93f8 0%,var(--dres-end,#4d93f8) 100%);
  transition:width 80ms cubic-bezier(.22,.8,.3,1)}

.dres-nova{position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:
    radial-gradient(120% 190% at 8% 50%,rgba(166,107,255,.55),transparent 62%),
    linear-gradient(90deg,rgba(124,58,237,.35),rgba(76,29,149,.72));
  transition:opacity 160ms ease}

.dres-stars{position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none}
.dres-star{position:absolute;left:100%;border-radius:50%;background:#fff;will-change:transform;
  animation-name:dres-drift;animation-timing-function:linear;animation-iteration-count:infinite}

@keyframes dres-drift{from{transform:translate3d(0,0,0)}to{transform:translate3d(var(--dres-travel,-420px),0,0)}}

.dres[data-dragging='true'] .dres-knob,
.dres[data-dragging='true'] .dres-fill{transition:none}

@keyframes dres-knob-pop{
  0%{opacity:0;transform:translateX(-50%) scale(.55)}
  65%{opacity:1;transform:translateX(-50%) scale(1.06)}
  100%{opacity:1;transform:translateX(-50%) scale(1)}
}

.dres-knob{animation:dres-knob-pop 260ms cubic-bezier(.2,.9,.25,1.12) both;position:absolute;top:50%;width:${TRACK_HEIGHT}px;height:${TRACK_HEIGHT}px;margin-top:${-TRACK_HEIGHT / 2}px;
  border-radius:50%;background:#fff;transform:translateX(-50%);pointer-events:none;
  box-shadow:0 1px 3px rgba(9,12,24,.34),0 0 0 1px rgba(9,12,24,.07);
  transition:left 80ms cubic-bezier(.22,.8,.3,1)}

.dres-dots{position:relative;height:10px;margin-top:3px;animation:dres-fade 200ms 45ms ease both}
.dres-dot{position:absolute;top:3px;width:4px;height:4px;margin-left:-2px;border-radius:50%;
  background:var(--dsw-alias-border-l2,color-mix(in srgb,var(--dsw-alias-label-secondary) 40%,transparent));
  transition:background 120ms ease}
.dres-dot[data-on='true']{background:var(--dsw-alias-brand-primary,#4d93f8)}

.dres-name{animation:dres-fade 200ms 80ms ease both;display:block;margin-top:1px;text-align:center;font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dres-name[data-error='true']{color:var(--dsw-alias-state-error-primary,#d33)}

.dres[data-busy='true']{opacity:.7}

@keyframes dres-fade{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:none}}

@media (prefers-reduced-motion: reduce){
  .dres,.dres-knob,.dres-dots,.dres-name{animation:none!important}
  .dres-fill,.dres-knob,.dres-nova{transition:none}
  .dres-star{animation-duration:0.001s!important;opacity:.45!important}
}
`

    function mountStyles() {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-reasoning-effort-slider'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------

    return {
      inject: ['slots', 'remote', 'remote.session', 'locale'],
      apply(ctx) {
        const text = (key) => {
          const dict = DICTS[ctx.locale.getSnapshot().active] ?? DICTS.en
          return dict[key] ?? DICTS.en[key] ?? key
        }
        const bridge = {
          remote: ctx.remote,
          text,
        }

        for (const [locale, dict] of Object.entries(DICTS)) {
          ctx.effect(() => ctx.locale.register(NS, locale, dict))
        }
        ctx.effect(mountStyles)
        ctx.effect(() => ctx.on('connection/reset', () => resetCatalog()))

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'reasoning-effort',
          order: 10,
        }, (props) => h(EffortAnchor, { ...props, bridge })))
      },
    }
  },
})
