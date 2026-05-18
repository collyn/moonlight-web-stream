import "./polyfill/index.js"
import { Api, apiGetRole, getApi } from "./api.js";
import { Component } from "./component/index.js";
import { showErrorPopup } from "./component/error.js";
import { InfoEvent, Stream } from "./stream/index.js"
import { getModalBackground, Modal, showMessage, showModal } from "./component/modal/index.js";
import { getSidebarRoot, setSidebar, setSidebarExtended, setSidebarStyle, Sidebar } from "./component/sidebar/index.js";
import { defaultStreamInputConfig, MouseMode, ScreenKeyboardSetVisibleEvent, StreamInputConfig } from "./stream/input.js";
import { getLocalStreamSettings, Settings } from "./component/settings_menu.js";
import { InputComponent, SelectComponent } from "./component/input.js";
import { DetailedRole, LogMessageType, StreamCapabilities, StreamKeyModifiers, StreamKeys, StreamPermissions } from "./api_bindings.js";
import { ScreenKeyboard, TextEvent } from "./screen_keyboard.js";
import { FormModal } from "./component/modal/form.js";
import { streamStatsToText } from "./stream/stats.js";
import { adoptRoleDefaultLanguage, getCurrentLanguage, getTranslations } from "./i18n.js";

let I = getTranslations(getCurrentLanguage())

async function startApp() {
    const api = await getApi()

    const bootstrapRole = await apiGetRole(api, { id: null })
    adoptRoleDefaultLanguage(bootstrapRole.role.default_settings)
    I = getTranslations(getCurrentLanguage())

    const rootElement = document.getElementById("root");
    if (rootElement == null) {
        showErrorPopup(I.stream.rootNotFound, true)
        return;
    }

    // Get Host and App via Query
    const queryParams = new URLSearchParams(location.search)

    const hostIdStr = queryParams.get("hostId")
    const appIdStr = queryParams.get("appId")
    if (hostIdStr == null || appIdStr == null) {
        await showMessage(I.stream.missingHostOrApp)

        window.close()
        return
    }
    const hostId = Number.parseInt(hostIdStr)
    const appId = Number.parseInt(appIdStr)

    // event propagation on overlays
    const sidebarRoot = getSidebarRoot()
    if (sidebarRoot) {
        stopPropagationOn(sidebarRoot)
    }

    const modalBackground = getModalBackground()
    if (modalBackground) {
        stopPropagationOn(modalBackground)
    }

    // Start and Mount App
    const app = new ViewerApp(api, hostId, appId, bootstrapRole.role)
    app.mount(rootElement);

    (window as any)["app"] = app
}

// Prevent starting transition
window.requestAnimationFrame(() => {
    // Note: elements is a live array
    const elements = document.getElementsByClassName("prevent-start-transition")
    while (elements.length > 0) {
        elements.item(0)?.classList.remove("prevent-start-transition")
    }
})

startApp()

class ViewerApp implements Component {
    private api: Api

    private sidebar: ViewerSidebar

    private div = document.createElement("div")

    private statsDiv = document.createElement("div")
    private localTouchCursorDiv = document.createElement("div")
    // Prediction cursor: shown only when pointer-locked in rawInput mode.
    // Moves at hardware pointerrawupdate rate (0ms latency), acting as the
    // "leader" cursor while the video cursor lags ~50ms behind.
    private rawPredictionCursorDiv = document.createElement("div")
    private rawPredictionX = -1
    private rawPredictionY = -1
    // Last known OS cursor position BEFORE pointer lock activates.
    // Used to initialize the prediction cursor at the exact same position as the
    // remote cursor, so clicks register at the right place.
    private lastKnownMouseX = 0
    private lastKnownMouseY = 0
    // Global style element to force-hide the OS cursor in rawInput mode.
    private cursorHideStyleEl: HTMLStyleElement | null = null
    // Tracks whether we've asked Sunshine to hide its video cursor (via Ctrl+Alt+Shift+N).
    // Used to avoid sending a redundant second toggle that would re-show the cursor.
    private sunshineHideCursor = false
    private stream: Stream | null = null
    private cachedStreamRect: DOMRect = new DOMRect()

    private inputConfig: StreamInputConfig = defaultStreamInputConfig()
    private previousMouseMode: MouseMode
    private lastPointerRawUpdateMs = 0
    private autoEnterFullscreenOnStart: boolean = false
    private pendingAutoFullscreenPrompt: boolean = false
    private fullscreenPromptShown: boolean = false
    private toggleFullscreenWithKeybind: boolean = false
    private hasShownFullscreenEscapeWarning = false

    constructor(api: Api, hostId: number, appId: number, bootstrapRole: DetailedRole) {
        this.api = api

        const settings = getLocalStreamSettings(bootstrapRole.default_settings)
        Object.assign(this.inputConfig, {
            mouseMode: settings.mouseMode,
            mouseScrollMode: settings.mouseScrollMode,
            touchMode: settings.touchMode,
            localCursorSensitivity: settings.localCursorSensitivity,
            controllerConfig: settings.controllerConfig,
            hideRemoteCursor: settings.hideRemoteCursor
        })

        // Configure sidebar
        this.sidebar = new ViewerSidebar(this)
        setSidebar(this.sidebar)

        // Configure stats element
        this.statsDiv.hidden = true
        this.statsDiv.classList.add("video-stats")
        this.localTouchCursorDiv.hidden = true
        this.localTouchCursorDiv.classList.add("local-touch-cursor")

        // Prediction cursor overlay — must be on document.body (not this.div)
        // so it is never clipped or affected by stacking contexts in fullscreen.
        this.rawPredictionCursorDiv.hidden = true
        this.rawPredictionCursorDiv.classList.add("raw-prediction-cursor")
        document.body.appendChild(this.rawPredictionCursorDiv)

        setInterval(() => {
            // Update stats display every 100ms
            const stats = this.getStream()?.getStats()
            if (stats && stats.isEnabled()) {
                this.statsDiv.hidden = false

                const text = streamStatsToText(stats.getCurrentStats())
                this.statsDiv.innerText = text
            } else {
                this.statsDiv.hidden = true
            }
        }, 100)
        this.div.appendChild(this.statsDiv)
        this.div.appendChild(this.localTouchCursorDiv)
        // rawPredictionCursorDiv is on document.body, not this.div

        // Configure stream
        this.previousMouseMode = this.inputConfig.mouseMode

        const browserWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0)
        const browserHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0)

        this.autoEnterFullscreenOnStart = settings.enterFullscreenOnStreamStart
        this.toggleFullscreenWithKeybind = settings.toggleFullscreenWithKeybind
        this.startStream(hostId, appId, bootstrapRole.permissions, settings, [browserWidth, browserHeight])

        // Configure input
        this.addListeners(document)
        this.addListeners(document.getElementById("input") as HTMLDivElement)

        window.addEventListener("blur", () => {
            this.stream?.getInput().raiseAllKeys()
        })
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "visible") {
                this.stream?.getInput().raiseAllKeys()
            }
        })

        // Cache stream rect to avoid getBoundingClientRect on every mouse move
        const invalidateRect = () => { this.cachedStreamRect = this.computeStreamRect() }
        window.addEventListener("resize", invalidateRect)
        // Also refresh on orientation change (mobile)
        screen.orientation?.addEventListener("change", invalidateRect)

        document.addEventListener("pointerlockchange", this.onPointerLockChange.bind(this))
        document.addEventListener("fullscreenchange", () => {
            this.onFullscreenChange()
            invalidateRect()
        })

        window.addEventListener("gamepadconnected", this.onGamepadConnect.bind(this))
        window.addEventListener("gamepaddisconnected", this.onGamepadDisconnect.bind(this))
        // Connect all gamepads
        for (const gamepad of navigator.getGamepads()) {
            if (gamepad != null) {
                this.onGamepadAdd(gamepad)
            }
        }

        // Mobile keyboard viewport adjustment
        // When the iOS/Android virtual keyboard opens, shrink the video
        // to fit above the keyboard so the user can see what they're typing
        if (window.visualViewport) {
            this.setupKeyboardViewportAdjustment()
        }
    }

    /**
     * Listens to visualViewport changes to detect when the virtual keyboard
     * opens/closes, and adjusts the video stream to fit above the keyboard.
     */
    private setupKeyboardViewportAdjustment() {
        const vv = window.visualViewport!
        const initialHeight = window.innerHeight

        const onViewportResize = () => {
            const screenKeyboard = this.sidebar.getScreenKeyboard()

            // Detect keyboard: viewport significantly shorter than initial window height
            const keyboardThreshold = initialHeight * 0.75
            const isKeyboardOpen = screenKeyboard.isVisible() && vv.height < keyboardThreshold

            if (isKeyboardOpen) {
                // Shrink video to fit in the visible area above the keyboard
                document.documentElement.style.setProperty('--visible-vh', vv.height + 'px')
                document.body.classList.add('keyboard-active')
            } else {
                document.body.classList.remove('keyboard-active')
                document.documentElement.style.removeProperty('--visible-vh')
            }

            // Always prevent scroll offset caused by keyboard focus
            window.scrollTo(0, 0)

            // Invalidate cached stream rect since video size changed
            this.cachedStreamRect = this.computeStreamRect()
        }

        vv.addEventListener('resize', onViewportResize)
        vv.addEventListener('scroll', () => window.scrollTo(0, 0))
    }

    private addListeners(element: GlobalEventHandlers) {
        element.addEventListener("keydown", this.onKeyDown.bind(this), { passive: false })
        element.addEventListener("keyup", this.onKeyUp.bind(this), { passive: false })
        element.addEventListener("paste", this.onPaste.bind(this))

        element.addEventListener("mousedown", this.onMouseButtonDown.bind(this), { passive: false })
        element.addEventListener("mouseup", this.onMouseButtonUp.bind(this), { passive: false })

        element.addEventListener("mousemove", this.onMouseMove.bind(this), { passive: false })
        element.addEventListener("pointermove", this.onPointerMove.bind(this), { passive: false })

        // Raw Input mode prefers pointerrawupdate. Browsers that do not support
        // it simply never fire this event, so pointermove/mousemove remain fallback paths.
        ;(element as any).addEventListener('pointerrawupdate', this.onPointerRawUpdate.bind(this), { passive: false })

        element.addEventListener("wheel", this.onMouseWheel.bind(this), { passive: false })
        element.addEventListener("contextmenu", this.onContextMenu.bind(this), { passive: false })

        element.addEventListener("touchstart", this.onTouchStart.bind(this), { passive: false })
        element.addEventListener("touchend", this.onTouchEnd.bind(this), { passive: false })
        element.addEventListener("touchcancel", this.onTouchCancel.bind(this), { passive: false })
        element.addEventListener("touchmove", this.onTouchMove.bind(this), { passive: false })
    }

    private async startStream(hostId: number, appId: number, permissions: StreamPermissions, settings: Settings, browserSize: [number, number]) {
        setSidebarStyle({
            edge: settings.sidebarEdge,
        })

        this.stream = new Stream(this.api, hostId, appId, settings, browserSize, permissions)

        // Add app info listener
        this.stream.addInfoListener(this.onInfo.bind(this))

        // Create connection info modal
        const connectionInfo = new ConnectionInfoModal()
        const connectionInfoListener = connectionInfo.onInfo.bind(connectionInfo)
        this.stream.addInfoListener(connectionInfoListener)
        void showModal(connectionInfo).then(async () => {
            this.stream?.removeInfoListener(connectionInfoListener)
            if (this.autoEnterFullscreenOnStart && this.pendingAutoFullscreenPrompt && !this.fullscreenPromptShown && !this.isFullscreen()) {
                this.fullscreenPromptShown = true
                this.pendingAutoFullscreenPrompt = false
                await this.promptAutoFullscreen()
            }
        })

        // Start animation frame loop
        this.onTouchUpdate()
        this.onGamepadUpdate()

        this.stream.getInput().addScreenKeyboardVisibleEvent(this.onScreenKeyboardSetVisible.bind(this))

        this.stream.mount(this.div)

        // Initialize cached rect once the video element is rendered
        requestAnimationFrame(() => {
            this.cachedStreamRect = this.computeStreamRect()
        })

        if (this.autoEnterFullscreenOnStart) {
            this.pendingAutoFullscreenPrompt = true
        }
    }

    private async onInfo(event: InfoEvent) {
        const data = event.detail

        if (data.type == "app") {
            const app = data.app

            document.title = `Stream: ${app.title}`
        } else if (data.type == "connectionComplete") {
            this.sidebar.onCapabilitiesChange(data.capabilities)
            this.sendSunshineCursorHide(this.inputConfig.hideRemoteCursor)
        }
    }

    private focusInput() {
        if (this.stream?.getInput().getCurrentPredictedTouchAction() != "screenKeyboard" && !this.sidebar.getScreenKeyboard().isVisible()) {
            const inputElement = document.getElementById("input") as HTMLDivElement
            inputElement.focus()
        }
    }

    onUserInteraction() {
        this.focusInput()

        this.stream?.getVideoRenderer()?.onUserInteraction()
        this.stream?.getAudioPlayer()?.onUserInteraction()
    }
    private onScreenKeyboardSetVisible(event: ScreenKeyboardSetVisibleEvent) {
        console.info(event.detail)
        const screenKeyboard = this.sidebar.getScreenKeyboard()

        const newShown = event.detail.visible
        if (newShown != screenKeyboard.isVisible()) {
            if (newShown) {
                screenKeyboard.show()
            } else {
                screenKeyboard.hide()
            }
        }
    }

    // Input
    getInputConfig(): StreamInputConfig {
        return this.inputConfig
    }
    setInputConfig(config: StreamInputConfig) {
        this.inputConfig = config
        this.stream?.getInput().setConfig(config)
        this.renderLocalTouchCursor()

        this.sendSunshineCursorHide(this.inputConfig.hideRemoteCursor)
        this.updateGlobalCursorHide(this.inputConfig.mouseMode === "rawInput")
    }

    // Keyboard
    onKeyDown(event: KeyboardEvent) {
        this.onUserInteraction()

        // When screen keyboard is visible, let events flow through to the hidden input
        // so InputEvent can be generated for text capture (critical for iOS)
        if (this.sidebar.getScreenKeyboard().isVisible()) {
            return
        }


        if (event.shiftKey && event.ctrlKey && event.code == "KeyV") {
            // We are likely pasting -> don't send keys
        } else if (event.code == "F11") {
            // Allow manual fullscreen
        } else {
            event.preventDefault()
            this.stream?.getInput().onKeyDown(event)
        }

        event.stopPropagation()
    }

    private isTogglingFullscreenWithKeybind: "waitForCtrl" | "makingFullscreen" | "none" = "none"
    onKeyUp(event: KeyboardEvent) {
        this.onUserInteraction()

        // When screen keyboard is visible, let events flow through to the hidden input
        if (this.sidebar.getScreenKeyboard().isVisible()) {
            return
        }

        event.preventDefault()
        this.stream?.getInput().onKeyUp(event)
        event.stopPropagation()

        if (this.toggleFullscreenWithKeybind && this.isTogglingFullscreenWithKeybind == "none" && event.ctrlKey && event.shiftKey && event.code == "KeyI") {
            this.isTogglingFullscreenWithKeybind = "waitForCtrl"
        }
        if (this.isTogglingFullscreenWithKeybind == "waitForCtrl" && (event.code == "ControlRight" || event.code == "ControlLeft")) {
            this.isTogglingFullscreenWithKeybind = "makingFullscreen";

            (async () => {
                if (this.isFullscreen()) {
                    await this.exitPointerLock()
                    await this.exitFullscreen()
                } else {
                    await this.requestFullscreen()
                    await this.requestPointerLock()
                }

                this.isTogglingFullscreenWithKeybind = "none"
            })()
        }
    }

    onPaste(event: ClipboardEvent) {
        this.onUserInteraction()

        this.stream?.getInput().onPaste(event)

        event.stopPropagation()
    }

    // Mouse
    onMouseButtonDown(event: MouseEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream?.getInput().onMouseDown(event, this.getStreamRect());

        event.stopPropagation()
    }
    onMouseButtonUp(event: MouseEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream?.getInput().onMouseUp(event)

        event.stopPropagation()
    }
    onMouseMove(event: MouseEvent) {
        // Always capture real mouse position while not in pointer lock
        if (!document.pointerLockElement) {
            this.lastKnownMouseX = event.clientX
            this.lastKnownMouseY = event.clientY
        }

        if (this.inputConfig.mouseMode == "rawInput" && "PointerEvent" in window) {
            event.preventDefault()
            event.stopPropagation()
            return
        }

        event.preventDefault()
        this.stream?.getInput().onMouseMove(event, this.getStreamRect())

        event.stopPropagation()
    }
    onPointerMove(event: PointerEvent) {
        if (event.pointerType === 'mouse' && !document.pointerLockElement) {
            // Track real cursor position before pointer lock for accurate cursor init
            this.lastKnownMouseX = event.clientX
            this.lastKnownMouseY = event.clientY
        }

        if (this.inputConfig.mouseMode != "rawInput") {
            return
        }
        if (event.pointerType !== 'mouse') {
            return
        }

        event.preventDefault()

        const rawUpdatedRecently = performance.now() - this.lastPointerRawUpdateMs < 100

        // Always update the local prediction cursor from pointermove.
        if (!rawUpdatedRecently) {
            this.updateRawPredictionCursor(event)
            // Send the updated prediction cursor position to the remote
            this.stream?.getInput().onRawPredictionMove(this.rawPredictionX, this.rawPredictionY, this.getStreamRect())
        }

        event.stopPropagation()
    }
    onPointerRawUpdate(event: PointerEvent) {
        if (this.inputConfig.mouseMode != "rawInput") {
            return
        }
        if (event.pointerType !== 'mouse') return
        this.lastPointerRawUpdateMs = performance.now()
        event.preventDefault()

        const rect = this.getStreamRect()
        this.updateRawPredictionCursor(event)
        this.stream?.getInput().onRawPredictionMove(this.rawPredictionX, this.rawPredictionY, rect)

        event.stopPropagation()
    }

    /**
     * Update the prediction cursor position at hardware rate (pointerrawupdate).
     * Only active when pointer lock is on — at that point the OS cursor is hidden
     * and this becomes the primary visual cursor (0ms latency).
     * The video cursor underneath will lag ~50ms but eyes naturally track the
     * local leader cursor, giving a smooth feel identical to Parsec/native clients.
     */
    private updateRawPredictionCursor(event: PointerEvent) {
        if (!document.pointerLockElement) {
            // Pointer lock off → OS cursor is visible, hide prediction cursor
            this.rawPredictionCursorDiv.hidden = true
            // Update coordinates to actual mouse position so we still send
            // correct absolute coordinates to the remote host.
            this.rawPredictionX = event.clientX
            this.rawPredictionY = event.clientY
            return
        }

        // Always use viewport dimensions as the cursor movement bounds.
        // The stream rect from getStreamRect() can return (0,0,0,0) in fullscreen
        // before the video renderer reports its layout — causing the cursor to be
        // clamped to (0,0) and appear frozen.
        const W = window.innerWidth
        const H = window.innerHeight

        if (this.rawPredictionX < 0) {
            this.rawPredictionX = W / 2
            this.rawPredictionY = H / 2
        }
        this.rawPredictionX = Math.max(0, Math.min(W, this.rawPredictionX + event.movementX))
        this.rawPredictionY = Math.max(0, Math.min(H, this.rawPredictionY + event.movementY))

        this.placePredictionCursor(this.rawPredictionX, this.rawPredictionY)
    }

    /** Position and show the prediction cursor div at screen coordinates (x, y). */
    private placePredictionCursor(x: number, y: number) {
        this.rawPredictionCursorDiv.style.left = `${x}px`
        this.rawPredictionCursorDiv.style.top  = `${y}px`
        this.rawPredictionCursorDiv.hidden = false
    }
    private sendPointerMoveEvents(event: PointerEvent) {
        const rect = this.getStreamRect()
        const events = typeof event.getCoalescedEvents == "function" ? event.getCoalescedEvents() : []
        if (events.length == 0) {
            this.stream?.getInput().onMouseMove(event, rect)
            return
        }

        for (const coalescedEvent of events) {
            this.stream?.getInput().onMouseMove(coalescedEvent, rect)
        }
    }
    onMouseWheel(event: WheelEvent) {
        event.preventDefault()
        this.stream?.getInput().onMouseWheel(event)

        event.stopPropagation()
    }
    onContextMenu(event: MouseEvent) {
        event.preventDefault()

        event.stopPropagation()
    }

    // Touch
    onTouchStart(event: TouchEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream?.getInput().onTouchStart(event, this.getStreamRect())

        event.stopPropagation()
    }
    onTouchEnd(event: TouchEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream?.getInput().onTouchEnd(event, this.getStreamRect())

        event.stopPropagation()
    }
    onTouchCancel(event: TouchEvent) {
        this.onUserInteraction()

        event?.preventDefault()
        this.stream?.getInput().onTouchCancel(event, this.getStreamRect())

        event.stopPropagation()
    }
    onTouchUpdate() {
        this.stream?.getInput().onTouchUpdate(this.getStreamRect())
        this.renderLocalTouchCursor()

        window.requestAnimationFrame(this.onTouchUpdate.bind(this))
    }
    onTouchMove(event: TouchEvent) {
        event.preventDefault()
        this.stream?.getInput().onTouchMove(event, this.getStreamRect())

        event.stopPropagation()
    }

    // Gamepad
    onGamepadConnect(event: GamepadEvent) {
        this.onGamepadAdd(event.gamepad)
    }
    onGamepadAdd(gamepad: Gamepad) {
        this.stream?.getInput().onGamepadConnect(gamepad)
    }
    onGamepadDisconnect(event: GamepadEvent) {
        this.stream?.getInput().onGamepadDisconnect(event)
    }
    onGamepadUpdate() {
        this.stream?.getInput().onGamepadUpdate()

        window.requestAnimationFrame(this.onGamepadUpdate.bind(this))
    }

    // Fullscreen
    private async promptAutoFullscreen() {
        await showModal(new AutoFullscreenModal(this.requestFullscreen.bind(this)))
    }
    async requestFullscreen() {
        const target = document.documentElement
        if (target) {
                if (!("requestFullscreen" in target && typeof target.requestFullscreen == "function")) {
                await showMessage(I.stream.fullscreenUnsupported)

                return
            }

            this.focusInput()

            if (!this.isFullscreen()) {
                try {
                    await target.requestFullscreen({
                        navigationUI: "hide"
                    })
                } catch (e) {
                    console.warn("failed to request fullscreen", e)
                }
            }

            if ("keyboard" in navigator && navigator.keyboard && "lock" in navigator.keyboard) {
                await navigator.keyboard.lock()

                if (!this.hasShownFullscreenEscapeWarning) {
                    await showMessage(I.stream.fullscreenEscapeHint)
                }
                this.hasShownFullscreenEscapeWarning = true
            }

            const mouseMode = this.getStream()?.getInput().getConfig().mouseMode
            if (mouseMode == "relative" || mouseMode == "rawInput") {
                await this.requestPointerLock()
            }

            try {
                if (screen && "orientation" in screen) {
                    const orientation = screen.orientation

                    if ("lock" in orientation && typeof orientation.lock == "function") {
                        await orientation.lock("landscape")
                    }
                }
            } catch (e) {
                console.warn("failed to set orientation to landscape", e)
            }
        } else {
            console.warn("root element not found")
        }
    }
    async exitFullscreen() {
        if ("keyboard" in navigator && navigator.keyboard && "unlock" in navigator.keyboard) {
            await navigator.keyboard.unlock()
        }

        if ("exitFullscreen" in document && typeof document.exitFullscreen == "function") {
            await document.exitFullscreen()
        }
    }
    isFullscreen(): boolean {
        return "fullscreenElement" in document && !!document.fullscreenElement
    }
    private async onFullscreenChange() {
        this.checkFullyImmersed()
    }

    // Pointer Lock
    async requestPointerLock(errorIfNotFound: boolean = false, mouseMode?: MouseMode) {
        this.previousMouseMode = this.inputConfig.mouseMode
        const lockMouseMode = mouseMode ?? (this.inputConfig.mouseMode == "rawInput" ? "rawInput" : "relative")

        const inputElement = document.getElementById("input") as HTMLDivElement

        if (inputElement && "requestPointerLock" in inputElement && typeof inputElement.requestPointerLock == "function") {
            this.focusInput()

            this.inputConfig.mouseMode = lockMouseMode
            this.setInputConfig(this.inputConfig)

            setSidebarExtended(false)

            const onLockError = () => {
                document.removeEventListener("pointerlockerror", onLockError)

                // Fallback: try to request pointer lock without options
                inputElement.requestPointerLock()
            }

            document.addEventListener("pointerlockerror", onLockError, { once: true })

            try {
                let promise = lockMouseMode == "rawInput"
                    ? inputElement.requestPointerLock({ unadjustedMovement: true })
                    : inputElement.requestPointerLock()

                if (promise) {
                    await promise
                } else {
                    inputElement.requestPointerLock()
                }
            } catch (error) {
                // Some platforms do not support unadjusted movement. If you
                // would like PointerLock anyway, request again.
                if (error instanceof Error && error.name == "NotSupportedError") {
                    inputElement.requestPointerLock()
                } else {
                    throw error
                }
            } finally {
                document.removeEventListener("pointerlockerror", onLockError)
            }

        } else if (errorIfNotFound) {
            await showMessage(I.stream.pointerLockUnsupported)
        }
    }
    async exitPointerLock() {
        if ("exitPointerLock" in document && typeof document.exitPointerLock == "function") {
            document.exitPointerLock()
        }
    }
    private onPointerLockChange() {
        this.checkFullyImmersed()

        const isRawInput = this.inputConfig.mouseMode === "rawInput" ||
            this.previousMouseMode === "rawInput"

        if (!document.pointerLockElement) {
            this.inputConfig.mouseMode = this.previousMouseMode
            this.setInputConfig(this.inputConfig)
            // Hide prediction cursor and reset its position when lock is released
            this.rawPredictionCursorDiv.hidden = true
            this.rawPredictionX = -1
            this.rawPredictionY = -1

            // Restore cursor in video when exiting rawInput
            if (isRawInput) {
                this.sendSunshineCursorHide(false)
            }
        } else {
            // Hide cursor in video when entering rawInput pointer lock
            if (this.inputConfig.mouseMode === "rawInput") {
                // Initialize the local prediction cursor at the center of the viewport.
                // We MUST use the exact center and immediately send this absolute position
                // to the remote host. This forces the remote OS cursor to teleport to the
                // exact same position as our local prediction cursor, guaranteeing 100% sync.
                // Using lastKnownMouseX is dangerous because window.innerWidth changes during fullscreen transition.
                const startX = window.innerWidth  / 2
                const startY = window.innerHeight / 2
                this.rawPredictionX = startX
                this.rawPredictionY = startY
                this.placePredictionCursor(startX, startY)
                
                // Immediately synchronize the remote cursor to the new starting position
                this.stream?.getInput().onRawPredictionMove(startX, startY, this.getStreamRect())
            }
        }

        // Re-evaluate cursor hide whenever lock state changes.
        this.updateGlobalCursorHide(this.inputConfig.mouseMode === "rawInput")
    }

    /**
     * Toggle Sunshine's cursor-in-video rendering by sending the Ctrl+Alt+Shift+N shortcut.
     *
     * Sunshine tracks modifier state via ACTUAL key press events (VK_LCONTROL, VK_LMENU, VK_LSHIFT).
     * It checks: shortcutFlags == SHORTCUT (CTRL|ALT|SHIFT) && keyCode == N → toggle display_cursor.
     *
     * We MUST send the modifier keys as real key events, NOT just as a modifier bitmask.
     *
     * @param hide true = hide cursor from video, false = restore cursor in video
     */
    private sendSunshineCursorHide(hide: boolean) {
        // Idempotent: don't send if already in the desired state
        if (hide === this.sunshineHideCursor) return

        const input = this.stream?.getInput()
        if (!input) return

        const CTRL_MOD  = StreamKeyModifiers.MASK_CTRL
        const CA_MOD    = StreamKeyModifiers.MASK_CTRL | StreamKeyModifiers.MASK_ALT
        const CAS_MOD   = StreamKeyModifiers.MASK_CTRL | StreamKeyModifiers.MASK_ALT | StreamKeyModifiers.MASK_SHIFT

        // 1. Press Ctrl → Sunshine: shortcutFlags |= CTRL
        input.sendKey(true,  StreamKeys.VK_LCONTROL, 0)
        // 2. Press Alt  → Sunshine: shortcutFlags |= ALT
        input.sendKey(true,  StreamKeys.VK_LMENU, CTRL_MOD)
        // 3. Press Shift → Sunshine: shortcutFlags |= SHIFT → shortcutFlags == SHORTCUT now
        input.sendKey(true,  StreamKeys.VK_LSHIFT, CA_MOD)
        // 4. Press N → Sunshine: shortcutFlags == SHORTCUT → apply_shortcut(N) → toggles display_cursor
        input.sendKey(true,  StreamKeys.VK_KEY_N, CAS_MOD)
        input.sendKey(false, StreamKeys.VK_KEY_N, CAS_MOD)
        // 5. Release all modifiers
        input.sendKey(false, StreamKeys.VK_LSHIFT,   CA_MOD)
        input.sendKey(false, StreamKeys.VK_LMENU,    CTRL_MOD)
        input.sendKey(false, StreamKeys.VK_LCONTROL, 0)

        this.sunshineHideCursor = hide
    }

    // -- Fully immersed Fullscreen -> Fullscreen API + Pointer Lock
    private checkFullyImmersed() {
        if ("pointerLockElement" in document && document.pointerLockElement &&
            "fullscreenElement" in document && document.fullscreenElement) {
            // We're fully immersed -> remove sidebar
            setSidebar(null)
        } else {
            setSidebar(this.sidebar)
        }
    }
    /**
     * Inject or remove a global CSS rule `* { cursor: none !important }`.
     *
     * We only hide the cursor when ALL conditions are met:
     * 1. rawInput mode is active
     * 2. Pointer lock is active (browser already hides cursor in pointer lock,
     *    but we inject the rule so the video cursor is the only one visible)
     *
     * When pointer lock is NOT active (sidebar open, menu, settings), the user
     * needs to see the OS cursor to interact with the UI — so we always show it.
     */
    private updateGlobalCursorHide(rawInputActive: boolean) {
        const shouldHide = rawInputActive && !!document.pointerLockElement
        if (shouldHide) {
            if (!this.cursorHideStyleEl) {
                this.cursorHideStyleEl = document.createElement("style")
                this.cursorHideStyleEl.id = "raw-input-cursor-hide"
                this.cursorHideStyleEl.textContent = "* { cursor: none !important; }"
                document.head.appendChild(this.cursorHideStyleEl)
            }
        } else {
            if (this.cursorHideStyleEl) {
                this.cursorHideStyleEl.remove()
                this.cursorHideStyleEl = null
            }
        }
    }

    private renderLocalTouchCursor() {
        const localCursorState = this.stream?.getInput().getLocalCursorState()
        if (!localCursorState?.visible) {
            this.localTouchCursorDiv.hidden = true
            return
        }

        const rect = this.getStreamRect()
        if (rect.width <= 0 || rect.height <= 0) {
            this.localTouchCursorDiv.hidden = true
            return
        }

        this.localTouchCursorDiv.hidden = false
        this.localTouchCursorDiv.style.left = `${rect.left + localCursorState.x * rect.width}px`
        this.localTouchCursorDiv.style.top = `${rect.top + localCursorState.y * rect.height}px`
    }


    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
        // Clean up global DOM elements added outside this.div
        this.rawPredictionCursorDiv.remove()
        this.updateGlobalCursorHide(false)
        // Restore cursor visibility on remote PC if we hid it
        if (this.sunshineHideCursor) {
            this.sendSunshineCursorHide(false)
        }
    }

    getStreamRect(): DOMRect {
        // Use cached rect if valid, otherwise compute live and update cache
        if (this.cachedStreamRect.width > 0 && this.cachedStreamRect.height > 0) {
            return this.cachedStreamRect
        }
        this.cachedStreamRect = this.computeStreamRect()
        return this.cachedStreamRect
    }
    private computeStreamRect(): DOMRect {
        // The bounding rect of the videoElement or canvasElement can be bigger than the actual video
        // -> We need to correct for this when sending positions, else positions are wrong
        return this.stream?.getVideoRenderer()?.getStreamRect() ?? new DOMRect()
    }
    getStream(): Stream | null {
        return this.stream
    }
}

class ConnectionInfoModal implements Modal<void> {

    private eventTarget = new EventTarget()

    private root = document.createElement("div")

    private textTy: LogMessageType | null = null
    private text = document.createElement("p")

    private options = document.createElement("div")
    private debugDetailButton = document.createElement("button")
    private closeButton = document.createElement("button")

    private debugDetail = "" // We store this seperate because line breaks don't work when the element is not mounted on the dom
    private debugDetailDisplay = document.createElement("div")

    constructor() {
        this.root.classList.add("modal-video-connect")

        this.text.innerText = I.stream.connecting
        this.root.appendChild(this.text)

        this.root.appendChild(this.options)
        this.options.classList.add("modal-video-connect-options")

        this.debugDetailButton.innerText = I.stream.showLogs
        this.debugDetailButton.addEventListener("click", this.onDebugDetailClick.bind(this))
        this.options.appendChild(this.debugDetailButton)

        this.closeButton.innerText = I.stream.close
        this.closeButton.addEventListener("click", this.onClose.bind(this))
        this.options.appendChild(this.closeButton)

        this.debugDetailDisplay.classList.add("textlike")
        this.debugDetailDisplay.classList.add("modal-video-connect-debug")
    }

    private onDebugDetailClick() {
        let debugDetailCurrentlyShown = this.root.contains(this.debugDetailDisplay)

        if (debugDetailCurrentlyShown) {
            this.debugDetailButton.innerText = I.stream.showLogs
            this.root.removeChild(this.debugDetailDisplay)
        } else {
            this.debugDetailButton.innerText = I.stream.hideLogs
            this.root.appendChild(this.debugDetailDisplay)
            this.debugDetailDisplay.innerText = this.debugDetail
        }
    }

    private debugLog(line: string) {
        this.debugDetail += `${line}\n`
        this.debugDetailDisplay.innerText = this.debugDetail
        console.info(`[Stream]: ${line}`)
    }

    onInfo(event: InfoEvent) {
        const data = event.detail

        if (data.type == "connectionComplete") {
            const text = I.stream.connectionComplete
            this.text.innerText = text
            this.debugLog(text)

            this.eventTarget.dispatchEvent(new Event("ml-connected"))
        } else if (data.type == "addDebugLine") {
            const message = data.line.trim()
            if (message) {
                this.debugLog(message)

                if (!this.textTy) {
                    this.text.innerText = message
                    this.textTy = data.additional?.type ?? null
                } else if (data.additional?.type == "fatalDescription" || data.additional?.type == "ifErrorDescription") {
                    if (this.text.innerText) {
                        this.text.innerText += "\n" + message
                    } else {
                        this.text.innerText = message
                    }
                    this.textTy = data.additional.type
                }
            }

            if (data.additional?.type == "fatal" || data.additional?.type == "fatalDescription") {
                showModal(this)
            } else if (data.additional?.type == "recover") {
                showModal(null)
            } else if (data.additional?.type == "informError") {
                showErrorPopup(data.line)
            }
        } else if (data.type == "serverMessage") {
            const text = I.stream.serverMessage(data.message)
            this.text.innerText = text
            this.debugLog(text)
        }
    }

    onClose() {
        showModal(null)
    }

    onFinish(abort: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            this.eventTarget.addEventListener("ml-connected", () => resolve(), { once: true, signal: abort })
        })
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.root)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.root)
    }
}

class AutoFullscreenModal implements Component, Modal<void> {
    private message = document.createElement("p")
    private root = document.createElement("div")
    private okButton = document.createElement("button")
    private cancelButton = document.createElement("button")
    private onConfirm: () => Promise<void>

    constructor(onConfirm: () => Promise<void>) {
        this.onConfirm = onConfirm
        this.message.innerText = I.stream.autoFullscreenPrompt
        this.okButton.innerText = I.modal.ok
        this.cancelButton.innerText = I.modal.cancel
    }

    mount(parent: HTMLElement): void {
        this.root.appendChild(this.message)
        this.root.appendChild(this.okButton)
        this.root.appendChild(this.cancelButton)
        parent.appendChild(this.root)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.root)
    }

    onFinish(abort: AbortSignal): Promise<void> {
        return new Promise((resolve) => {
            this.okButton.addEventListener("click", async () => {
                await this.onConfirm()
                resolve()
            }, { once: true, signal: abort })

            this.cancelButton.addEventListener("click", () => {
                resolve()
            }, { once: true, signal: abort })
        })
    }
}

class ViewerSidebar implements Component, Sidebar {
    private app: ViewerApp

    private div = document.createElement("div")

    private buttonDiv = document.createElement("div")

    private sendKeycodeButton = document.createElement("button")

    private keyboardButton = document.createElement("button")
    private screenKeyboard = new ScreenKeyboard()

    private lockMouseButton = document.createElement("button")
    private fullscreenButton = document.createElement("button")

    private statsButton = document.createElement("button")
    private exitStreamButton = document.createElement("button")

    private mouseMode: SelectComponent
    private touchMode: SelectComponent
    private hideRemoteCursor: InputComponent

    constructor(app: ViewerApp) {
        this.app = app

        // Configure divs
        this.div.classList.add("sidebar-stream")

        this.buttonDiv.classList.add("sidebar-stream-buttons")
        this.div.appendChild(this.buttonDiv)

        // Send keycode
        this.sendKeycodeButton.innerText = I.stream.sendKeycode
        this.sendKeycodeButton.addEventListener("click", async () => {
            const key = await showModal(new SendKeycodeModal())

            if (key == null) {
                return
            }

            this.app.getStream()?.getInput().sendKey(true, key, 0)
            this.app.getStream()?.getInput().sendKey(false, key, 0)
        })
        this.buttonDiv.appendChild(this.sendKeycodeButton)

        // Pointer Lock
        this.lockMouseButton.innerText = I.stream.lockMouse
        this.lockMouseButton.addEventListener("click", async () => {
            const mouseMode = this.mouseMode.getValue() as MouseMode
            await this.app.requestPointerLock(true, mouseMode == "rawInput" ? "rawInput" : "relative")
        })
        this.buttonDiv.appendChild(this.lockMouseButton)

        // Pop up keyboard
        this.keyboardButton.innerText = I.stream.keyboard
        this.keyboardButton.addEventListener("click", async () => {
            setSidebarExtended(false)
            this.screenKeyboard.show()
        })
        this.buttonDiv.appendChild(this.keyboardButton)

        this.screenKeyboard.addKeyDownListener(this.onKeyDown.bind(this))
        this.screenKeyboard.addKeyUpListener(this.onKeyUp.bind(this))
        this.screenKeyboard.addTextListener(this.onText.bind(this))
        this.div.appendChild(this.screenKeyboard.getHiddenElement())


        // Fullscreen
        this.fullscreenButton.innerText = I.stream.fullscreen
        this.fullscreenButton.addEventListener("click", async () => {
            if (this.app.isFullscreen()) {
                await this.app.exitFullscreen()
            } else {
                await this.app.requestFullscreen()
            }
        })
        this.buttonDiv.appendChild(this.fullscreenButton)

        // Stats
        this.statsButton.innerText = I.stream.stats
        this.statsButton.addEventListener("click", () => {
            const stats = this.app.getStream()?.getStats()
            if (stats) {
                stats.toggle()
            }
        })
        this.buttonDiv.appendChild(this.statsButton)

        // Close stream
        this.exitStreamButton.innerText = I.stream.exit
        this.exitStreamButton.addEventListener("click", async () => {
            const stream = this.app.getStream()
            if (stream) {
                const success = await stream.stop()
                if (!success) {
                    console.debug("Failed to close stream correctly")
                }
            }

            if (window.matchMedia('(display-mode: standalone)').matches) {
                history.back()
            } else {
                window.close()
            }

        })
        this.buttonDiv.appendChild(this.exitStreamButton)

        // Select Mouse Mode
        this.mouseMode = new SelectComponent("mouseMode", [
            { value: "relative", name: I.stream.relative },
            { value: "rawInput", name: I.stream.rawInput },
            { value: "follow", name: I.stream.follow },
            { value: "localCursor", name: I.stream.localCursor },
            { value: "pointAndDrag", name: I.stream.pointAndDrag }
        ], {
            displayName: I.stream.mouseMode,
            preSelectedOption: this.app.getInputConfig().mouseMode
        })
        this.mouseMode.addChangeListener(this.onMouseModeChange.bind(this))
        this.mouseMode.mount(this.div)

        // Select Touch Mode
        this.touchMode = new SelectComponent("touchMode", [
            { value: "touch", name: I.stream.touch },
            { value: "mouseRelative", name: I.stream.relative },
            { value: "localCursor", name: I.stream.localCursor },
            { value: "pointAndDrag", name: I.stream.pointAndDrag }
        ], {
            displayName: I.stream.touchMode,
            preSelectedOption: this.app.getInputConfig().touchMode
        })
        this.touchMode.addChangeListener(this.onTouchModeChange.bind(this))
        this.touchMode.mount(this.div)

        // Hide Remote Cursor Toggle
        this.hideRemoteCursor = new InputComponent("hideRemoteCursor", "checkbox", I.settings.hideRemoteCursor, {
            checked: this.app.getInputConfig().hideRemoteCursor
        })
        this.hideRemoteCursor.addChangeListener(this.onHideRemoteCursorChange.bind(this))
        this.hideRemoteCursor.mount(this.div)
    }

    private onHideRemoteCursorChange() {
        const config = this.app.getInputConfig()
        config.hideRemoteCursor = this.hideRemoteCursor.isChecked()
        this.app.setInputConfig(config)
    }

    onCapabilitiesChange(capabilities: StreamCapabilities) {
        this.touchMode.setOptionEnabled("touch", capabilities.touch)
    }

    getScreenKeyboard(): ScreenKeyboard {
        return this.screenKeyboard
    }

    // -- Keyboard
    private onText(event: TextEvent) {
        this.app.getStream()?.getInput().sendText(event.detail.text)
    }
    private onKeyDown(event: KeyboardEvent) {
        this.app.getStream()?.getInput().onKeyDown(event)
    }
    private onKeyUp(event: KeyboardEvent) {
        this.app.getStream()?.getInput().onKeyUp(event)
    }

    // -- Mouse Mode
    private async onMouseModeChange() {
        const config = this.app.getInputConfig()
        const mouseMode = this.mouseMode.getValue() as MouseMode
        config.mouseMode = mouseMode
        this.app.setInputConfig(config)

        if (document.pointerLockElement && (mouseMode == "relative" || mouseMode == "rawInput")) {
            await this.app.requestPointerLock(true, mouseMode)
        }
    }

    // -- Touch Mode
    private onTouchModeChange() {
        const config = this.app.getInputConfig()
        config.touchMode = this.touchMode.getValue() as any
        this.app.setInputConfig(config)
    }

    extended(): void {

    }
    unextend(): void {

    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
    }
}

class SendKeycodeModal extends FormModal<number> {

    private dropdownSearch: SelectComponent

    constructor() {
        super()

        const keyList = []
        for (const keyNameRaw in StreamKeys) {
            const keyName = keyNameRaw as keyof typeof StreamKeys
            const keyValue = StreamKeys[keyName]

            const PREFIX = "VK_"

            let name: string = keyName
            if (name.startsWith(PREFIX)) {
                name = name.slice(PREFIX.length)
            }

            keyList.push({
                value: keyValue.toString(),
                name
            })
        }

        this.dropdownSearch = new SelectComponent("winKeycode", keyList, {
            hasSearch: true,
            displayName: I.stream.selectKeycode
        })
    }

    mountForm(form: HTMLFormElement): void {
        this.dropdownSearch.mount(form)
    }


    reset(): void {
        this.dropdownSearch.reset()
    }

    submit(): number | null {
        const keyString = this.dropdownSearch.getValue()
        if (keyString == null) {
            return null
        }

        return parseInt(keyString)
    }
}

// Stop propagation so the stream doesn't get it
function stopPropagationOn(element: HTMLElement) {
    element.addEventListener("keydown", onStopPropagation)
    element.addEventListener("keyup", onStopPropagation)
    element.addEventListener("keypress", onStopPropagation)
    element.addEventListener("click", onStopPropagation)
    element.addEventListener("mousedown", onStopPropagation)
    element.addEventListener("mouseup", onStopPropagation)
    element.addEventListener("mousemove", onStopPropagation)
    element.addEventListener("wheel", onStopPropagation)
    element.addEventListener("contextmenu", onStopPropagation)
    element.addEventListener("touchstart", onStopPropagation)
    element.addEventListener("touchmove", onStopPropagation)
    element.addEventListener("touchend", onStopPropagation)
    element.addEventListener("touchcancel", onStopPropagation)
}
function onStopPropagation(event: Event) {
    event.stopPropagation()
}
